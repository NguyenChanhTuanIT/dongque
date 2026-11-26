// Multiplayer over our own WebSocket relay (server/realm.mjs): the engine
// reads `_clients` and mutates `_data`.
//
// Server messages: 1 WELCOME [u32 id] · 2 STATES [u16 n]{[u32 id][26 B]} ·
// 3 LEAVE [u32 id] · 4 OUTFIT · 5 NAME [u32 id][u8 n][name] · 6 CHAT [u32 id][text]
// · 7 NOTICE [u8 code]. Close codes 4001 (kicked) / 4003 (banned) stop reconnecting.
// Client → server: one 26-byte state frame, or
// [2] OUTFIT · [3] PROFILE [u16 n][ID token][u8 m][name] · [4] CHAT [text]
// · [5] REWARD · [6] VISIBLE · [7] SHOP [JSON]. An OUTFIT with our own id is the
// relay correcting / restoring our outfit (shop ownership, account outfit).

import { STATE_BYTES, decodeState, encodeState } from './codec';
import type { ConnectionOptions, MultiplayerConnection, P2PClientData, P2PData } from './types';

const MSG_WELCOME = 1;
const MSG_STATES = 2;
const MSG_LEAVE = 3;
const MSG_OUTFIT = 4; // server → client: [4][u32 id][u8 n][n bytes]
const MSG_NAME = 5;
const MSG_CHAT = 6;
const MSG_NOTICE = 7;
const MSG_WALLET = 8;
const CLIENT_OUTFIT = 2; // client → server: [2][u8 n][n bytes]
const CLIENT_PROFILE = 3;
const CLIENT_CHAT = 4;
const CLIENT_REWARD = 5;
const CLIENT_VISIBLE = 6;
const CLIENT_SHOP = 7;
/** REWARD actions (server/realm.mjs): 2 + i claims online tier i. */
export const REWARD_STATUS = 0;
export const REWARD_CHECKIN = 1;
export const REWARD_ONLINE = 2;
/** Mirrors server/realm.mjs. */
export const CHAT_MAX_CHARS = 160;
export const NAME_MIN_CHARS = 2;
export const NAME_MAX_CHARS = 20;
export const NOTICE_AUTH_FAILED = 1;
export const NOTICE_BAD_NAME = 2;
export const NOTICE_LOGIN_UNAVAILABLE = 3;
export const NOTICE_CHAT_TOO_FAST = 4;
export const NOTICE_BANNED = 5;
/** WebSocket close codes the relay uses for admin actions (no automatic reconnect). */
export const CLOSE_KICKED = 4001;
export const CLOSE_BANNED = 4003;
const MAX_OUTFIT_SLOTS = 16;
/** Full-state heartbeat while idle, so the server keeps relaying us. */
const HEARTBEAT_MS = 2_000;
/** While the tab is hidden, keep presence alive at a slow rate. */
const HIDDEN_RATE_MS = 1_000;
/** Drop remotes we have not heard from (left view range, stale). */
const REMOTE_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

const noop = () => {};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An account-verified display name: the relay checks the token before accepting it. */
export interface Profile {
  name: string;
  /** Fresh Firebase ID token (called on every (re)connect). */
  getToken: () => Promise<string>;
}

export interface SocketConnectionOptions extends ConnectionOptions {
  /** ws:// or wss:// URL of the relay (room is passed as ?room=). */
  url: string;
  room?: string;
  /** Current local outfit (item index per slot), sent on join. */
  outfit?: () => Uint8Array;
  /** Display name to (re)claim on join; null = guest. */
  profile?: () => Profile | null;
  /** id is our own id for names/chat we sent (the server echoes them); name '' = guest. */
  onName?: (id: string, name: string) => void;
  /** The player left the room (not just out of view range). */
  onLeave?: (id: string) => void;
  onChat?: (id: string, text: string) => void;
  onNotice?: (code: number) => void;
  /** Flowers + daily rewards of the signed-in account (null = not signed in), see server/wallets.mjs. */
  onWallet?: (wallet: unknown) => void;
  /** The relay set our outfit (item index per slot): items we do not own removed, or the account's saved outfit. */
  onOwnOutfit?: (outfit: number[]) => void;
  /** An admin removed us (CLOSE_KICKED / CLOSE_BANNED); the connection stays closed. */
  onKicked?: (code: number) => void;
}

export class SocketConnection implements MultiplayerConnection {
  _clients = new Map<string, P2PClientData>();
  _data: P2PData;

  private _url: string;
  private _updateRate: number;
  private _ws: WebSocket | null = null;
  private _selfId = '';
  private _lastSeen = new Map<string, number>();
  /** Outfits by player id (may arrive before that player's first state). */
  private _outfits = new Map<string, number[]>();
  private _getOutfit: () => Uint8Array;
  private _getProfile: () => Profile | null;
  private _onName: (id: string, name: string) => void;
  private _onChat: (id: string, text: string) => void;
  private _onNotice: (code: number) => void;
  private _onWallet: (wallet: unknown) => void;
  private _onOwnOutfit: (outfit: number[]) => void;
  private _onLeave: (id: string) => void;
  private _onKicked: (code: number) => void;
  private _prevPayload = '';
  private _lastSent = 0;
  private _frame = new Uint8Array(STATE_BYTES);
  private _sendInterval: ReturnType<typeof setInterval> | null = null;
  private _sweepInterval: ReturnType<typeof setInterval> | null = null;
  private _retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private _retryDelay = RECONNECT_MIN_MS;
  private _closed = false;

  private _onAddClient: NonNullable<ConnectionOptions['addClient']>;
  private _onRemoveClient: NonNullable<ConnectionOptions['removeClient']>;
  private _onRemoveAllClients: NonNullable<ConnectionOptions['removeAllClients']>;
  private _onConnect: NonNullable<ConnectionOptions['onConnect']>;
  private _onDisconnect: NonNullable<ConnectionOptions['onDisconnect']>;

  constructor(options: SocketConnectionOptions) {
    this._data = options.data;
    this._updateRate = options.updateRate ?? 50;
    this._getOutfit = options.outfit ?? (() => new Uint8Array(0));
    this._getProfile = options.profile ?? (() => null);
    this._onName = options.onName ?? noop;
    this._onChat = options.onChat ?? noop;
    this._onNotice = options.onNotice ?? noop;
    this._onWallet = options.onWallet ?? noop;
    this._onOwnOutfit = options.onOwnOutfit ?? noop;
    this._onLeave = options.onLeave ?? noop;
    this._onKicked = options.onKicked ?? noop;
    const url = new URL(options.url);
    url.searchParams.set('room', options.room ?? 'main');
    this._url = url.toString();
    this._onAddClient = options.addClient ?? noop;
    this._onRemoveClient = options.removeClient ?? noop;
    this._onRemoveAllClients = options.removeAllClients ?? noop;
    this._onConnect = options.onConnect ?? noop;
    this._onDisconnect = options.onDisconnect ?? noop;
    document.addEventListener('visibilitychange', this._sendVisibility);
    this._connect();
  }

  private _connect() {
    if (this._closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this._url);
    } catch (err) {
      console.warn('[mp] invalid server URL', this._url, err);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this._onMessage(new DataView(e.data));
    };
    ws.onclose = (e) => this._handleClose(e.code);
    ws.onerror = () => {}; // onclose follows and handles the retry
  }

  private _onMessage(view: DataView) {
    if (view.byteLength < 1) return;
    switch (view.getUint8(0)) {
      case MSG_WELCOME: {
        this._selfId = String(view.getUint32(1, true));
        this._retryDelay = RECONNECT_MIN_MS;
        this._onConnect();
        this._sendVisibility();
        this._sendOutfit(this._getOutfit());
        const profile = this._getProfile();
        if (profile) void this._sendProfile(profile);
        this._send(true);
        this._sendInterval = setInterval(() => this._send(), this._updateRate);
        this._sweepInterval = setInterval(() => this._sweep(), 1000);
        console.info(`[mp] joined as #${this._selfId}`);
        return;
      }
      case MSG_STATES: {
        const count = view.getUint16(1, true);
        const now = Date.now();
        for (let i = 0; i < count; i++) {
          const at = 3 + i * (4 + STATE_BYTES);
          if (at + 4 + STATE_BYTES > view.byteLength) break;
          const id = String(view.getUint32(at, true));
          if (id === this._selfId) continue;
          let state: P2PClientData;
          try {
            state = decodeState(view, at + 4);
          } catch {
            continue;
          }
          this._lastSeen.set(id, now);
          const existing = this._clients.get(id);
          if (existing) {
            Object.assign(existing, state);
          } else {
            const data = { ...this._data, ...state, outfit: this._outfits.get(id) };
            this._clients.set(id, data);
            this._onAddClient(id, { ...data });
          }
        }
        return;
      }
      case MSG_LEAVE: {
        const id = String(view.getUint32(1, true));
        this._outfits.delete(id);
        this._remove(id);
        this._onLeave(id);
        return;
      }
      case MSG_OUTFIT: {
        if (view.byteLength < 6) return;
        const id = String(view.getUint32(1, true));
        const n = Math.min(view.getUint8(5), view.byteLength - 6, MAX_OUTFIT_SLOTS);
        const outfit = Array.from({ length: n }, (_, i) => view.getUint8(6 + i));
        if (id === this._selfId) {
          this._onOwnOutfit(outfit);
          return;
        }
        this._outfits.set(id, outfit);
        const existing = this._clients.get(id);
        if (existing) existing.outfit = outfit;
        return;
      }
      case MSG_NAME: {
        if (view.byteLength < 6) return;
        const n = Math.min(view.getUint8(5), view.byteLength - 6);
        const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + 6, n));
        this._onName(String(view.getUint32(1, true)), name);
        return;
      }
      case MSG_CHAT: {
        if (view.byteLength < 6) return;
        const text = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + 5, view.byteLength - 5));
        this._onChat(String(view.getUint32(1, true)), text);
        return;
      }
      case MSG_WALLET: {
        try {
          this._onWallet(JSON.parse(decoder.decode(new Uint8Array(view.buffer, view.byteOffset + 1, view.byteLength - 1))));
        } catch (err) {
          console.warn('[mp] bad wallet message', err);
        }
        return;
      }
      case MSG_NOTICE: {
        if (view.byteLength >= 2) this._onNotice(view.getUint8(1));
        return;
      }
    }
  }

  /** Our id in the room ('' while disconnected). */
  get selfId(): string {
    return this._selfId;
  }

  /** Tell the relay whether the game tab is shown (online rewards only count then). */
  private _sendVisibility = () => {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._selfId) return;
    ws.send(new Uint8Array([CLIENT_VISIBLE, document.hidden ? 0 : 1]));
  };

  /** Ask for the wallet / check in / claim an online reward; false while offline. */
  sendReward(action: number): boolean {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._selfId) return false;
    ws.send(new Uint8Array([CLIENT_REWARD, action]));
    return true;
  }

  /** Buy a shop item at the price we show; false while offline. The answer is a WALLET with a `shop` result. */
  sendShop(item: string, price: number): boolean {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._selfId) return false;
    const bytes = encoder.encode(JSON.stringify({ buy: item, price }));
    const msg = new Uint8Array(1 + bytes.length);
    msg[0] = CLIENT_SHOP;
    msg.set(bytes, 1);
    ws.send(msg);
    return true;
  }

  /** Send a chat line to the whole room; returns false while offline. */
  sendChat(text: string): boolean {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._selfId) return false;
    const bytes = encoder.encode([...text.trim()].slice(0, CHAT_MAX_CHARS).join(''));
    if (!bytes.length) return false;
    const msg = new Uint8Array(1 + bytes.length);
    msg[0] = CLIENT_CHAT;
    msg.set(bytes, 1);
    ws.send(msg);
    return true;
  }

  /** Claim a display name (the server verifies the Firebase ID token first), or null to sign out. */
  async _sendProfile(profile: Profile | null) {
    if (!profile) {
      if (this._ws?.readyState === WebSocket.OPEN && this._selfId) this._ws.send(new Uint8Array([CLIENT_PROFILE, 0, 0, 0]));
      return;
    }
    let token: string;
    try {
      token = await profile.getToken();
    } catch (err) {
      console.warn('[mp] could not get a sign-in token', err);
      this._onNotice(NOTICE_AUTH_FAILED);
      return;
    }
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._selfId) return;
    const tokenBytes = encoder.encode(token);
    const nameBytes = encoder.encode(profile.name).subarray(0, 255);
    if (tokenBytes.length > 0xffff) return;
    const msg = new Uint8Array(4 + tokenBytes.length + nameBytes.length);
    const view = new DataView(msg.buffer);
    msg[0] = CLIENT_PROFILE;
    view.setUint16(1, tokenBytes.length, true);
    msg.set(tokenBytes, 3);
    msg[3 + tokenBytes.length] = nameBytes.length;
    msg.set(nameBytes, 4 + tokenBytes.length);
    ws.send(msg);
  }

  /** Send our state when it changed, or as a heartbeat. */
  private _send(force = false) {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Until the engine has written a real position, others would see us
    // pop in at the world origin and then snap; wait for the first frame.
    const p = this._data.p as number[] | undefined;
    if (!p || (p[0] === 0 && p[1] === 0 && p[2] === 0)) return;
    const now = Date.now();
    const payload = JSON.stringify(this._data);
    const heartbeat = now - this._lastSent >= (document.hidden ? HIDDEN_RATE_MS : HEARTBEAT_MS);
    if (!force && !heartbeat && payload === this._prevPayload) return;
    this._prevPayload = payload;
    this._lastSent = now;
    ws.send(encodeState(this._data, this._frame));
  }

  /** Publish our outfit (on join and whenever it changes). */
  _sendOutfit(outfit: Uint8Array) {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._selfId) return;
    const n = Math.min(outfit.length, MAX_OUTFIT_SLOTS);
    const msg = new Uint8Array(2 + n);
    msg[0] = CLIENT_OUTFIT;
    msg[1] = n;
    msg.set(outfit.subarray(0, n), 2);
    ws.send(msg);
  }

  private _remove(id: string) {
    this._lastSeen.delete(id);
    if (this._clients.delete(id)) this._onRemoveClient(id);
  }

  private _sweep() {
    const now = Date.now();
    for (const [id, seen] of this._lastSeen) {
      if (now - seen > REMOTE_TIMEOUT_MS) this._remove(id);
    }
  }

  private _handleClose(code: number) {
    if (this._sendInterval) clearInterval(this._sendInterval);
    if (this._sweepInterval) clearInterval(this._sweepInterval);
    this._sendInterval = null;
    this._sweepInterval = null;
    this._ws = null;
    const wasConnected = this._selfId !== '';
    this._selfId = '';
    this._clients.clear();
    this._lastSeen.clear();
    this._outfits.clear();
    this._onRemoveAllClients();
    if (wasConnected) this._onDisconnect();
    if (this._closed) return;
    if (code === CLOSE_KICKED || code === CLOSE_BANNED) {
      this._closed = true;
      console.warn(`[mp] removed by an admin (${code}), not reconnecting`);
      this._onKicked(code);
      return;
    }
    console.warn(`[mp] disconnected, retrying in ${this._retryDelay / 1000}s`);
    this._retryTimeout = setTimeout(() => this._connect(), this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, RECONNECT_MAX_MS);
  }

  _dispose() {
    this._closed = true;
    document.removeEventListener('visibilitychange', this._sendVisibility);
    if (this._retryTimeout) clearTimeout(this._retryTimeout);
    this._ws?.close();
  }
}

/** Default relay URL: same host as the page, path /mp (dev server or our server). */
export function defaultMultiplayerUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/mp`;
}
