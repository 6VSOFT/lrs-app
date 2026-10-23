import {
  Action, DeathCause, Effect, GameError, GameState, Phase, Player, Rand, ROLE_POOL, MAX_PLAYERS, VoteRound,
} from './types.ts';

const err = (code: string, msg: string): never => { throw new GameError(code, msg); };

export function freshDay(): GameState['day'] {
  return {
    registered: {}, candidates: [], withdrawn: [], withdrawAnswered: [], direction: null,
    order: [], idx: 0, call: null, vote: null, tied: [], tieStep: 'speech', exiling: null,
  };
}
function freshNight(): GameState['night'] {
  return { wolfVotes: {}, knife: null, seerTarget: null, witchDone: false, witchUse: 'none', witchTarget: 0 };
}

export function newRoom(code: string, hostUid: string, hostName: string): GameState {
  const s: GameState = {
    code, hostUid, players: [], phase: 'WAITING_ROOM', round: 0, sheriff: null, sheriffElectionDone: false,
    witch: { heal: true, poison: true }, night: freshNight(), seerHistory: [], effects: [], next: 'DAY',
    announce: null, day: freshDay(), lastVote: null, winner: null, winReason: null, log: [],
  };
  apply(s, hostUid, { type: 'join', name: hostName }, () => 0);
  return s;
}

// ---------- 工具 ----------
export const seatOf = (s: GameState, uid: string) => s.players.find((p) => p.uid === uid);
const P = (s: GameState, seat: number): Player => s.players.find((p) => p.seat === seat) as Player;
export const alive = (s: GameState) => s.players.filter((p) => p.alive);
const aliveSeats = (s: GameState) => alive(s).map((p) => p.seat);
const log = (s: GameState, text: string, secret = false) => { s.log.push({ round: s.round, text, secret }); };
const nm = (s: GameState, seat: number) => `${seat}号${P(s, seat).name}`;

function need(cond: boolean, code: string, msg: string) { if (!cond) err(code, msg); }
function actor(s: GameState, uid: string): Player {
  const p = seatOf(s, uid);
  if (!p) err('NOT_IN_ROOM', '你不在这个房间里');
  return p as Player;
}
function aliveActor(s: GameState, uid: string): Player {
  const p = actor(s, uid);
  need(p.alive, 'DEAD', '你已出局，不能行动');
  return p;
}
function inPhase(s: GameState, ...phases: Phase[]) {
  need(phases.includes(s.phase), 'BAD_PHASE', '当前阶段不允许此操作');
}
function aliveTarget(s: GameState, t: number) {
  need(Number.isInteger(t) && t >= 1 && t <= MAX_PLAYERS && !!s.players.find((p) => p.seat === t && p.alive),
    'BAD_TARGET', '目标无效或已出局');
}

// ---------- 入口 ----------
/** 纯函数式入口：返回新状态（不修改入参）。失败抛 GameError。 */
export function applyAction(state: GameState, uid: string, action: Action, rand: Rand): GameState {
  const s = structuredClone(state);
  _rand = rand;
  apply(s, uid, action, rand);
  return s;
}

function apply(s: GameState, uid: string, a: Action, rand: Rand): void {
  if (s.phase === 'GAME_OVER' && a.type !== 'playAgain' && a.type !== 'join' && a.type !== 'leave')
    err('GAME_OVER', '游戏已结束');
  switch (a.type) {
    case 'join': return join(s, uid, a.name);
    case 'leave': return leave(s, uid);
    case 'ready': {
      inPhase(s, 'WAITING_ROOM');
      actor(s, uid).ready = !!a.ready;
      return;
    }
    case 'start': return start(s, uid, rand);
    case 'ack': {
      inPhase(s, 'ROLE_ASSIGNMENT');
      const p = actor(s, uid);
      need(!p.acked, 'LOCKED', '已确认');
      p.acked = true;
      if (s.players.every((x) => x.acked)) beginNight(s);
      return;
    }
    case 'wolfKill': return wolfKill(s, uid, a.target);
    case 'seerCheck': return seerCheck(s, uid, a.target);
    case 'witch': return witchAct(s, uid, a.use, a.target);
    case 'register': return register(s, uid, a.run);
    case 'withdraw': return withdraw(s, uid, a.withdraw);
    case 'vote': return castVote(s, uid, a.target, rand);
    case 'speechDone':
    case 'speechSkip': return speech(s, uid, a.type === 'speechSkip');
    case 'direction': return direction(s, uid, a.dir);
    case 'call': return call(s, uid, a.target);
    case 'flip': return flip(s, uid, a.flip);
    case 'shoot': return shoot(s, uid, a.target);
    case 'handover': return handover(s, uid, a.target);
    case 'playAgain': return playAgain(s, uid);
    default: return err('BAD_ACTION', '未知操作');
  }
}

// ---------- 等待室 ----------
function join(s: GameState, uid: string, rawName: string) {
  if (seatOf(s, uid)) return; // 重连：幂等
  inPhase(s, 'WAITING_ROOM');
  const name = String(rawName ?? '').trim().slice(0, 10);
  need(name.length > 0, 'BAD_NAME', '请输入昵称');
  need(s.players.length < MAX_PLAYERS, 'ROOM_FULL', '房间已满（最多 12 人）');
  need(!s.players.some((p) => p.name === name), 'NAME_TAKEN', '昵称已被使用');
  const used = new Set(s.players.map((p) => p.seat));
  let seat = 1;
  while (used.has(seat)) seat++;
  s.players.push({ seat, uid, name, ready: false, alive: true, role: null, acked: false, revealed: false, death: null });
  s.players.sort((x, y) => x.seat - y.seat);
}

function leave(s: GameState, uid: string) {
  inPhase(s, 'WAITING_ROOM');
  const p = actor(s, uid);
  s.players = s.players.filter((x) => x !== p);
  if (s.hostUid === uid && s.players.length) s.hostUid = s.players[0].uid;
}

export function secureShuffle<T>(arr: T[], rand: Rand): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function start(s: GameState, uid: string, rand: Rand) {
  inPhase(s, 'WAITING_ROOM');
  need(s.hostUid === uid, 'NOT_HOST', '只有房间创建者可以开始游戏');
  need(s.players.length === MAX_PLAYERS, 'NOT_ENOUGH', '需要 12 名玩家');
  need(s.players.every((p) => p.ready), 'NOT_READY', '还有玩家未准备');
  const roles = secureShuffle(ROLE_POOL, rand);
  s.players.forEach((p, i) => { p.role = roles[i]; p.acked = false; p.alive = true; p.death = null; p.revealed = false; });
  s.phase = 'ROLE_ASSIGNMENT';
  s.round = 0;
  log(s, '身份分配：' + s.players.map((p) => `${p.seat}号${p.name}=${p.role}`).join('，'), true);
}

function playAgain(s: GameState, uid: string) {
  inPhase(s, 'GAME_OVER');
  need(s.hostUid === uid, 'NOT_HOST', '只有房间创建者可以重新开局');
  const fresh = newRoom(s.code, s.hostUid, 'x');
  s.players.forEach((p) => { p.role = null; p.ready = false; p.alive = true; p.acked = false; p.revealed = false; p.death = null; });
  Object.assign(s, { ...fresh, players: s.players, hostUid: s.hostUid });
}

// ---------- 夜晚 ----------
function beginNight(s: GameState) {
  s.round += 1;
  s.night = freshNight();
  s.day = freshDay();
  s.announce = null;
  s.phase = 'NIGHT_WOLF';
  log(s, `第 ${s.round} 夜降临`);
}

function wolfKill(s: GameState, uid: string, target: number) {
  inPhase(s, 'NIGHT_WOLF');
  const p = aliveActor(s, uid);
  need(p.role === 'wolf', 'NOT_ROLE', '你不是狼人');
  need(s.night.wolfVotes[p.seat] === undefined, 'LOCKED', '你的选择已锁定');
  aliveTarget(s, target);
  s.night.wolfVotes[p.seat] = target;
  const wolves = s.players.filter((x) => x.alive && x.role === 'wolf');
  if (!wolves.every((w) => s.night.wolfVotes[w.seat] !== undefined)) return;
  const count: Record<number, number> = {};
  wolves.forEach((w) => { const t = s.night.wolfVotes[w.seat]; count[t] = (count[t] ?? 0) + 1; });
  const max = Math.max(...Object.values(count));
  const top = Object.keys(count).map(Number).filter((k) => count[k] === max).sort((x, y) => x - y);
  s.night.knife = top.length === 1 ? top[0] : top[rand_(top.length)];
  log(s, `狼人刀口：${nm(s, s.night.knife)}`, true);
  toSeer(s);
}
// 平票随机选择需要 rand；为避免到处传参，使用模块级注入
let _rand: Rand = (n) => Math.floor(Math.random() * n);
const rand_ = (n: number) => _rand(n);
export function setTieRand(r: Rand) { _rand = r; }

function toSeer(s: GameState) {
  if (s.players.some((p) => p.alive && p.role === 'seer')) { s.phase = 'NIGHT_SEER'; return; }
  toWitch(s);
}
function seerCheck(s: GameState, uid: string, target: number) {
  inPhase(s, 'NIGHT_SEER');
  const p = aliveActor(s, uid);
  need(p.role === 'seer', 'NOT_ROLE', '你不是预言家');
  need(s.night.seerTarget === null, 'LOCKED', '今晚已查验');
  aliveTarget(s, target);
  s.night.seerTarget = target;
  const isWolf = P(s, target).role === 'wolf';
  s.seerHistory.push({ round: s.round, seat: target, isWolf });
  log(s, `预言家查验 ${nm(s, target)}：${isWolf ? '狼人' : '好人'}`, true);
  toWitch(s);
}

function toWitch(s: GameState) {
  if (s.players.some((p) => p.alive && p.role === 'witch')) { s.phase = 'NIGHT_WITCH'; return; }
  resolveNight(s);
}
function witchAct(s: GameState, uid: string, use: 'none' | 'save' | 'poison', target?: number) {
  inPhase(s, 'NIGHT_WITCH');
  const p = aliveActor(s, uid);
  need(p.role === 'witch', 'NOT_ROLE', '你不是女巫');
  need(!s.night.witchDone, 'LOCKED', '今晚已行动');
  if (use === 'save') {
    need(s.witch.heal, 'NO_POTION', '解药已用完');
    need(s.night.knife !== null, 'NO_KNIFE', '没有可救的目标');
    need(s.night.knife !== p.seat, 'NO_SELF_SAVE', '女巫不可自救');
    s.witch.heal = false;
    s.night.witchTarget = s.night.knife as number;
  } else if (use === 'poison') {
    need(s.witch.poison, 'NO_POTION', '毒药已用完');
    aliveTarget(s, target as number);
    s.witch.poison = false;
    s.night.witchTarget = target as number;
  } else if (use !== 'none') err('BAD_ACTION', '无效的药剂操作');
  s.night.witchUse = use;
  s.night.witchDone = true;
  log(s, `女巫行动：${use === 'none' ? '不使用药剂' : (use === 'save' ? '解药救' : '毒药毒') + ' ' + nm(s, s.night.witchTarget)}`, true);
  resolveNight(s);
}

/** NIGHT_RESOLUTION：统一结算，与提交顺序无关 */
function resolveNight(s: GameState) {
  s.phase = 'NIGHT_RESOLUTION';
  const n = s.night;
  const dead = new Map<number, DeathCause>();
  if (n.knife !== null && !(n.witchUse === 'save' && n.witchTarget === n.knife)) dead.set(n.knife, 'wolf');
  if (n.witchUse === 'poison') dead.set(n.witchTarget, 'poison'); // 毒杀优先（同时被刀 => 按毒杀，猎人不能开枪）
  const seats = [...dead.keys()].sort((a, b) => a - b);
  seats.forEach((seat) => kill(s, seat, dead.get(seat) as DeathCause, 'night'));
  s.announce = { round: s.round, deaths: seats };
  s.phase = 'DAY_ANNOUNCEMENT';
  log(s, seats.length ? `天亮了，昨晚出局：${seats.map((x) => nm(s, x)).join('、')}` : '天亮了，昨晚是平安夜');
  s.effects = deathEffects(s, seats);
  settle(s, 'DAY');
}

// ---------- 死亡与效果 ----------
function kill(s: GameState, seat: number, cause: DeathCause, when: 'night' | 'day') {
  const p = P(s, seat);
  p.alive = false;
  p.death = { cause, round: s.round, when };
  log(s, `${nm(s, seat)}(${p.role}) 死亡，原因：${cause}`, true);
}

/** 先猎人开枪，再警徽移交 */
function deathEffects(s: GameState, seats: number[]): Effect[] {
  const out: Effect[] = [];
  seats.forEach((seat) => {
    const p = P(s, seat);
    if (p.role === 'hunter' && p.death && (p.death.cause === 'wolf' || p.death.cause === 'vote'))
      out.push({ kind: 'HUNTER', seat });
  });
  seats.forEach((seat) => { if (s.sheriff === seat) out.push({ kind: 'HANDOVER', seat }); });
  return out;
}

export function evaluateVictory(players: Player[]): { winner: 'wolf' | 'good'; reason: string } | null {
  const a = players.filter((p) => p.alive);
  const wolves = a.filter((p) => p.role === 'wolf').length;
  if (wolves === 0) return { winner: 'good', reason: '狼人全部出局' }; // 统一优先级：先判好人
  const gods = a.filter((p) => p.role && ['seer', 'witch', 'hunter', 'idiot'].includes(p.role)).length;
  if (gods === 0) return { winner: 'wolf', reason: '屠神：四名神职全部出局' };
  const vill = a.filter((p) => p.role === 'villager').length;
  if (vill === 0) return { winner: 'wolf', reason: '屠民：四名平民全部出局' };
  return null;
}

/** VICTORY_CHECK + 处理待办效果队列，直到需要玩家输入或进入下一阶段 */
function settle(s: GameState, next: 'DAY' | 'NIGHT') {
  s.next = next;
  s.phase = 'VICTORY_CHECK';
  const v = evaluateVictory(s.players);
  if (v) {
    s.winner = v.winner; s.winReason = v.reason; s.phase = 'GAME_OVER'; s.effects = [];
    log(s, `游戏结束：${v.winner === 'wolf' ? '狼人阵营' : '好人阵营'}获胜（${v.reason}）`);
    return;
  }
  const e = s.effects[0];
  if (e) {
    s.phase = e.kind === 'HUNTER' ? 'HUNTER_SHOOTING' : 'SHERIFF_HANDOVER';
    if (e.kind === 'HUNTER') { P(s, e.seat).revealed = true; log(s, `${nm(s, e.seat)} 是猎人，可以开枪`); }
    return;
  }
  if (s.next === 'DAY') startDay(s); else beginNight(s);
}

function shoot(s: GameState, uid: string, target: number) {
  inPhase(s, 'HUNTER_SHOOTING');
  const e = s.effects[0];
  const p = actor(s, uid);
  need(e?.kind === 'HUNTER' && e.seat === p.seat, 'NOT_ROLE', '现在不是你开枪');
  s.effects.shift();
  if (target === 0) {
    log(s, `${nm(s, p.seat)} 选择不开枪`);
  } else {
    aliveTarget(s, target);
    need(target !== p.seat, 'BAD_TARGET', '不能选择自己');
    kill(s, target, 'shot', s.next === 'DAY' ? 'night' : 'day');
    log(s, `猎人开枪带走 ${nm(s, target)}`);
    if (s.sheriff === target) s.effects.push({ kind: 'HANDOVER', seat: target });
  }
  settle(s, s.next);
}

function handover(s: GameState, uid: string, target: number) {
  inPhase(s, 'SHERIFF_HANDOVER');
  const e = s.effects[0];
  const p = actor(s, uid);
  need(e?.kind === 'HANDOVER' && e.seat === p.seat, 'NOT_ROLE', '你不是需要移交警徽的警长');
  if (target === 0) {
    s.sheriff = null;
    log(s, `${nm(s, p.seat)} 撕毁了警徽，本局无警长`);
  } else {
    aliveTarget(s, target);
    s.sheriff = target;
    log(s, `${nm(s, p.seat)} 把警徽移交给 ${nm(s, target)}`);
  }
  s.effects.shift();
  settle(s, s.next);
}

// ---------- 白天 ----------
function startDay(s: GameState) {
  s.day = freshDay();
  if (s.round === 1 && !s.sheriffElectionDone) { s.phase = 'SHERIFF_REGISTRATION'; return; }
  beginSpeech(s);
}

function register(s: GameState, uid: string, run: boolean) {
  inPhase(s, 'SHERIFF_REGISTRATION');
  const p = aliveActor(s, uid);
  need(s.day.registered[p.seat] === undefined, 'LOCKED', '你已选择');
  s.day.registered[p.seat] = !!run;
  if (!aliveSeats(s).every((x) => s.day.registered[x] !== undefined)) return;
  s.day.candidates = aliveSeats(s).filter((x) => s.day.registered[x]);
  log(s, `警长报名：${s.day.candidates.map((x) => nm(s, x)).join('、') || '无人'}`);
  if (s.day.candidates.length === 0) return endSheriffElection(s, null, '无人报名，本局无警长');
  s.phase = 'SHERIFF_WITHDRAWAL';
}

function withdraw(s: GameState, uid: string, wd: boolean) {
  inPhase(s, 'SHERIFF_WITHDRAWAL');
  const p = aliveActor(s, uid);
  need(s.day.candidates.includes(p.seat), 'NOT_ROLE', '你不是警长候选人');
  need(!s.day.withdrawAnswered.includes(p.seat), 'LOCKED', '你已选择');
  s.day.withdrawAnswered.push(p.seat);
  if (wd) s.day.withdrawn.push(p.seat);
  if (s.day.withdrawAnswered.length < s.day.candidates.length) return;
  const remain = s.day.candidates.filter((x) => !s.day.withdrawn.includes(x));
  log(s, `最终候选人：${remain.map((x) => nm(s, x)).join('、') || '无'}`);
  if (remain.length === 0) return endSheriffElection(s, null, '候选人全部退水，本局无警长');
  if (remain.length === 1) return endSheriffElection(s, remain[0], `${nm(s, remain[0])} 唯一候选人，当选警长`);
  // 退水者不参与最终投票；候选人可投给其他候选人
  const voters = aliveSeats(s).filter((x) => !s.day.withdrawn.includes(x));
  s.day.vote = { kind: 'sheriff', stage: 1, candidates: remain, voters, votes: {} };
  s.phase = 'SHERIFF_VOTING';
}

function endSheriffElection(s: GameState, sheriff: number | null, msg: string) {
  s.sheriff = sheriff;
  s.sheriffElectionDone = true;
  s.day.vote = null;
  log(s, msg);
  beginSpeech(s);
}

// ---- 通用投票 ----
function weightOf(s: GameState, v: VoteRound, voter: number): number {
  if (v.kind === 'day' && s.sheriff === voter && s.day.call && s.day.call > 0) return 1.5;
  return 1;
}

function castVote(s: GameState, uid: string, target: number, _rand: Rand) {
  inPhase(s, 'SHERIFF_VOTING', 'SHERIFF_TIE_RESOLUTION', 'DAY_VOTING', 'DAY_TIE_RESOLUTION');
  const p = aliveActor(s, uid);
  const v = s.day.vote;
  if (s.phase === 'DAY_TIE_RESOLUTION') need(s.day.tieStep === 'vote' && !!v, 'BAD_PHASE', '平票发言尚未结束');
  if (s.phase === 'DAY_VOTING') need(!!v, 'BAD_PHASE', '等待警长归票');
  if (!v) return err('BAD_PHASE', '投票未开始');
  need(v.voters.includes(p.seat), 'NOT_ELIGIBLE', '你没有本轮投票资格');
  need(v.votes[p.seat] === undefined, 'LOCKED', '你已投票，不能更改');
  if (target !== 0) {
    need(v.candidates.includes(target), 'BAD_TARGET', '不是有效的投票对象');
    if (v.kind === 'sheriff') need(target !== p.seat, 'BAD_TARGET', '候选人不能投给自己');
    aliveTarget(s, target);
  }
  v.votes[p.seat] = target;
  if (v.voters.every((x) => v.votes[x] !== undefined)) tally(s, v);
}

function tally(s: GameState, v: VoteRound) {
  const t: Record<string, number> = {};
  v.candidates.forEach((c) => { t[c] = 0; });
  const ballots = v.voters.map((voter) => ({ voter, target: v.votes[voter] }));
  ballots.forEach((b) => { if (b.target) t[b.target] += weightOf(s, v, b.voter); });
  const max = Math.max(0, ...Object.values(t));
  const top = Object.keys(t).map(Number).filter((k) => t[k] === max && max > 0);
  const title = v.kind === 'sheriff' ? '警长竞选' : '放逐投票';
  const mkOutcome = (o: string) => {
    s.lastVote = { title: v.stage === 2 ? title + '（平票重投）' : title, tally: t, ballots, outcome: o };
    log(s, `${s.lastVote.title}结果：${Object.entries(t).map(([k, x]) => `${k}号 ${x}票`).join('，')}；${o}`);
  };
  if (top.length === 1) {
    const w = top[0];
    if (v.kind === 'sheriff') { mkOutcome(`${nm(s, w)} 当选警长`); return endSheriffElection(s, w, `${nm(s, w)} 当选警长`); }
    mkOutcome(`${nm(s, w)} 被放逐`);
    s.day.vote = null;
    return exile(s, w);
  }
  if (top.length === 0) {
    if (v.kind === 'sheriff') { mkOutcome('无人得票，本局无警长'); return endSheriffElection(s, null, '本局无警长'); }
    mkOutcome('无人得票，无人出局');
    s.day.vote = null;
    return noExile(s);
  }
  // 平票
  if (v.stage === 2) {
    if (v.kind === 'sheriff') { mkOutcome('再次平票，本局无警长'); return endSheriffElection(s, null, '本局无警长'); }
    mkOutcome('再次平票，本轮无人出局');
    s.day.vote = null;
    return noExile(s);
  }
  mkOutcome(`${top.map((x) => nm(s, x)).join('、')} 平票，进入平票处理`);
  s.day.tied = top;
  if (v.kind === 'sheriff') {
    const voters = v.voters.filter((x) => !top.includes(x));
    if (voters.length === 0) return endSheriffElection(s, null, '平票且无人可再投，本局无警长');
    s.day.vote = { kind: 'sheriff', stage: 2, candidates: top, voters, votes: {} };
    s.phase = 'SHERIFF_TIE_RESOLUTION';
  } else {
    const voters = aliveSeats(s).filter((x) => !top.includes(x));
    if (voters.length === 0) { s.day.vote = null; return noExile(s); }
    s.day.vote = { kind: 'day', stage: 2, candidates: top, voters, votes: {} };
    s.day.order = top.slice();
    s.day.idx = 0;
    s.day.tieStep = 'speech';
    s.phase = 'DAY_TIE_RESOLUTION';
  }
}

// ---- 发言 ----
function beginSpeech(s: GameState) {
  s.phase = 'DAY_SPEECH';
  s.day.direction = null;
  s.day.order = [];
  s.day.idx = 0;
  const sh = s.sheriff !== null && P(s, s.sheriff).alive ? s.sheriff : null;
  if (sh === null) {
    s.day.order = aliveSeats(s);
    log(s, '无警长，按座位号 1→12 顺序发言');
  }
}

function direction(s: GameState, uid: string, dir: 'cw' | 'ccw') {
  inPhase(s, 'DAY_SPEECH');
  const p = aliveActor(s, uid);
  need(s.sheriff === p.seat, 'NOT_ROLE', '只有警长可以选择发言顺序');
  need(s.day.direction === null, 'LOCKED', '已选择');
  s.day.direction = dir;
  const seats = aliveSeats(s);
  const after = (from: number, step: 1 | -1) => {
    const out: number[] = [];
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const x = ((from - 1 + step * i + MAX_PLAYERS * 2) % MAX_PLAYERS) + 1;
      if (seats.includes(x)) out.push(x);
    }
    return out; // 最后一位为警长本人
  };
  s.day.order = after(p.seat, dir === 'cw' ? 1 : -1);
  log(s, `警长选择${dir === 'cw' ? '顺时针' : '逆时针'}发言`);
}

function speech(s: GameState, uid: string, skip: boolean) {
  inPhase(s, 'DAY_SPEECH', 'DAY_TIE_RESOLUTION');
  const p = aliveActor(s, uid);
  if (s.phase === 'DAY_TIE_RESOLUTION') need(s.day.tieStep === 'speech', 'BAD_PHASE', '平票发言已结束');
  need(s.day.order.length > 0 && s.day.idx < s.day.order.length, 'BAD_PHASE', '现在不是发言环节');
  const cur = s.day.order[s.day.idx];
  need(skip || p.seat === cur, 'NOT_YOUR_TURN', '还没轮到你发言');
  s.day.idx += 1;
  if (s.day.idx < s.day.order.length) return;
  if (s.phase === 'DAY_TIE_RESOLUTION') { s.day.tieStep = 'vote'; return; }
  beginDayVote(s);
}

function call(s: GameState, uid: string, target: number) {
  inPhase(s, 'DAY_VOTING');
  const p = aliveActor(s, uid);
  need(s.sheriff === p.seat, 'NOT_ROLE', '只有警长可以归票');
  need(s.day.call === null, 'LOCKED', '已决定');
  if (target !== 0) aliveTarget(s, target);
  s.day.call = target;
  log(s, target ? `警长归票 ${nm(s, target)}（警长票 1.5）` : '警长不归票（警长票 1）');
  startDayBallot(s);
}

function beginDayVote(s: GameState) {
  s.phase = 'DAY_VOTING';
  s.day.vote = null;
  const sheriffAlive = s.sheriff !== null && P(s, s.sheriff).alive;
  if (sheriffAlive) { s.day.call = null; return; }
  s.day.call = 0;
  startDayBallot(s);
}
function startDayBallot(s: GameState) {
  const seats = aliveSeats(s);
  s.day.vote = { kind: 'day', stage: 1, candidates: seats, voters: seats, votes: {} };
}

function noExile(s: GameState) {
  log(s, '本轮无人出局');
  s.effects = [];
  settle(s, 'NIGHT');
}

/** 放逐：白痴先询问翻牌，其他角色直接出局，再处理猎人 / 警徽 */
function exile(s: GameState, seat: number) {
  const p = P(s, seat);
  if (p.role === 'idiot') {
    s.day.exiling = seat;
    s.phase = 'IDIOT_REVEAL';
    return;
  }
  kill(s, seat, 'vote', 'day');
  s.effects = deathEffects(s, [seat]);
  settle(s, 'NIGHT');
}

function flip(s: GameState, uid: string, doFlip: boolean) {
  inPhase(s, 'IDIOT_REVEAL');
  const p = actor(s, uid);
  need(s.day.exiling === p.seat, 'NOT_ROLE', '现在不是你翻牌');
  if (doFlip) { p.revealed = true; log(s, `${nm(s, p.seat)} 翻牌，身份是白痴`); }
  else log(s, `${nm(s, p.seat)} 选择不翻牌`);
  s.day.exiling = null;
  kill(s, p.seat, 'vote', 'day');
  s.effects = deathEffects(s, [p.seat]);
  settle(s, 'NIGHT');
}

export type { Phase };
