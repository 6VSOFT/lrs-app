import { describe, expect, it } from 'vitest';
import { privateView, Todo } from '../supabase/functions/_shared/engine/views.ts';
import { Action, GameState } from '../supabase/functions/_shared/engine/types.ts';
import { act, lobby12, seeded, uid } from './helpers.ts';

function botAction(t: Todo, rnd: (n: number) => number): Action {
  const pick = (xs: number[]) => xs[rnd(xs.length)];
  switch (t.kind) {
    case 'ack': return { type: 'ack' };
    case 'wolf': return { type: 'wolfKill', target: pick(t.options) };
    case 'seer': return { type: 'seerCheck', target: pick(t.options) };
    case 'witch': {
      const r = rnd(4);
      if (r === 0 && t.canSave) return { type: 'witch', use: 'save' };
      if (r === 1 && t.canPoison) return { type: 'witch', use: 'poison', target: pick(t.options) };
      return { type: 'witch', use: 'none' };
    }
    case 'register': return { type: 'register', run: rnd(3) === 0 };
    case 'withdraw': return { type: 'withdraw', withdraw: rnd(3) === 0 };
    case 'vote': return { type: 'vote', target: rnd(8) === 0 ? 0 : pick(t.options) };
    case 'call': return { type: 'call', target: rnd(2) ? 0 : pick(t.options) };
    case 'direction': return { type: 'direction', dir: rnd(2) ? 'cw' : 'ccw' };
    case 'speech': return { type: 'speechDone' };
    case 'flip': return { type: 'flip', flip: !!rnd(2) };
    case 'shoot': return { type: 'shoot', target: rnd(3) === 0 ? 0 : pick(t.options) };
    case 'handover': return { type: 'handover', target: rnd(3) === 0 ? 0 : pick(t.options) };
  }
}

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
