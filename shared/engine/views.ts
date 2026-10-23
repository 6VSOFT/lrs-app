// 由权威状态派生「公共视图」与「每位玩家的私人视图」。隐藏信息只会出现在对应玩家的私人视图中。
import { BallotResult, GameState, LogEntry, Phase, Role } from './types.ts';

export interface PublicPlayer {
  seat: number; name: string; ready: boolean; alive: boolean; sheriff: boolean;
  role: Role | null; // 仅已公开 / 游戏结束后有值
}
export interface PublicView {
  code: string;
  hostSeat: number;
  /** 夜晚各子阶段对外统一显示为 NIGHT，避免泄露哪个角色正在行动 */
  phase: Phase | 'NIGHT';
  round: number;
  players: PublicPlayer[];
  sheriff: number | null;
  announce: { round: number; deaths: number[] } | null;
  waiting: number[];
  speech: { order: number[]; idx: number; direction: 'cw' | 'ccw' | null } | null;
  candidates: number[];
  withdrawn: number[];
  voting: { kind: 'sheriff' | 'day'; stage: 1 | 2; candidates: number[]; voters: number[]; voted: number[]; call: number | null } | null;
  tied: number[];
  actorSeat: number | null; // 猎人开枪 / 白痴翻牌 / 警徽移交 的当事人
  lastVote: BallotResult | null;
  winner: 'wolf' | 'good' | null;
  winReason: string | null;
  log: LogEntry[];
  version?: number;
}

export type Todo =
  | { kind: 'ack' }
  | { kind: 'wolf'; options: number[]; locked: boolean; myPick: number | null }
  | { kind: 'seer'; options: number[]; locked: boolean }
  | { kind: 'witch'; options: number[]; knife: number | null; canSave: boolean; canPoison: boolean; locked: boolean }
  | { kind: 'register'; locked: boolean }
  | { kind: 'withdraw'; locked: boolean }
  | { kind: 'vote'; options: number[]; locked: boolean; myVote: number | null }
  | { kind: 'call'; options: number[] }
  | { kind: 'direction' }
  | { kind: 'speech' }
  | { kind: 'flip' }
  | { kind: 'shoot'; options: number[] }
  | { kind: 'handover'; options: number[] };

export interface PrivateView {
  seat: number;
  role: Role | null;
  wolves: { seat: number; name: string }[] | null;
  seerHistory: { round: number; seat: number; isWolf: boolean }[] | null;
  witch: { heal: boolean; poison: boolean } | null;
  teamVotes: Record<string, number> | null;
  todo: Todo | null;
}

export function publicView(s: GameState): PublicView {
  const over = s.phase === 'GAME_OVER';
  const night = s.phase === 'NIGHT_WOLF' || s.phase === 'NIGHT_SEER' || s.phase === 'NIGHT_WITCH' || s.phase === 'NIGHT_RESOLUTION';
  const alive = s.players.filter((p) => p.alive).map((p) => p.seat);
  let waiting: number[] = [];
  const d = s.day;
  switch (s.phase) {
    case 'ROLE_ASSIGNMENT': waiting = s.players.filter((p) => !p.acked).map((p) => p.seat); break;
    case 'SHERIFF_REGISTRATION': waiting = alive.filter((x) => d.registered[x] === undefined); break;
    case 'SHERIFF_WITHDRAWAL': waiting = d.candidates.filter((x) => !d.withdrawAnswered.includes(x)); break;
    case 'SHERIFF_VOTING': case 'SHERIFF_TIE_RESOLUTION': case 'DAY_VOTING': case 'DAY_TIE_RESOLUTION':
      if (d.vote && !(s.phase === 'DAY_TIE_RESOLUTION' && d.tieStep === 'speech'))
        waiting = d.vote.voters.filter((x) => d.vote!.votes[x] === undefined);
      break;
    default: break;
  }
  const speaking = s.phase === 'DAY_SPEECH' || (s.phase === 'DAY_TIE_RESOLUTION' && d.tieStep === 'speech');
  const eff = s.effects[0];
  const actorSeat = s.phase === 'IDIOT_REVEAL' ? d.exiling
    : (s.phase === 'HUNTER_SHOOTING' || s.phase === 'SHERIFF_HANDOVER') && eff ? eff.seat : null;
  return {
    code: s.code,
    hostSeat: s.players.find((p) => p.uid === s.hostUid)?.seat ?? 0,
    phase: night ? 'NIGHT' : s.phase,
    round: s.round,
    players: s.players.map((p) => ({
      seat: p.seat, name: p.name, ready: p.ready, alive: p.alive, sheriff: s.sheriff === p.seat,
      role: over || p.revealed ? p.role : null,
    })),
    sheriff: s.sheriff,
    announce: s.announce,
    waiting,
    speech: speaking ? { order: d.order, idx: d.idx, direction: d.direction } : null,
    candidates: d.candidates,
    withdrawn: d.withdrawn,
    voting: d.vote ? {
      kind: d.vote.kind, stage: d.vote.stage, candidates: d.vote.candidates, voters: d.vote.voters,
      voted: Object.keys(d.vote.votes).map(Number), call: s.day.call,
    } : (s.phase === 'DAY_VOTING' ? { kind: 'day', stage: 1, candidates: alive, voters: alive, voted: [], call: null } : null),
    tied: d.tied,
    actorSeat,
    lastVote: s.lastVote,
    winner: s.winner,
    winReason: s.winReason,
    log: s.log.filter((l) => over || !l.secret),
  };
}

export function privateView(s: GameState, uid: string): PrivateView | null {
  const me = s.players.find((p) => p.uid === uid);
  if (!me) return null;
  const role = me.role;
  const alive = s.players.filter((p) => p.alive).map((p) => p.seat);
  const d = s.day;
  const v: PrivateView = {
    seat: me.seat, role,
    wolves: role === 'wolf' ? s.players.filter((p) => p.role === 'wolf').map((p) => ({ seat: p.seat, name: p.name })) : null,
    seerHistory: role === 'seer' ? s.seerHistory : null,
    witch: role === 'witch' ? { ...s.witch } : null,
    teamVotes: role === 'wolf' && s.phase === 'NIGHT_WOLF' ? s.night.wolfVotes : null,
    todo: null,
  };
  if (s.phase === 'GAME_OVER' || s.phase === 'WAITING_ROOM') return v;

  switch (s.phase) {
    case 'ROLE_ASSIGNMENT':
      if (!me.acked) v.todo = { kind: 'ack' };
      break;
    case 'NIGHT_WOLF':
      if (me.alive && role === 'wolf') {
        const pick = s.night.wolfVotes[me.seat];
        v.todo = { kind: 'wolf', options: alive, locked: pick !== undefined, myPick: pick ?? null };
      }
      break;
    case 'NIGHT_SEER':
      if (me.alive && role === 'seer') v.todo = { kind: 'seer', options: alive, locked: false };
      break;
    case 'NIGHT_WITCH':
      if (me.alive && role === 'witch') {
        // 解药用掉后不再显示刀口
        const knife = s.witch.heal ? s.night.knife : null;
        v.todo = {
          kind: 'witch', options: alive, knife, canSave: s.witch.heal && s.night.knife !== me.seat,
          canPoison: s.witch.poison, locked: false,
        };
      }
      break;
    case 'SHERIFF_REGISTRATION':
      if (me.alive) v.todo = { kind: 'register', locked: d.registered[me.seat] !== undefined };
      break;
    case 'SHERIFF_WITHDRAWAL':
      if (d.candidates.includes(me.seat)) v.todo = { kind: 'withdraw', locked: d.withdrawAnswered.includes(me.seat) };
      break;
    case 'SHERIFF_VOTING': case 'SHERIFF_TIE_RESOLUTION': case 'DAY_VOTING': case 'DAY_TIE_RESOLUTION': {
      if (s.phase === 'DAY_VOTING' && !d.vote) {
        if (s.sheriff === me.seat) v.todo = { kind: 'call', options: alive };
        break;
      }
      if (s.phase === 'DAY_TIE_RESOLUTION' && d.tieStep === 'speech') {
        if (d.order[d.idx] === me.seat) v.todo = { kind: 'speech' };
        break;
      }
      const vr = d.vote;
      if (vr && vr.voters.includes(me.seat) && me.alive) {
        const mine = vr.votes[me.seat];
        const options = vr.kind === 'sheriff' ? vr.candidates.filter((x) => x !== me.seat) : vr.candidates;
        v.todo = { kind: 'vote', options, locked: mine !== undefined, myVote: mine ?? null };
      }
      break;
    }
    case 'DAY_SPEECH':
      if (s.sheriff === me.seat && me.alive && d.direction === null) v.todo = { kind: 'direction' };
      else if (d.order[d.idx] === me.seat) v.todo = { kind: 'speech' };
      break;
    case 'IDIOT_REVEAL':
      if (d.exiling === me.seat) v.todo = { kind: 'flip' };
      break;
    case 'HUNTER_SHOOTING':
      if (s.effects[0]?.seat === me.seat) v.todo = { kind: 'shoot', options: alive.filter((x) => x !== me.seat) };
      break;
    case 'SHERIFF_HANDOVER':
      if (s.effects[0]?.seat === me.seat) v.todo = { kind: 'handover', options: alive };
      break;
    default: break;
  }
  return v;
}
