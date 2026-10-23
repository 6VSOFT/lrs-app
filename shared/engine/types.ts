// 游戏核心类型。本目录不依赖任何运行时（可同时在 Deno / Node / 浏览器中使用）。

export type Role = 'wolf' | 'seer' | 'witch' | 'hunter' | 'idiot' | 'villager';
export const GODS: Role[] = ['seer', 'witch', 'hunter', 'idiot'];
export const ROLE_NAMES: Record<Role, string> = {
  wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', idiot: '白痴', villager: '平民',
};
export const ROLE_POOL: Role[] = [
  'wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot',
  'villager', 'villager', 'villager', 'villager',
];
export const MAX_PLAYERS = 12;

export type Phase =
  | 'WAITING_ROOM' | 'ROLE_ASSIGNMENT'
  | 'NIGHT_WOLF' | 'NIGHT_SEER' | 'NIGHT_WITCH' | 'NIGHT_RESOLUTION'
  | 'DAY_ANNOUNCEMENT' | 'DAY_SPEECH'
  | 'SHERIFF_REGISTRATION' | 'SHERIFF_WITHDRAWAL' | 'SHERIFF_VOTING' | 'SHERIFF_TIE_RESOLUTION'
  | 'DAY_VOTING' | 'DAY_TIE_RESOLUTION'
  | 'IDIOT_REVEAL' | 'HUNTER_SHOOTING' | 'SHERIFF_HANDOVER'
  | 'VICTORY_CHECK' | 'GAME_OVER';

export type DeathCause = 'wolf' | 'poison' | 'vote' | 'shot';

export interface Player {
  seat: number;
  uid: string;
  name: string;
  ready: boolean;
  alive: boolean;
  role: Role | null;
  acked: boolean;
  /** 角色已被公开（白痴翻牌 / 猎人开枪） */
  revealed: boolean;
  death: { cause: DeathCause; round: number; when: 'night' | 'day' } | null;
}

export type Effect =
  | { kind: 'HUNTER'; seat: number }
  | { kind: 'HANDOVER'; seat: number };

export interface VoteRound {
  kind: 'sheriff' | 'day';
  stage: 1 | 2;
  candidates: number[];
  voters: number[];
  votes: Record<string, number>; // seat -> target（0 = 弃票）
}

export interface LogEntry {
  round: number;
  text: string;
  secret: boolean; // true: 游戏结束前仅服务端可见
}

export interface BallotResult {
  title: string;
  tally: Record<string, number>;
  ballots: { voter: number; target: number }[];
  outcome: string;
}

export interface GameState {
  code: string;
  hostUid: string;
  players: Player[];
  phase: Phase;
  round: number;
  sheriff: number | null;
  sheriffElectionDone: boolean;
  witch: { heal: boolean; poison: boolean };
  night: {
    wolfVotes: Record<string, number>;
    knife: number | null;
    seerTarget: number | null;
    witchDone: boolean;
    witchUse: 'none' | 'save' | 'poison';
    witchTarget: number;
  };
  seerHistory: { round: number; seat: number; isWolf: boolean }[];
  effects: Effect[];
  next: 'DAY' | 'NIGHT';
  announce: { round: number; deaths: number[] } | null;
  /** 白天阶段数据 */
  day: {
    registered: Record<string, boolean>;
    candidates: number[];
    withdrawn: number[];
    withdrawAnswered: number[];
    direction: 'cw' | 'ccw' | null;
    order: number[];
    idx: number;
    call: number | null; // null 未决定；0 不归票
    vote: VoteRound | null;
    tied: number[];
    tieStep: 'speech' | 'vote';
    exiling: number | null; // 等待白痴翻牌的座位
  };
  lastVote: BallotResult | null;
  winner: 'wolf' | 'good' | null;
  winReason: string | null;
  log: LogEntry[];
}

export type Action =
  | { type: 'join'; name: string }
  | { type: 'leave' }
  | { type: 'ready'; ready: boolean }
  | { type: 'start' }
  | { type: 'ack' }
  | { type: 'wolfKill'; target: number }
  | { type: 'seerCheck'; target: number }
  | { type: 'witch'; use: 'none' | 'save' | 'poison'; target?: number }
  | { type: 'register'; run: boolean }
  | { type: 'withdraw'; withdraw: boolean }
  | { type: 'vote'; target: number }
  | { type: 'speechDone' }
  | { type: 'speechSkip' }
  | { type: 'direction'; dir: 'cw' | 'ccw' }
  | { type: 'call'; target: number }
  | { type: 'flip'; flip: boolean }
  | { type: 'shoot'; target: number }
  | { type: 'handover'; target: number }
  | { type: 'playAgain' };

export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** 返回 [0, n) 的随机整数 */
export type Rand = (n: number) => number;
