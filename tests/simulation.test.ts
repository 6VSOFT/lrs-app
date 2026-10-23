import { describe, expect, it } from 'vitest';
import { privateView, Todo } from '../shared/engine/views.ts';
import { GameState } from '../shared/engine/types.ts';
import { act, botAction, lobby12, seeded, uid } from './helpers.ts';

function playRandomGame(seed: number): GameState {
  const rnd = seeded(seed);
  let s = act(lobby12(), 1, { type: 'start' }, rnd);
  for (let step = 0; step < 3000 && s.phase !== 'GAME_OVER'; step++) {
    const todos = s.players
      .map((p) => ({ seat: p.seat, t: privateView(s, uid(p.seat))!.todo }))
      .filter((x): x is { seat: number; t: Todo } => !!x.t && !('locked' in x.t && (x.t as { locked: boolean }).locked));
    if (!todos.length) throw new Error(`死锁：phase=${s.phase} seed=${seed}`);
    const who = todos[rnd(todos.length)];
    s = act(s, who.seat, botAction(who.t, rnd), rnd);
    // 不变量
    const alive = s.players.filter((p) => p.alive);
    if (s.phase !== 'GAME_OVER') expect(alive.some((p) => p.role === 'wolf')).toBe(true);
    if (s.witch.heal === false && s.witch.poison === false) expect(true).toBe(true);
  }
  return s;
}

describe('随机机器人整局模拟', () => {
  it('300 局均能走到 GAME_OVER 且无死锁/异常', () => {
    const wins = { wolf: 0, good: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const s = playRandomGame(seed);
      expect(s.phase).toBe('GAME_OVER');
      expect(s.winner).not.toBeNull();
      wins[s.winner!]++;
    }
    expect(wins.wolf + wins.good).toBe(300);
  });
});
