// 可信后端：与运行平台（Netlify Functions / 本地开发服务器 / 测试）无关的请求处理逻辑。
//
// 存储模型：「追加日志 + 原子占位」。
//   <房间码>/e/<序号>  每条记录 = 一次已通过校验的操作 { uid, action, seed, ts }，只能用 setIfNew 创建（原子，且永不覆盖）。
//   <房间码>/snap      最近一次状态快照 { seq, state }（尽力而为，可能略旧；读取者会补放后续日志）。
// 序号槽位只能被一个写入者占到，因此所有操作拥有唯一的全局顺序；每个操作都在“重放到前一序号的状态”上校验，
// 并发提交不会丢失或重复结算。（Netlify Blobs 的 onlyIfMatch 在高并发下并非原子，故不使用。）
// 完整状态（含全部身份）与随机种子只存在后端；客户端只能拿到「公共视图 + 自己的私人视图」。
import { HostCore, newCode, secureInt } from '../shared/hostcore.ts';
import { seededRand } from '../shared/prng.ts';
import { applyAction, newRoom } from '../shared/engine/engine.ts';
import { Action, GameError, GameState } from '../shared/engine/types.ts';

export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, data: unknown): Promise<void>;
  /** 仅当键不存在时创建；返回是否创建成功（必须是原子的） */
  setIfNew(key: string, data: unknown): Promise<boolean>;
}
export interface Stores { rooms: KV; seen: KV }
export interface Req { method: string; query: Record<string, string>; body: unknown; secret: string | null }
export interface Res { status: number; body: unknown }

interface Entry { uid: string; seed: string; ts: number; action?: Action; create?: { name: string } }
interface Snap { seq: number; state: GameState }

const VALID = new Set([
  'join', 'leave', 'ready', 'start', 'ack', 'wolfKill', 'seerCheck', 'witch', 'register', 'withdraw', 'vote',
  'speechDone', 'speechSkip', 'direction', 'call', 'flip', 'shoot', 'handover', 'playAgain',
]);
const ONLINE_MS = 20000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const res = (status: number, body: unknown): Res => ({ status, body });
const fail = (status: number, code: string, message: string) => res(status, { ok: false, code, message });
const entryKey = (code: string, seq: number) => `${code}/e/${String(seq).padStart(6, '0')}`;
const randomSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** 令牌哈希后才写入存储：即使存储被读取也无法冒用玩家身份 */
async function userId(secret: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('lrs:' + secret));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

function replay(state: GameState | null, code: string, e: Entry): GameState {
  if (e.create) return newRoom(code, e.uid, e.create.name);
  return applyAction(state as GameState, e.uid, e.action as Action, seededRand(e.seed));
}

/** 读取最新状态：快照 + 补放其后的所有日志 */
async function load(kv: KV, code: string): Promise<{ state: GameState; seq: number } | null> {
  const snap = await kv.get<Snap>(`${code}/snap`);
  let state: GameState | null = snap?.state ?? null;
  let seq = snap?.seq ?? 0;
  for (;;) {
    const e = await kv.get<Entry>(entryKey(code, seq + 1));
    if (!e) break;
    state = replay(state, code, e);
    seq += 1;
  }
  if (!state) return null;
  if (seq > (snap?.seq ?? 0) + 8) await kv.set(`${code}/snap`, { seq, state } satisfies Snap).catch(() => {});
  return { state, seq };
}

async function touch(seen: KV, code: string, uid: string): Promise<Record<string, number>> {
  const now = Date.now();
  const cur = (await seen.get<Record<string, number>>(code)) ?? {};
  if (cur[uid] && now - cur[uid] < 5000) return cur; // 节流
  const map: Record<string, number> = {};
  for (const [k, t] of Object.entries(cur)) if (now - t < 60000) map[k] = t;
  map[uid] = now;
  await seen.set(code, map).catch(() => {}); // 心跳丢失只会让在线状态短暂闪烁，不影响游戏
  return map;
}

function viewOf(loaded: { state: GameState; seq: number }, uid: string, seenMap: Record<string, number>) {
  const core = new HostCore(loaded.state, loaded.seq);
  const now = Date.now();
  loaded.state.players.forEach((p) => core.setConnected(p.uid, now - (seenMap[p.uid] ?? 0) < ONLINE_MS));
  return core.viewFor(uid);
}

export async function handle(stores: Stores, req: Req): Promise<Res> {
  if (!req.secret || req.secret.length < 16 || req.secret.length > 64) return fail(401, 'UNAUTH', '缺少身份令牌');
  const uid = await userId(req.secret);
  const kv = stores.rooms;

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as { op?: string; name?: unknown; code?: unknown; action?: Action };

    if (body.op === 'create') {
      for (let i = 0; i < 8; i++) {
        const code = newCode();
        const name = String(body.name ?? '').trim();
        try { newRoom(code, uid, name); } catch { return fail(400, 'BAD_NAME', '昵称无效'); }
        const entry: Entry = { uid, seed: randomSeed(), ts: Date.now(), create: { name } };
        if (await kv.setIfNew(entryKey(code, 1), entry)) return res(200, { ok: true, code });
      }
      return fail(500, 'RETRY', '创建失败，请重试');
    }

    if (body.op === 'act') {
      const code = String(body.code ?? '').toUpperCase();
      const action = body.action;
      if (!action || typeof action !== 'object' || !VALID.has((action as Action).type)) return fail(400, 'BAD_ACTION', '无效操作');
      for (let attempt = 0; attempt < 40; attempt++) {
        const cur = await load(kv, code);
        if (!cur) return fail(404, 'NO_ROOM', '房间不存在');
        const entry: Entry = { uid, seed: randomSeed(), ts: Date.now(), action };
        try { replay(cur.state, code, entry); }
        catch (e) {
          if (e instanceof GameError) return fail(409, e.code, e.message);
          return fail(500, 'SERVER', '内部错误');
        }
        if (await kv.setIfNew(entryKey(code, cur.seq + 1), entry)) {
          return res(200, { ok: true, version: cur.seq + 1 });
        }
        // 槽位已被别人占用：重新读取后在最新状态上再次校验
        if (attempt > 3) await sleep(secureInt(30));
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
      // 长轮询：只需探测「下一条日志是否出现」
      const changed = since <= 0 ? true : !!(await kv.get<Entry>(entryKey(code, since + 1)));
      if (changed || !wait || i >= 6) {
        const cur = await load(kv, code);
        if (!cur) return fail(404, 'NO_ROOM', '房间不存在');
        const view = viewOf(cur, uid, seenMap);
        if (cur.seq <= since) return res(200, { unchanged: true, version: cur.seq, online: view.online });
        return res(200, view);
      }
      await sleep(1000);
    }
  }
  return fail(405, 'BAD_METHOD', '不支持的方法');
}
