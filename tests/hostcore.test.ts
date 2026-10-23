import { describe, expect, it } from 'vitest';
import { HostCore } from '../src/hostcore';
import { Todo } from '../shared/engine/views';
import { botAction, seeded } from './helpers';

const uids = Array.from({ length: 12 }, (_, i) => `secret-${i + 1}`);

function lobbyCore(rnd = seeded(5)) {
  const saved: number[] = [];
  const core = HostCore.create('ABC123', uids[0], 'P1', rnd, (_s, v) => saved.push(v));
  for (let i = 1; i < 12; i++) expect(core.handle(uids[i], { type: 'join', name: 'P' + (i + 1) }).ok).toBe(true);
  uids.forEach((u) => core.handle(u, { type: 'ready', ready: true }));
  return { core, saved };
}

describe('房主端法官（HostCore）', () => {
  it('第 13 人被拒；非房主不能开始；每次变更都会持久化', () => {
    const { core, saved } = lobbyCore();
    expect(core.handle('intruder', { type: 'join', name: 'X' })).toMatchObject({ ok: false, code: 'ROOM_FULL' });
    expect(core.handle(uids[3], { type: 'start' })).toMatchObject({ ok: false, code: 'NOT_HOST' });
    expect(saved.length).toBeGreaterThan(20);
    expect(core.handle(uids[0], { type: 'start' }).ok).toBe(true);
  });

  it('发给每位玩家的视图只含自己的身份，序列化后不泄露他人身份/令牌', () => {
    const { core } = lobbyCore();
    core.handle(uids[0], { type: 'start' });
    for (let i = 0; i < 12; i++) {
      const v = core.viewFor(uids[i]);
      const text = JSON.stringify(v);
      expect(v.priv!.seat).toBe(i + 1);
      expect(v.pub.players.every((p) => p.role === null)).toBe(true);
      uids.forEach((u) => expect(text).not.toContain(u));
      expect(text).not.toContain('身份分配');
      if (v.priv!.role !== 'wolf') expect(v.priv!.wolves).toBeNull();
      // 他人的角色名不应出现在自己的视图里（自己的除外）
      const own = v.priv!.role!;
      for (const r of ['wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager']) {
        if (r !== own && !(own === 'wolf' && r === 'wolf')) expect(text).not.toContain(`"role":"${r}"`);
      }
    }
    expect(core.viewFor('stranger').priv).toBeNull();
  });

  it('12 名机器人通过 HostCore 打完整局，且重启（从持久化恢复）后继续', () => {
    const rnd = seeded(11);
    let snapshot: { s: unknown; v: number } | null = null;
    const { core } = lobbyCore(rnd);
    const live = { core };
    core.handle(uids[0], { type: 'start' });
    for (let step = 0; step < 3000 && live.core.state.phase !== 'GAME_OVER'; step++) {
      if (step === 40) { // 模拟房主刷新页面：序列化→反序列化
        snapshot = JSON.parse(JSON.stringify({ s: live.core.state, v: live.core.version }));
        live.core = new HostCore(snapshot!.s as never, snapshot!.v, rnd);
      }
      const todos = uids
        .map((u) => ({ u, t: live.core.viewFor(u).priv!.todo }))
        .filter((x): x is { u: string; t: Todo } => !!x.t && !('locked' in x.t && (x.t as { locked: boolean }).locked));
      expect(todos.length).toBeGreaterThan(0);
      const w = todos[rnd(todos.length)];
      expect(live.core.handle(w.u, botAction(w.t, rnd)).ok).toBe(true);
    }
    expect(live.core.state.phase).toBe('GAME_OVER');
    const end = live.core.viewFor(uids[5]);
    expect(end.pub.players.every((p) => p.role !== null)).toBe(true);
  });

  it('在线状态：房主恒在线，其余按连接', () => {
    const { core } = lobbyCore();
    core.setConnected(uids[2], true);
    expect(core.viewFor(uids[0]).online.sort()).toEqual([1, 3]);
    core.setConnected(uids[2], false);
    expect(core.viewFor(uids[0]).online).toEqual([1]);
  });
});
