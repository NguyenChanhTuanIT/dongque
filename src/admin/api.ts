// Client for the relay server's admin API (server/admin-api.mjs) and its
// /health endpoint. The relay may live on another host than this page
// (features.multiplayerUrl / VITE_MULTIPLAYER_URL), so every URL is built
// from the WebSocket address.

export interface LivePlayer {
  id: number;
  room: string;
  /** Account-verified display name ('' = guest). */
  name: string;
  /** Firebase uid ('' = guest). */
  uid: string;
  connectedAt: number;
  x: number;
  z: number;
}

export interface Health {
  players: number;
  rooms: Record<string, number>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`);
  }
}

/** HTTP base of the relay ('' = same origin as this page). */
export function serverBase(multiplayerUrl: string): string {
  if (!multiplayerUrl) return '';
  const url = new URL(multiplayerUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/mp\/?$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function createAdminApi(base: () => string, token: () => Promise<string>) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base()}/admin/api${path}`, {
      ...init,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* not our API (old server, static 404 page, …) */
    }
    if (!res.ok || !body) throw new ApiError(res.status, body?.error ?? 'not_available');
    return body as T;
  }

  return {
    health: async (signal?: AbortSignal): Promise<Health> => {
      const res = await fetch(`${base()}/health`, { cache: 'no-store', signal });
      const data = await res.json();
      return { players: Number(data.players) || 0, rooms: data.rooms ?? {} };
    },
    players: (signal?: AbortSignal) => call<{ players: LivePlayer[] }>('/players', { signal }).then((r) => r.players),
    kick: (target: { id?: number; uid?: string }) =>
      call<{ kicked: number }>('/kick', { method: 'POST', body: JSON.stringify(target) }).then((r) => r.kicked),
    ban: (uid: string, banned: boolean) =>
      call<{ kicked: number }>('/ban', { method: 'POST', body: JSON.stringify({ uid, banned }) }).then((r) => r.kicked),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;

/** Vietnamese explanation of an admin API failure. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return 'Server không xác thực được phiên đăng nhập, hãy đăng nhập lại.';
      case 403:
        return 'Server không công nhận tài khoản này là admin.';
      case 503:
        return 'Server multiplayer chưa cấu hình FIREBASE_PROJECT_ID.';
      default:
        return err.code === 'not_available'
          ? 'Server multiplayer chưa có API quản trị (cần cập nhật server).'
          : `Server trả lỗi ${err.status}.`;
    }
  }
  return 'Không kết nối được server multiplayer.';
}
