// Which IP a request comes from, for the per-IP limits (connections, chat,
// online rewards, feedback) and the kick / ban IP blocks.
//
// X-Forwarded-For is a list the client can start itself: a proxy that only
// appends (Render does) leaves a forged first entry in place, so trusting
// the first entry lets anyone pick their IP and dodge every per-IP limit.
// Configure one of:
//   CLIENT_IP_HEADER  a header the edge proxy *overwrites* with the client IP
//                     (e.g. "cf-connecting-ip" / "true-client-ip" when it is
//                     really set by Cloudflare). Never a header the client can
//                     send through untouched.
//   TRUST_PROXY       number of proxies in front of the server that append to
//                     X-Forwarded-For (e.g. 1): the client IP is that many
//                     entries from the right. 0 = use the socket address.
// Neither set: the legacy behaviour (first X-Forwarded-For entry, spoofable),
// with a warning at startup.

/**
 * @param {{ header?: string, trustProxy?: number | null, log?: (msg: string) => void }} [options]
 * @returns {(req: import('node:http').IncomingMessage) => string}
 */
export function createClientIp({ header = '', trustProxy = null, debug = false, log = (msg) => console.warn(`[server] ${msg}`) } = {}) {
  const resolve = pickClientIp({ header, trustProxy, log });
  if (!debug) return resolve;
  // LOG_CLIENT_IP=1: print what the proxy sent and the IP chosen, to find the
  // right TRUST_PROXY. Turn it off afterwards (it logs every connection).
  return (req) => {
    const ip = resolve(req);
    console.log(`[client-ip] x-forwarded-for="${req.headers['x-forwarded-for'] ?? ''}" socket=${req.socket.remoteAddress} → ${ip}`);
    return ip;
  };
}

function pickClientIp({ header, trustProxy, log }) {
  const name = header.trim().toLowerCase();
  const socketIp = (req) => req.socket.remoteAddress || 'unknown';
  if (name) {
    return (req) => String(req.headers[name] ?? '').split(',')[0].trim() || socketIp(req);
  }
  if (trustProxy !== null && Number.isInteger(trustProxy) && trustProxy >= 0) {
    return (req) => {
      if (trustProxy === 0) return socketIp(req);
      const list = String(req.headers['x-forwarded-for'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // The entry added by the outermost trusted proxy; anything left of it is client-written.
      return list[list.length - trustProxy] || socketIp(req);
    };
  }
  log('CLIENT_IP_HEADER / TRUST_PROXY not set: the client IP is the first X-Forwarded-For entry, which clients can forge (per-IP limits and IP bans can be dodged).');
  return (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || socketIp(req);
}

/** TRUST_PROXY from the environment: a whole number, or null when unset / invalid. */
export function parseTrustProxy(value) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
