import { describe, expect, it } from 'vitest';
import { evaluateVictory, newRoom } from '../shared/engine/engine.ts';
import { privateView, publicView } from '../shared/engine/views.ts';
import { GameState, Player, Role } from '../shared/engine/types.ts';
import {
  act, DEFAULT_ROLES, everyoneVotes, fails, finishSpeech, lobby12, night, seatsOf, seeded, skipSheriff, startGame,
  toFirstDayVote, wolvesKill,
} from './helpers.ts';

describe('房间与开局', () => {
  it('第 13 名玩家无法加入、昵称唯一、重复加入幂等', () => {
    const s = lobby12();
    expect(fails(() => act(s, 13, { type: 'join', name: 'X' }), 'ROOM_FULL')).toBe(true);
    const s2 = newRoom('R', 'u1', 'A');
    expect(fails(() => act(s2, 2, { type: 'join', name: 'A' }), 'NAME_TAKEN')).toBe(true);
    expect(act(s2, 1, { type: 'join', name: 'A' }).players.length).toBe(1);
  });
  it('未满员或未全部准备不能开始；只有创建者能开始', () => {
    let s = newRoom('R', 'u1', 'A');
    for (let i = 2; i <= 12; i++) s = act(s, i, { type: 'join', name: 'P' + i });
    expect(fails(() => act(s, 1, { type: 'start' }), 'NOT_READY')).toBe(true);
    const full = lobby12();
    expect(fails(() => act(full, 2, { type: 'start' }), 'NOT_HOST')).toBe(true);
    const partial = newRoom('R', 'u1', 'A');
    expect(fails(() => act(partial, 1, { type: 'start' }), 'NOT_ENOUGH')).toBe(true);
  });
  it('正确分配 4 狼 4 神 4 民，且随机', () => {
    const counts = (s: GameState) => s.players.reduce((m, p) => ({ ...m, [p.role as Role]: (m[p.role as Role] ?? 0) + 1 }), {} as Record<string, number>);
    const a = act(lobby12(), 1, { type: 'start' }, seeded(1));
    const b = act(lobby12(), 1, { type: 'start' }, seeded(99));
    for (const s of [a, b]) expect(counts(s)).toEqual({ wolf: 4, seer: 1, witch: 1, hunter: 1, idiot: 1, villager: 4 });
    expect(a.players.map((p) => p.role)).not.toEqual(b.players.map((p) => p.role));
    expect(a.phase).toBe('ROLE_ASSIGNMENT');
  });
  it('全部确认身份后自动进入夜晚', () => {
    const s = startGame();
    expect(s.phase).toBe('NIGHT_WOLF');
    expect(s.round).toBe(1);
  });
});

describe('信息隔离', () => {
  it('公共视图和他人私人视图不含隐藏身份', () => {
    const s = startGame();
    const pub = JSON.stringify(publicView(s));
    expect(publicView(s).players.every((p) => p.role === null)).toBe(true);
    expect(pub).not.toContain('wolfVotes');
    expect(publicView(s).phase).toBe('NIGHT');
    const villager = privateView(s, 'u9')!;
    expect(villager.wolves).toBeNull();
    expect(villager.seerHistory).toBeNull();
    expect(villager.witch).toBeNull();
    expect(villager.todo).toBeNull();
    expect(privateView(s, 'u1')!.wolves!.length).toBe(4);
    expect(publicView(s).log.some((l) => l.text.includes('身份分配'))).toBe(false);
  });
  it('游戏结束后公开全部身份与完整记录', () => {
    let s = startGame();
    s = structuredClone(s);
    s.players.filter((p) => ['seer', 'witch', 'hunter'].includes(p.role!)).forEach((p) => { p.alive = false; });
    s = night(s, 8); // 杀死最后一个神职（白痴）
    expect(s.phase).toBe('GAME_OVER');
    const pub = publicView(s);
    expect(pub.players.every((p) => p.role !== null)).toBe(true);
    expect(pub.log.some((l) => l.text.includes('身份分配'))).toBe(true);
  });
});

describe('夜晚：狼人', () => {
  it('非狼人 / 已死亡狼人 / 错误阶段不能刀人', () => {
    const s = startGame();
    expect(fails(() => act(s, 9, { type: 'wolfKill', target: 1 }), 'NOT_ROLE')).toBe(true);
    expect(fails(() => act(s, 5, { type: 'seerCheck', target: 1 }), 'BAD_PHASE')).toBe(true);
    const d = structuredClone(s); d.players[0].alive = false;
    expect(fails(() => act(d, 1, { type: 'wolfKill', target: 9 }), 'DEAD')).toBe(true);
    expect(fails(() => act(s, 1, { type: 'wolfKill', target: 99 }), 'BAD_TARGET')).toBe(true);
  });
  it('刀口锁定，不能重复提交；可自刀', () => {
    let s = startGame();
    s = act(s, 1, { type: 'wolfKill', target: 2 });
    expect(fails(() => act(s, 1, { type: 'wolfKill', target: 3 }), 'LOCKED')).toBe(true);
    s = act(s, 2, { type: 'wolfKill', target: 2 });
    s = act(s, 3, { type: 'wolfKill', target: 2 });
    s = act(s, 4, { type: 'wolfKill', target: 9 });
    expect(s.night.knife).toBe(2);
    expect(s.phase).toBe('NIGHT_SEER');
  });
  it('平票时在最高票中选择，且不外泄刀口', () => {
    let s = startGame();
    s = act(s, 1, { type: 'wolfKill', target: 9 });
    s = act(s, 2, { type: 'wolfKill', target: 9 });
    s = act(s, 3, { type: 'wolfKill', target: 10 });
    s = act(s, 4, { type: 'wolfKill', target: 10 });
    expect([9, 10]).toContain(s.night.knife);
    expect(JSON.stringify(publicView(s))).not.toMatch(/刀口/);
    const hits = new Set<number>();
    for (let seed = 1; seed < 40; seed++) {
      let t = startGame();
      [9, 9, 10, 10].forEach((tg, i) => { t = act(t, i + 1, { type: 'wolfKill', target: tg }, seeded(seed)); });
      hits.add(t.night.knife!);
    }
    expect(hits.size).toBe(2);
  });
});

describe('夜晚：预言家', () => {
  it('只返回好人/狼人，每晚只能验一次，可验自己', () => {
    let s = wolvesKill(startGame(), 12);
    s = act(s, 5, { type: 'seerCheck', target: 1 });
    expect(s.seerHistory).toEqual([{ round: 1, seat: 1, isWolf: true }]);
    expect(fails(() => act(s, 5, { type: 'seerCheck', target: 2 }))).toBe(true);
    const s2 = act(wolvesKill(startGame(), 12), 5, { type: 'seerCheck', target: 5 });
    expect(s2.seerHistory[0].isWolf).toBe(false);
    const view = privateView(s2, 'u5')!;
    expect(JSON.stringify(view.seerHistory)).not.toMatch(/villager|hunter/);
  });
  it('预言家死亡则自动跳过', () => {
    let s = startGame(); s = structuredClone(s); s.players[4].alive = false;
    s = wolvesKill(s, 12);
    expect(s.phase).toBe('NIGHT_WITCH');
  });
});

describe('夜晚：女巫与结算', () => {
  const toWitch = (knife = 12) => {
    let s = wolvesKill(startGame(), knife);
    return act(s, 5, { type: 'seerCheck', target: 1 });
  };
  it('女巫可见刀口；解药救人 => 平安夜', () => {
    let s = toWitch(12);
    expect((privateView(s, 'u6')!.todo as { knife: number }).knife).toBe(12);
    s = act(s, 6, { type: 'witch', use: 'save' });
    expect(publicView(s).announce).toEqual({ round: 1, deaths: [] });
    expect(s.witch.heal).toBe(false);
  });
  it('不可自救；解药只能救当晚刀口', () => {
    const s = toWitch(6);
    expect(fails(() => act(s, 6, { type: 'witch', use: 'save' }), 'NO_SELF_SAVE')).toBe(true);
    expect((privateView(s, 'u6')!.todo as { canSave: boolean }).canSave).toBe(false);
  });
  it('同一晚不能双药（单次行动），已行动不可重复', () => {
    const s = toWitch(12);
    const after = act(s, 6, { type: 'witch', use: 'poison', target: 1 });
    expect(after.witch).toEqual({ heal: true, poison: false });
    expect(fails(() => act(after, 6, { type: 'witch', use: 'save' }))).toBe(true);
  });
  it('药剂不会重复使用；解药用后不再显示刀口', () => {
    let s = toFirstDayVote(); // 第 1 夜用了解药
    expect(s.witch.heal).toBe(false);
    s = everyoneVotes(s, () => 0); // 全员弃票 => 无人出局 => 第二夜
    expect(s.phase).toBe('NIGHT_WOLF');
    s = wolvesKill(s, 10);
    s = act(s, 5, { type: 'seerCheck', target: 2 });
    const todo = privateView(s, 'u6')!.todo as { knife: number | null; canSave: boolean };
    expect(todo.knife).toBeNull();
    expect(fails(() => act(s, 6, { type: 'witch', use: 'save' }), 'NO_POTION')).toBe(true);
    s = act(s, 6, { type: 'witch', use: 'poison', target: 2 });
    expect(s.witch.poison).toBe(false);
  });
  it('被救者可同时被毒死，只记录一次死亡', () => {
    let s = toWitch(12);
    // 狼刀 12，女巫毒 12（未救）=> 只死一次
    s = act(s, 6, { type: 'witch', use: 'poison', target: 12 });
    expect(publicView(s).announce!.deaths).toEqual([12]);
    expect(s.players[11].death!.cause).toBe('poison');
  });
  it('毒药可毒女巫自己；毒杀与刀口各自独立', () => {
    let s = toWitch(12);
    s = act(s, 6, { type: 'witch', use: 'poison', target: 6 });
    expect(publicView(s).announce!.deaths).toEqual([6, 12]);
  });
  it('女巫选择不使用药剂', () => {
    const s = act(toWitch(12), 6, { type: 'witch', use: 'none' });
    expect(s.witch).toEqual({ heal: true, poison: true });
    expect(s.announce!.deaths).toEqual([12]);
  });
  it('其他角色 / 死者不能用药', () => {
    const s = toWitch(12);
    expect(fails(() => act(s, 9, { type: 'witch', use: 'none' }), 'NOT_ROLE')).toBe(true);
  });
});

describe('猎人开枪', () => {
  it('被狼人刀杀可以开枪', () => {
    let s = night(startGame(), 7);
    expect(s.phase).toBe('HUNTER_SHOOTING');
    expect(fails(() => act(s, 9, { type: 'shoot', target: 1 }), 'NOT_ROLE')).toBe(true);
    s = act(s, 7, { type: 'shoot', target: 1 });
    expect(s.players[0].alive).toBe(false);
    expect(s.phase).toBe('SHERIFF_REGISTRATION');
  });
  it('被女巫毒死不能开枪（自动跳过）', () => {
    const s = night(startGame(), 12, { witch: { use: 'poison', target: 7 } });
    expect(s.phase).toBe('SHERIFF_REGISTRATION');
    expect(s.players[6].alive).toBe(false);
  });
  it('被投票放逐可以开枪，也可选择不开枪', () => {
    let s = toFirstDayVote();
    s = everyoneVotes(s, () => 7);
    expect(s.phase).toBe('HUNTER_SHOOTING');
    s = act(s, 7, { type: 'shoot', target: 0 });
    expect(s.phase).toBe('NIGHT_WOLF');
    expect(s.players.filter((p) => p.alive).length).toBe(11);
  });
  it('开枪可终结游戏；游戏结束后禁止行动', () => {
    let s = startGame(); s = structuredClone(s);
    s.players.filter((p) => p.role === 'wolf' && p.seat > 1).forEach((p) => { p.alive = false; });
    s = night(s, 7);
    s = act(s, 7, { type: 'shoot', target: 1 });
    expect(s.phase).toBe('GAME_OVER');
    expect(s.winner).toBe('good');
    expect(fails(() => act(s, 9, { type: 'vote', target: 1 }), 'GAME_OVER')).toBe(true);
  });
});

describe('白痴', () => {
  it('被放逐时询问翻牌：翻牌公开身份并出局', () => {
    let s = toFirstDayVote();
    s = everyoneVotes(s, () => 8);
    expect(s.phase).toBe('IDIOT_REVEAL');
    expect(s.players[7].alive).toBe(true);
    expect(fails(() => act(s, 9, { type: 'flip', flip: true }), 'NOT_ROLE')).toBe(true);
    s = act(s, 8, { type: 'flip', flip: true });
    expect(publicView(s).players[7].role).toBe('idiot');
    expect(s.players[7].alive).toBe(false);
    expect(s.phase).toBe('NIGHT_WOLF');
  });
  it('不翻牌则不公开身份，同样出局；夜间死亡正常出局', () => {
    let s = toFirstDayVote();
    s = everyoneVotes(s, () => 8);
    s = act(s, 8, { type: 'flip', flip: false });
    expect(publicView(s).players[7].role).toBeNull();
    expect(s.players[7].alive).toBe(false);
    const n = night(startGame(), 8);
    expect(n.players[7].alive).toBe(false);
  });
});

describe('警长', () => {
  const toRegistration = () => night(startGame(), 12, { witch: { use: 'save' } });
  it('竞选流程：报名→退水→投票→当选', () => {
    let s = toRegistration();
    for (const p of s.players) s = act(s, p.seat, { type: 'register', run: [9, 10, 11].includes(p.seat) });
    expect(s.phase).toBe('SHERIFF_WITHDRAWAL');
    s = act(s, 9, { type: 'withdraw', withdraw: false });
    s = act(s, 10, { type: 'withdraw', withdraw: false });
    s = act(s, 11, { type: 'withdraw', withdraw: true });
    expect(s.phase).toBe('SHERIFF_VOTING');
    expect(s.day.vote!.voters).not.toContain(11);
    expect(fails(() => act(s, 11, { type: 'vote', target: 9 }), 'NOT_ELIGIBLE')).toBe(true);
    expect(fails(() => act(s, 9, { type: 'vote', target: 9 }), 'BAD_TARGET')).toBe(true);
    s = everyoneVotes(s, (v) => (v === 9 ? 10 : 9));
    expect(s.sheriff).toBe(9);
    expect(s.phase).toBe('DAY_SPEECH');
  });
  it('精确平票流程', () => {
    let s = toRegistration();
    for (const p of s.players) s = act(s, p.seat, { type: 'register', run: [9, 10].includes(p.seat) });
    s = act(s, 9, { type: 'withdraw', withdraw: false });
    s = act(s, 10, { type: 'withdraw', withdraw: false });
    const voters = s.day.vote!.voters; // 12 人（无人退水）
    s = everyoneVotes(s, (v) => (v === 9 ? 10 : v === 10 ? 9 : voters.indexOf(v) % 2 === 0 ? 9 : 10));
    expect(s.phase).toBe('SHERIFF_TIE_RESOLUTION');
    expect(s.day.vote!.voters).not.toContain(9);
    expect(s.day.vote!.voters).not.toContain(10);
    s = everyoneVotes(s, (v) => (v % 2 ? 9 : 10));
    expect(s.sheriff).toBeNull(); // 再次平票
    expect(s.phase).toBe('DAY_SPEECH');
  });
  it('警长 1.5 票权重：归票生效，不归票为 1 票', () => {
    const base = (callTarget: number) => {
      let s = night(startGame(), 12, { witch: { use: 'save' } });
      for (const p of s.players) s = act(s, p.seat, { type: 'register', run: p.seat === 9 });
      s = act(s, 9, { type: 'withdraw', withdraw: false }); // 唯一候选人自动当选
      expect(s.sheriff).toBe(9);
      s = act(s, 9, { type: 'direction', dir: 'cw' });
      s = finishSpeech(s);
      expect(s.phase).toBe('DAY_VOTING');
      expect(s.day.vote).toBeNull();
      expect(fails(() => act(s, 10, { type: 'vote', target: 1 }), 'BAD_PHASE')).toBe(true);
      s = act(s, 9, { type: 'call', target: callTarget });
      return s;
    };
    // 9 号警长投 1；2 人投 2
    let s = base(1);
    s = everyoneVotes(s, (v) => (v === 9 ? 1 : v === 10 ? 2 : v === 11 ? 2 : 0));
    expect(s.lastVote!.tally['1']).toBe(1.5);
    expect(s.lastVote!.tally['2']).toBe(2);
    expect(s.players[1].alive).toBe(false); // 2 号被放逐
    s = base(0);
    s = everyoneVotes(s, (v) => (v === 9 ? 1 : v === 10 ? 1 : 0));
    expect(s.lastVote!.tally['1']).toBe(2);
  });
  it('警长归票 1.5 打破平局', () => {
    let s = night(startGame(), 12, { witch: { use: 'save' } });
    for (const p of s.players) s = act(s, p.seat, { type: 'register', run: p.seat === 9 });
    s = act(s, 9, { type: 'withdraw', withdraw: false });
    s = act(s, 9, { type: 'direction', dir: 'ccw' });
    expect(s.day.order[s.day.order.length - 1]).toBe(9);
    expect(s.day.order[0]).toBe(8);
    s = finishSpeech(s);
    s = act(s, 9, { type: 'call', target: 3 });
    s = everyoneVotes(s, (v) => (v === 9 ? 3 : v === 10 ? 4 : 0));
    expect(s.players[2].alive).toBe(false);
  });
  it('警长死亡可移交或撕毁警徽（先处理猎人）', () => {
    let s = night(startGame(), 12, { witch: { use: 'save' } });
    for (const p of s.players) s = act(s, p.seat, { type: 'register', run: p.seat === 7 });
    s = act(s, 7, { type: 'withdraw', withdraw: false });
    s = act(s, 7, { type: 'direction', dir: 'cw' });
    s = finishSpeech(s);
    s = act(s, 7, { type: 'call', target: 0 });
    s = everyoneVotes(s, (v) => (v === 7 ? 0 : 7));
    expect(s.phase).toBe('HUNTER_SHOOTING');
    s = act(s, 7, { type: 'shoot', target: 9 });
    expect(s.phase).toBe('SHERIFF_HANDOVER');
    expect(fails(() => act(s, 9, { type: 'handover', target: 9 }), 'NOT_ROLE')).toBe(true);
    const handed = act(s, 7, { type: 'handover', target: 10 });
    expect(handed.sheriff).toBe(10);
    const torn = act(s, 7, { type: 'handover', target: 0 });
    expect(torn.sheriff).toBeNull();
    expect(torn.phase).toBe('NIGHT_WOLF');
    expect(fails(() => act(s, 7, { type: 'handover', target: 7 }), 'BAD_TARGET')).toBe(true);
  });
  it('无人报名则无警长，按 1→12 发言', () => {
    let s = skipSheriff(night(startGame(), 12, { witch: { use: 'save' } }));
    expect(s.sheriff).toBeNull();
    expect(s.day.order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(fails(() => act(s, 3, { type: 'speechDone' }), 'NOT_YOUR_TURN')).toBe(true);
    s = act(s, 1, { type: 'speechDone' });
    expect(s.day.idx).toBe(1);
  });
});

describe('白天放逐投票与平票', () => {
  it('投票不可重复/更改，死者不能投，全部提交后才结算', () => {
    let s = toFirstDayVote();
    s = act(s, 1, { type: 'vote', target: 9 });
    expect(fails(() => act(s, 1, { type: 'vote', target: 10 }), 'LOCKED')).toBe(true);
    expect(publicView(s).lastVote).toBeNull();
    expect(publicView(s).voting!.voted).toEqual([1]);
    expect(JSON.stringify(publicView(s))).not.toMatch(/"votes"/);
    // 允许投自己
    s = act(s, 2, { type: 'vote', target: 2 });
  });
  it('平票：相关玩家发言→再投→再平票无人出局', () => {
    let s = toFirstDayVote();
    s = everyoneVotes(s, (v) => (v <= 6 ? 9 : 10));
    expect(s.phase).toBe('DAY_TIE_RESOLUTION');
    expect(fails(() => act(s, 1, { type: 'vote', target: 9 }), 'BAD_PHASE')).toBe(true);
    s = act(s, 9, { type: 'speechDone' });
    s = act(s, 10, { type: 'speechDone' });
    expect(s.day.vote!.voters).not.toContain(9);
    s = everyoneVotes(s, (v) => ([1, 2, 3, 4, 11].includes(v) ? 9 : 10));
    expect(s.phase).toBe('NIGHT_WOLF');
    expect(s.players.every((p) => p.alive)).toBe(true);
  });
  it('平票后重投产生结果', () => {
    let s = toFirstDayVote();
    s = everyoneVotes(s, (v) => (v <= 6 ? 9 : 10));
    s = act(s, 9, { type: 'speechDone' }); s = act(s, 10, { type: 'speechDone' });
    s = everyoneVotes(s, () => 10);
    expect(s.players[9].alive).toBe(false);
  });
});

describe('胜负判定（屠边）', () => {
  const mk = (aliveRoles: Role[]): Player[] =>
    DEFAULT_ROLES.map((r, i) => ({ seat: i + 1, uid: '', name: '', ready: true, alive: aliveRoles.length ? true : false, role: r, acked: true, revealed: false, death: null }))
      .map((p) => p);
  it('屠神：四神全灭，狼人胜', () => {
    const ps = mk(['wolf']); ps.filter((p) => ['seer', 'witch', 'hunter', 'idiot'].includes(p.role!)).forEach((p) => { p.alive = false; });
    expect(evaluateVictory(ps)).toMatchObject({ winner: 'wolf' });
  });
  it('屠民：四民全灭，狼人胜', () => {
    const ps = mk(['wolf']); ps.filter((p) => p.role === 'villager').forEach((p) => { p.alive = false; });
    expect(evaluateVictory(ps)).toMatchObject({ winner: 'wolf', reason: expect.stringContaining('屠民') });
  });
  it('狼人全灭，好人胜；同时满足时好人优先', () => {
    const ps = mk(['wolf']); ps.filter((p) => p.role === 'wolf').forEach((p) => { p.alive = false; });
    expect(evaluateVictory(ps)).toMatchObject({ winner: 'good' });
    ps.filter((p) => p.role === 'seer').forEach((p) => { p.alive = false; });
    ps.filter((p) => p.role !== 'wolf').forEach((p) => { p.alive = false; });
    expect(evaluateVictory(ps)!.winner).toBe('good');
  });
  it('还有狼人且各类都有存活，游戏继续', () => {
    expect(evaluateVictory(mk(['wolf']))).toBeNull();
  });
  it('夜间毒死最后一狼，立即好人胜', () => {
    let s = startGame(); s = structuredClone(s);
    s.players.filter((p) => p.role === 'wolf' && p.seat > 1).forEach((p) => { p.alive = false; });
    s = night(s, 12, { witch: { use: 'poison', target: 1 } });
    expect(s.winner).toBe('good');
    expect(s.phase).toBe('GAME_OVER');
  });
  it('屠神时猎人被刀也立即结束', () => {
    let s = startGame(); s = structuredClone(s);
    s.players.filter((p) => ['seer', 'witch', 'idiot'].includes(p.role!)).forEach((p) => { p.alive = false; });
    s = night(s, 7);
    expect(s.winner).toBe('wolf');
  });
});

describe('重开与幂等', () => {
  it('游戏结束后创建者可重开回到等待室', () => {
    let s = startGame(); s = structuredClone(s);
    s.players.filter((p) => ['seer', 'witch', 'hunter'].includes(p.role!)).forEach((p) => { p.alive = false; });
    s = night(s, 8);
    s = act(s, 1, { type: 'playAgain' });
    expect(s.phase).toBe('WAITING_ROOM');
    expect(s.players.length).toBe(12);
    expect(s.players.every((p) => p.alive && p.role === null && !p.ready)).toBe(true);
    expect(s.witch).toEqual({ heal: true, poison: true });
  });
  it('原始状态不被修改（纯函数）', () => {
    const s = startGame();
    const before = JSON.stringify(s);
    try { act(s, 1, { type: 'wolfKill', target: 99 }); } catch { /* ignore */ }
    act(s, 1, { type: 'wolfKill', target: 9 });
    expect(JSON.stringify(s)).toBe(before);
    expect(seatsOf(s, 'wolf').length).toBe(4);
  });
});
