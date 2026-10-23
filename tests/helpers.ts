import { applyAction, newRoom, setTieRand } from '../shared/engine/engine.ts';
import { Todo } from '../shared/engine/views.ts';
import { Action, GameError, GameState, Role } from '../shared/engine/types.ts';

export const uid = (seat: number) => `u${seat}`;
export const DEFAULT_ROLES: Role[] = [
  'wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager', 'villager', 'villager',
];

/** 可重复的伪随机数 */
export function seeded(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x % n;
  };
}

export function act(s: GameState, seat: number, a: Action, rand = seeded(7)): GameState {
  setTieRand(rand);
  return applyAction(s, uid(seat), a, rand);
}

export function lobby12(): GameState {
  let s = newRoom('ABC123', uid(1), 'P1');
  for (let i = 2; i <= 12; i++) s = act(s, i, { type: 'join', name: 'P' + i });
  for (let i = 1; i <= 12; i++) s = act(s, i, { type: 'ready', ready: true });
  return s;
}

/** 以指定身份开局并进入第一夜（NIGHT_WOLF） */
export function startGame(roles: Role[] = DEFAULT_ROLES): GameState {
  let s = act(lobby12(), 1, { type: 'start' });
  s = structuredClone(s);
  s.players.forEach((p, i) => { p.role = roles[i]; });
  for (let i = 1; i <= 12; i++) s = act(s, i, { type: 'ack' });
  return s;
}

export const seatsOf = (s: GameState, role: Role) => s.players.filter((p) => p.role === role).map((p) => p.seat);

export function fails(fn: () => unknown, code?: string) {
  try { fn(); } catch (e) {
    if (e instanceof GameError) return code ? e.code === code : true;
    throw e;
  }
  return false;
}

/** 所有狼人指向同一目标 */
export function wolvesKill(s: GameState, target: number): GameState {
  for (const w of seatsOf(s, 'wolf').filter((x) => s.players[x - 1].alive)) s = act(s, w, { type: 'wolfKill', target });
  return s;
}

/** 完成一个夜晚：刀 target，预言家验 seerT，女巫 witchAction */
export function night(
  s: GameState, knife: number, opts: { seerT?: number; witch?: { use: 'none' | 'save' | 'poison'; target?: number } } = {},
): GameState {
  s = wolvesKill(s, knife);
  if (s.phase === 'NIGHT_SEER') {
    const seer = seatsOf(s, 'seer')[0];
    s = act(s, seer, { type: 'seerCheck', target: opts.seerT ?? 12 });
  }
  if (s.phase === 'NIGHT_WITCH') {
    const w = seatsOf(s, 'witch')[0];
    s = act(s, w, { type: 'witch', ...(opts.witch ?? { use: 'none' }) });
  }
  return s;
}

/** 跳过警长竞选（全部不报名） */
export function skipSheriff(s: GameState): GameState {
  for (const p of s.players.filter((x) => x.alive)) s = act(s, p.seat, { type: 'register', run: false });
  return s;
}

/** 让所有人发言完毕直到投票阶段 */
export function finishSpeech(s: GameState): GameState {
  if (s.phase === 'DAY_SPEECH' && s.sheriff !== null && s.players[s.sheriff - 1].alive && s.day.direction === null)
    s = act(s, s.sheriff, { type: 'direction', dir: 'cw' });
  while (s.phase === 'DAY_SPEECH') {
    const cur = s.day.order[s.day.idx];
    s = act(s, cur, { type: 'speechDone' });
  }
  return s;
}

export function everyoneVotes(s: GameState, pick: (voter: number) => number): GameState {
  const v = s.day.vote;
  if (!v) throw new Error('no vote');
  for (const voter of v.voters) s = act(s, voter, { type: 'vote', target: pick(voter) });
  return s;
}

/** 进入第一个白天的放逐投票（无警长），夜里平安 */
export function toFirstDayVote(s: GameState = startGame()): GameState {
  s = night(s, 12, { witch: { use: 'save' } }); // 解药救下 12 号 => 平安夜
  s = skipSheriff(s);
  s = finishSpeech(s);
  return s;
}

export function botAction(t: Todo, rnd: (n: number) => number): Action {
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

