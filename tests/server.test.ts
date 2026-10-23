import { describe, expect, it } from 'vitest';
import { handle, Stores } from '../server/handler.ts';
import { MemoryKV } from '../server/memoryStore.ts';
import { botAction, seeded } from './helpers.ts';
import type { Todo } from '../shared/engine/views.ts';

const secrets = Array.from({ length: 12 }, (_, i) => `secret-token-number-${String(i + 1).padStart(2, '0')}`);
const newStores = (): Stores => ({ rooms: new MemoryKV(), seen: new MemoryKV() });
const post = (st: Stores, secret: string | null, body: unknown) => handle(st, { method: 'POST', query: {}, body, secret });
const get = (st: Stores, secret: string | null, code: string, since = 0) =>
  handle(st, { method: 'GET', query: { code, since: String(since) }, body: null, secret });

async function lobby(st: Stores) {
  const c = await post(st, secrets[0], { op: 'create', name: 'P1' });
  const code = (c.body as { code: string }).code;
  for (let i = 1; i < 12; i++) expect((await post(st, secrets[i], { op: 'act', code, action: { type: 'join', name: 'P' + (i + 1) } })).status).toBe(200);
  // 12 人同时点「准备」：并发写入 + 乐观锁冲突重试
  const rs = await Promise.all(secrets.map((s) => post(st, s, { op: 'act', code, action: { type: 'ready', ready: true } })));
  rs.forEach((r) => expect(r.status).toBe(200));
  return code;
}

type View = { pub: { phase: string; winner: string; players: { role: unknown; ready: boolean }[] }; priv: { seat: number; todo: Todo | null } | null };

describe('可信后端（handler + 条件写入存储）', () => {
  it('未带令牌/令牌非法被拒绝；房间不存在返回 404', async () => {
    const st = newStores();
    expect((await post(st, null, { op: 'create', name: 'x' })).status).toBe(401);
    expect((await post(st, 'short', { op: 'create', name: 'x' })).status).toBe(401);
    expect((await get(st, secrets[0], 'NOPE12')).status).toBe(404);
  });

  it('12 人并发准备不丢操作；第 13 人被拒；非创建者不能开始', async () => {
    const st = newStores();
    const code = await lobby(st);
    const v = (await get(st, secrets[5], code)).body as View;
    expect(v.pub.players.length).toBe(12);
    expect(v.pub.players.every((p) => p.ready)).toBe(true);
    const full = await post(st, 'thirteenth-player-secret-token', { op: 'act', code, action: { type: 'join', name: 'X' } });
    expect(full.body).toMatchObject({ code: 'ROOM_FULL' });
    const nh = await post(st, secrets[3], { op: 'act', code, action: { type: 'start' } });
    expect(nh.body).toMatchObject({ code: 'NOT_HOST' });
  });

  it('创建者（房主）也只能看到自己的身份；响应里没有任何他人身份或令牌', async () => {
    const st = newStores();
    const code = await lobby(st);
    expect((await post(st, secrets[0], { op: 'act', code, action: { type: 'start' } })).status).toBe(200);
    for (let i = 0; i < 12; i++) {
      const body = (await get(st, secrets[i], code)).body as View;
      const text = JSON.stringify(body);
      expect(body.priv!.seat).toBe(i + 1);
      expect(body.pub.players.every((p) => p.role === null)).toBe(true);
      secrets.forEach((s) => expect(text).not.toContain(s));
      expect(text).not.toContain('身份分配');
      expect(text).not.toContain('wolfVotes');
    }
    const stranger = (await get(st, 'stranger-secret-token-00', code)).body as View;
    expect(stranger.priv).toBeNull();
  });

  it('后端存储保存全部身份与种子，但只存令牌哈希；日志序号连续无空洞', async () => {
    const st = newStores();
    const code = await lobby(st);
    await post(st, secrets[0], { op: 'act', code, action: { type: 'start' } });
    const raw = (st.rooms as MemoryKV).raw();
    const keys = [...raw.keys()].filter((k) => k.startsWith(code + '/e/')).sort();
    expect(keys.length).toBe(1 + 11 + 12 + 1); // 创建 + 11 加入 + 12 准备 + 开始
    keys.forEach((k, i) => expect(k.endsWith(String(i + 1).padStart(6, '0'))).toBe(true));
    expect(JSON.stringify([...raw.values()])).not.toContain(secrets[3]);
  });

  it('同一槽位被多人同时争抢：只有一个成功，其余在最新状态上重试，不丢不重', async () => {
    const st = newStores();
    const code = await lobby(st);
    await post(st, secrets[0], { op: 'act', code, action: { type: 'start' } });
    // 12 人同时确认身份 + 每人重复提交 3 次
    const rs = await Promise.all(secrets.flatMap((s) => [1, 2, 3].map(() => post(st, s, { op: 'act', code, action: { type: 'ack' } }))));
    expect(rs.filter((r) => r.status === 200).length).toBe(12);
    expect(rs.filter((r) => r.status === 409).length).toBe(24);
    const v = (await get(st, secrets[0], code)).body as View;
    expect(v.pub.phase).toBe('NIGHT');
  });

  it('快照落后时读取者补放日志，结果与全量重放一致（含随机身份）', async () => {
    const st = newStores();
    const code = await lobby(st);
    await post(st, secrets[0], { op: 'act', code, action: { type: 'start' } });
    const roles = async () => Promise.all(secrets.map(async (s) => ((await get(st, s, code)).body as { priv: { role: string } }).priv.role));
    const before = await roles();
    (st.rooms as MemoryKV).raw().delete(code + '/snap'); // 删除快照 => 从第 1 条日志全量重放
    expect(await roles()).toEqual(before);
    expect(before.filter((r) => r === 'wolf').length).toBe(4);
  });

  it('12 个机器人经 HTTP 接口并发提交（含重复提交）打完整局', async () => {
    const st = newStores();
    const code = await lobby(st);
    await post(st, secrets[0], { op: 'act', code, action: { type: 'start' } });
    const rnd = seeded(21);
    for (let step = 0; step < 400; step++) {
      const views = await Promise.all(secrets.map(async (s) => ({ s, v: (await get(st, s, code)).body as View })));
      if (views[0].v.pub.phase === 'GAME_OVER') break;
      const ready = views.filter((x) => x.v.priv!.todo && !('locked' in x.v.priv!.todo && (x.v.priv!.todo as { locked: boolean }).locked));
      expect(ready.length).toBeGreaterThan(0);
      const rs = await Promise.all(ready.flatMap((x) => {
        const a = botAction(x.v.priv!.todo!, rnd);
        return [post(st, x.s, { op: 'act', code, action: a }), post(st, x.s, { op: 'act', code, action: a })];
      }));
      rs.forEach((r) => expect([200, 409]).toContain(r.status));
    }
    const end = (await get(st, secrets[7], code)).body as View;
    expect(end.pub.phase).toBe('GAME_OVER');
    expect(end.pub.players.every((p) => p.role !== null)).toBe(true);
  });

  it('版本未变时返回 unchanged，并带在线状态', async () => {
    const st = newStores();
    const code = await lobby(st);
    const cur = (await get(st, secrets[0], code)).body as { version: number };
    const r = await get(st, secrets[0], code, cur.version);
    expect(r.body).toMatchObject({ unchanged: true });
    expect((r.body as { online: number[] }).online).toContain(1);
  });
});
