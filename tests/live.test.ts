// 对已部署站点做真实联机测试：LIVE_URL=https://lrs-app.netlify.app npx vitest run tests/live.test.ts
import { describe, expect, it } from 'vitest';
import { botAction, seeded } from './helpers.ts';
import type { Todo } from '../shared/engine/views.ts';

const BASE = process.env.LIVE_URL;
const API = `${BASE}/.netlify/functions/game`;
const secrets = Array.from({ length: 13 }, (_, i) => `live-test-${Date.now()}-${String(i).padStart(2, '0')}-xxxxxxxx`);
const post = async (s: string, body: unknown) => {
  const r = await fetch(API, { method: 'POST', headers: { Authorization: 'Bearer ' + s, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
const get = async (s: string, code: string) => {
  const r = await fetch(`${API}?code=${code}&since=0`, { headers: { Authorization: 'Bearer ' + s } });
  return { status: r.status, body: await r.json() as Record<string, any> };
};

describe.skipIf(!BASE)('线上 12 人整局实测（机器人）', () => {
  it('创建→12 人加入→第 13 人被拒→开局→并发打到结束→公开身份', async () => {
    const c = await post(secrets[0], { op: 'create', name: 'B1' });
    const code = c.body.code as string;
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    for (let i = 1; i < 12; i++) expect((await post(secrets[i], { op: 'act', code, action: { type: 'join', name: 'B' + (i + 1) } })).status).toBe(200);
    expect((await post(secrets[12], { op: 'act', code, action: { type: 'join', name: 'B13' } })).body).toMatchObject({ code: 'ROOM_FULL' });
    const rs = await Promise.all(secrets.slice(0, 12).map((s) => post(s, { op: 'act', code, action: { type: 'ready', ready: true } })));
    rs.forEach((r) => expect(r.status).toBe(200));
    expect((await post(secrets[0], { op: 'act', code, action: { type: 'start' } })).status).toBe(200);

    for (let i = 0; i < 12; i++) {
      const v = (await get(secrets[i], code)).body;
      expect(v.pub.players.every((p: { role: unknown }) => p.role === null)).toBe(true);
      expect(JSON.stringify(v)).not.toContain(secrets[(i + 1) % 12]);
    }
    const rnd = seeded(77);
    let phase = '';
    for (let step = 0; step < 300 && phase !== 'GAME_OVER'; step++) {
      const views = await Promise.all(secrets.slice(0, 12).map(async (s) => ({ s, v: (await get(s, code)).body })));
      phase = views[0].v.pub.phase;
      if (phase === 'GAME_OVER') break;
      const ready = views.filter((x) => x.v.priv.todo && !x.v.priv.todo.locked);
      expect(ready.length).toBeGreaterThan(0);
      await Promise.all(ready.map((x) => post(x.s, { op: 'act', code, action: botAction(x.v.priv.todo as Todo, rnd) })));
    }
    const end = (await get(secrets[3], code)).body;
    expect(end.pub.phase).toBe('GAME_OVER');
    expect(end.pub.players.every((p: { role: unknown }) => p.role !== null)).toBe(true);
    console.log('winner:', end.pub.winner, end.pub.winReason, 'log lines:', end.pub.log.length);
  }, 280000);
});
