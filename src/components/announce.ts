// Game announcements sent through the chat relay (a catch, a snapped line):
// plain chat text starting with ANNOUNCE_PREFIX. Every client shows them as a
// notice line in the chat panel ("🎣 Tuấn câu được Cá thu 3,2 kg!") instead of
// a speech bubble over the player.

/** Fishing news (scene/fishingGame.ts). */
export const ANNOUNCE_PREFIX = '🎣 ';

export function isAnnouncement(text: string): boolean {
  return text.startsWith(ANNOUNCE_PREFIX);
}

/** "🎣 Câu được Cá thu 3,2 kg!" from `name` → "🎣 Tuấn câu được Cá thu 3,2 kg!" */
export function announcementLine(name: string, text: string): string {
  const rest = text.slice(ANNOUNCE_PREFIX.length).trim();
  const lower = rest.charAt(0).toLocaleLowerCase('vi') + rest.slice(1);
  return `${ANNOUNCE_PREFIX}${name} ${lower}`;
}
