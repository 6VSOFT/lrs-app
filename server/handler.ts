// 可信后端：与运行平台（Netlify Functions / 本地开发服务器 / 测试）无关的请求处理逻辑。
// 完整状态（含全部身份）只存在于服务端存储中；客户端只能拿到「公共视图 + 自己的私人视图」。
import { HostCore, newCode, secureInt } from '../shared/hostcore.ts';
import { Action, GameState } from '../shared/engine/types.ts';

export interface Stored<T> { data: T; etag: string }
export interface Cond { match?: string; isNew?: boolean }
/** 带乐观锁的键值存储：set 的条件不满足时返回 false */
export interface KV {
  get<T>(key: string): Promise<Stored<T> | null>;
  set(key: string, data: unknown, cond?: Cond): Promise<boolean>;
}
export interface Stores { rooms: KV; seen: KV }
export interface Req { method: string; query: Record<string, string>; body: unknown; secret: string | null }
export interface Res { status: number; body: unknown }
interface Room { version: number; state: GameState }

const VALID = new Set([
  'join', 'leave', 'ready', 'start', 'ack', 'wolfKill', 'seerCheck', 'witch', 'register', 'withdraw', 'vote',
  'speechDone', 'speechSkip', 'direction', 'call', 'flip', 'shoot', 'handover', 'playAgain',
]);
const ONLINE_MS = 20000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const res = (status: number, body: unknown): Res => ({ status, body });
const fail = (status: number, code: string, message: string) => res(status, { ok: false, code, message });

/** 令牌哈希后才写入存储：即使存储被读取也无法冒用玩家身份 */
async function userId(secret: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('lrs:' + secret));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function touch(seen: KV, code: string, uid: string): Promise<Record<string, number>> {
  const now = Date.now();
  for (let i = 0; i < 4; i++) {
    const cur = await seen.get<Record<string, number>>(code);
    const map: Record<string, number> = {};
    for (const [k, t] of Object.entries(cur?.data ?? {})) if (now - t < 60000) map[k] = t;
    if (cur?.data[uid] && now - cur.data[uid] < 5000) return map; // 节流
    map[uid] = now;
    const ok = await seen.set(code, map, cur ? { match: cur.etag } : { isNew: true });
    if (ok) return map;
    await sleep(20 + secureInt(40));
  }
  return (await seen.get<Record<string, number>>(code))?.data ?? {};
}

function viewOf(room: Room, uid: string, seenMap: Record<string, number>) {
  const core = new HostCore(room.state, room.version);
  const now = Date.now();
  room.state.players.forEach((p) => core.setConnected(p.uid, now - (seenMap[p.uid] ?? 0) < ONLINE_MS));
  return core.viewFor(uid);
}

export async function handle(stores: Stores, req: Req): Promise<Res> {
  if (!req.secret || req.secret.length < 16 || req.secret.length > 64) return fail(401, 'UNAUTH', '缺少身份令牌');
  const uid = await userId(req.secret);

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as { op?: string; name?: unknown; code?: unknown; action?: Action };

    if (body.op === 'create') {
      for (let i = 0; i < 6; i++) {
        const code = newCode();
        let core: HostCore;
        try { core = HostCore.create(code, uid, String(body.name ?? '').trim()); }
        catch { return fail(400, 'BAD_NAME', '昵称无效'); }
        if (await stores.rooms.set(code, { version: core.version, state: core.state } satisfies Room, { isNew: true })) {
          return res(200, { ok: true, code });
        }
      }
      return fail(500, 'RETRY', '创建失败，请重试');
    }

    if (body.op === 'act') {
      const code = String(body.code ?? '').toUpperCase();
      const action = body.action;
      if (!action || typeof action !== 'object' || !VALID.has((action as Action).type)) return fail(400, 'BAD_ACTION', '无效操作');
      for (let attempt = 0; attempt < 25; attempt++) {
        const cur = await stores.rooms.get<Room>(code);
        if (!cur) return fail(404, 'NO_ROOM', '房间不存在');
        const core = new HostCore(cur.data.state, cur.data.version);
        const r = core.handle(uid, action);
        if (!r.ok) return fail(409, r.code, r.message);
        if (await stores.rooms.set(code, { version: core.version, state: core.state } satisfies Room, { match: cur.etag })) {
          return res(200, { ok: true, version: core.version });
        }
        await sleep(15 + secureInt(60)); // 乐观锁冲突：退避重试，保证不丢操作也不重复结算
      }
      return fail(503, 'BUSY', '服务器繁忙，请重试');
    }
    return fail(400, 'BAD_OP', '无效请求');
  }

  if (req.method === 'GET') {
    const code = String(req.query.code ?? '').toUpperCase();
    const since = Number(req.query.since ?? 0) || 0;
    const wait = req.query.wait === '1';
    const seenMap = await touch(stores.seen, code, uid);
    for (let i = 0; ; i++) {
      const cur = await stores.rooms.get<Room>(code);
      if (!cur) return fail(404, 'NO_ROOM', '房间不存在');
      if (cur.data.version > since || !wait || i >= 6) {
        const view = viewOf(cur.data, uid, seenMap);
        if (cur.data.version <= since) return res(200, { unchanged: true, version: cur.data.version, online: view.online });
        return res(200, view);
      }
      await sleep(1000);
    }
  }
  return fail(405, 'BAD_METHOD', '不支持的方法');
}
