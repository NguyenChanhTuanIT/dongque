// Verify Firebase Auth ID tokens without firebase-admin: RS256 signature
// against Google's published JWKS, then the claims Firebase documents
// (aud, iss, exp, iat, auth_time, sub). Only node:crypto + global fetch.
//   https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library

import crypto from 'node:crypto';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
/** Minimum delay between JWKS refetches triggered by an unknown key id. */
const REFETCH_MIN_MS = 60_000;
const CLOCK_SKEW_S = 60;

/**
 * @param {string} projectId Firebase project id (the token audience).
 * @returns {(token: string) => Promise<{ uid: string, provider: string }>}
 */
export function createTokenVerifier(projectId) {
  /** @type {Map<string, crypto.KeyObject>} */
  let keys = new Map();
  let expiresAt = 0;
  let lastFetch = 0;
  /** @type {Promise<void> | null} */
  let inflight = null;

  async function refresh() {
    lastFetch = Date.now();
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    const body = await res.json();
    const next = new Map();
    for (const jwk of body.keys ?? []) {
      if (jwk.kid && jwk.kty === 'RSA') next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    keys = next;
    const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
    expiresAt = Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : 3_600_000);
  }

  async function keyFor(kid) {
    const stale = Date.now() >= expiresAt;
    const unknown = !keys.has(kid) && Date.now() - lastFetch >= REFETCH_MIN_MS;
    if (stale || unknown) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    const key = keys.get(kid);
    if (!key) throw new Error('unknown key id');
    return key;
  }

  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

  return async function verify(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('bad header');
    const key = await keyFor(header.kid);
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!ok) throw new Error('bad signature');
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== projectId) throw new Error('bad audience');
    if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('bad issuer');
    if (typeof claims.exp !== 'number' || claims.exp <= now - CLOCK_SKEW_S) throw new Error('expired');
    if (typeof claims.iat !== 'number' || claims.iat > now + CLOCK_SKEW_S) throw new Error('issued in the future');
    if (typeof claims.auth_time !== 'number' || claims.auth_time > now + CLOCK_SKEW_S) throw new Error('bad auth_time');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new Error('bad subject');
    return { uid: claims.sub, provider: claims.firebase?.sign_in_provider ?? '' };
  };
}
