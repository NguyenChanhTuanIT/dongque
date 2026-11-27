// Profanity filter for chat (and names): matched words are replaced by '*'
// (one per character), the rest of the line is kept.
//
// Two lists, because Vietnamese without tone marks collides with everyday
// words ("lồn" → "lon" ~ "lớn", "cặc" → "cac" ~ "các", "đụ" → "du" ~ "du lịch"):
//   ACCENTED  compared with tone marks (only lower-cased): the word as written.
//   PLAIN     compared without accents, đ = d, with leetspeak (0→o, 1→i, 3→e,
//             4→a, 5→s, @→a, $→s): abbreviations / words that mean nothing else.
// Both tolerate repeated letters ("đmmmm", "fuuuck") and one separator between
// letters ("đ.m", "f-u-c-k", "v c l"). A trailing '*' also matches any ending
// ("fuck*" → fucking, fucker). Matches are whole words only (no letter or digit
// right before / after), so "edit" or "class" are left alone.
// Add words to the lists below (lower case; ACCENTED with its tone marks).

const ACCENTED = [
  'lồn', 'lìn', 'cặc', 'buồi', 'địt', 'đụ', 'đụ má', 'đụ mẹ', 'đéo', 'đĩ', 'điếm', 'dái', 'vãi lồn', 'vãi cặc',
  'óc chó', 'chó đẻ', 'mẹ kiếp', 'bú cu', 'bú cặc', 'nứng',
];
const PLAIN = [
  // Vietnamese abbreviations and unaccented forms that are not other words
  'dm', 'dmm', 'dcm', 'dkm', 'dmcs', 'dcmm', 'dkmm', 'cmm', 'cmn', 'clm', 'clgt', 'vcl', 'vkl', 'vcc', 'vl', 'vcd',
  // ("dit", "du ma" are left out: "đít", "dù mà" without accents)
  'dit me', 'dit cu', 'ditme', 'ditmemay', 'loz', 'lozz', 'cak', 'kak',
  // English
  'fuck*', 'fck', 'fuk', 'wtf', 'shit*', 'bitch*', 'cunt*', 'dick', 'dickhead', 'pussy', 'asshole*', 'bastard*',
  'motherfuck*', 'nigga*', 'nigger*', 'whore*', 'slut*',
];

/** Between two letters: punctuation, or also a space in words of 4+ letters ("f u c k", not "D M"). */
const SEPARATOR = '[._*\\-]?';
const SEPARATOR_LONG = '[\\s._*\\-]?';
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const MARKS = /[̀-ͯ]/g;

/** Cyrillic / Greek letters drawn like Latin ones ("Аdmin" with a Cyrillic А). */
const CONFUSABLES = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ɡ: 'g', ı: 'i',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};

/**
 * Compare form of a string: compatibility forms unfolded (fullwidth ｆ, bold 𝐟
 * → f), accents removed, đ = d, lower case, look-alike letters → Latin.
 */
export function foldText(text) {
  return [...text.normalize('NFKD').replace(MARKS, '').replace(/đ/gi, 'd').toLowerCase()].map((c) => CONFUSABLES[c] ?? c).join('');
}

/** Lower case, tone marks kept. */
const keepAccents = (c) => c.toLocaleLowerCase('vi');
/** Lower case, no accents, đ = d, look-alikes and leetspeak letters. */
const plain = (c) => LEET[c] ?? foldText(c);

/** Word list → one regex over the normalised text (`fold` = how the text was normalised). */
function compile(words, fold) {
  const alternatives = words.map((word) => {
    const open = word.endsWith('*');
    const letters = [...(open ? word.slice(0, -1) : word)].map(fold).join('');
    const sep = letters.replace(/\s/g, '').length >= 4 && !letters.includes(' ') ? SEPARATOR_LONG : SEPARATOR;
    let body = '';
    for (const ch of letters) {
      if (ch === ' ') body += '[\\s._*\\-]*';
      else body += (body && !body.endsWith('*') ? sep : '') + ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '+';
    }
    return body + (open ? '[\\p{L}\\p{N}]*' : '');
  });
  // Longest first, so "dmm" wins over "dm".
  alternatives.sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

const PASSES = [
  { fold: keepAccents, re: compile(ACCENTED, keepAccents) },
  { fold: plain, re: compile(PLAIN, plain) },
];

/** Code-point ranges [from, to) of `chars` that are profane. */
function ranges(chars) {
  const out = [];
  for (const { fold, re } of PASSES) {
    // Normalised text + where each of its characters came from in `chars`.
    let text = '';
    const from = [];
    chars.forEach((c, i) => {
      for (const ch of fold(c)) {
        text += ch;
        from.push(i);
      }
    });
    // `from` is per UTF-16 unit of `text`, matched below with string indices.
    const index = [];
    for (let i = 0, k = 0; i < text.length; k++) {
      const cp = text.codePointAt(i) ?? 0;
      const units = cp > 0xffff ? 2 : 1;
      for (let u = 0; u < units; u++) index.push(from[k]);
      i += units;
    }
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      out.push([index[m.index], index[m.index + m[0].length - 1] + 1]);
    }
  }
  return out;
}

/** `text` with every profane word replaced by '*' (same length). */
export function maskProfanity(text) {
  const chars = [...text];
  const found = ranges(chars);
  if (!found.length) return text;
  for (const [a, b] of found) for (let i = a; i < b; i++) if (!/\s/u.test(chars[i])) chars[i] = '*';
  return chars.join('');
}

/** Whether `text` contains a profane word (names are refused instead of masked). */
export function hasProfanity(text) {
  return ranges([...text]).length > 0;
}
