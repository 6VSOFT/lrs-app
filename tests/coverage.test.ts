import { describe, expect, it } from 'vitest';
import { privateView, Todo } from '../shared/engine/views.ts';
import { GameState } from '../shared/engine/types.ts';
import { act, botAction, lobby12, seeded, uid } from './helpers.ts';

function play(seed: number): GameState {
  const rnd = seeded(seed);
  let s = act(lobby12(), 1, { type: 'start' }, rnd);
  while (s.phase !== 'GAME_OVER') {
    const todos = s.players.map((p) => ({ seat: p.seat, t: privateView(s, uid(p.seat))!.todo }))
      .filter((x): x is { seat: number; t: Todo } => !!x.t && !('locked' in x.t && (x.t as { locked: boolean }).locked));
    const w = todos[rnd(todos.length)];
    s = act(s, w.seat, botAction(w.t, rnd), rnd);
  }
  return s;
}

describe('流程覆盖统计（500 局模拟）', () => {
  it('各关键流程都被实际走到，且每局都正常结束', () => {
    const hit: Record<string, number> = {};
    const bump = (k: string) => { hit[k] = (hit[k] ?? 0) + 1; };
    let wolf = 0, good = 0, rounds = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const s = play(seed);
      const text = s.log.map((l) => l.text).join('\n');
      s.winner === 'wolf' ? wolf++ : good++;
      rounds += s.round;
      if (/当选警长/.test(text)) bump('警长当选');
      if (/平票，进入平票处理/.test(text)) bump('平票处理');
      if (/警徽移交|移交给/.test(text)) bump('警徽移交');
      if (/撕毁了警徽/.test(text)) bump('警徽撕毁');
      if (/猎人开枪带走/.test(text)) bump('猎人开枪');
      if (/选择不开枪/.test(text)) bump('猎人不开枪');
      if (/翻牌，身份是白痴/.test(text)) bump('白痴翻牌');
      if (/选择不翻牌/.test(text)) bump('白痴不翻牌');
      if (/解药救/.test(text)) bump('女巫解药');
      if (/毒药毒/.test(text)) bump('女巫毒药');
      if (/平安夜/.test(text)) bump('平安夜');
      if (/屠神/.test(text)) bump('屠神胜利');
      if (/屠民/.test(text)) bump('屠民胜利');
      if (/狼人全部出局/.test(text)) bump('好人胜利');
      if (/警长归票/.test(text)) bump('警长归票');
      if (/猎人.*死亡原因：poison|\(hunter\) 死亡，原因：poison/.test(text)) bump('猎人被毒(不能开枪)');
    }
    console.log(JSON.stringify({ games: 500, wolfWins: wolf, goodWins: good, avgRounds: +(rounds / 500).toFixed(1), ...hit }, null, 1));
    for (const k of ['警长当选', '平票处理', '警徽移交', '警徽撕毁', '猎人开枪', '白痴翻牌', '女巫解药', '女巫毒药', '屠神胜利', '屠民胜利', '好人胜利', '警长归票', '猎人被毒(不能开枪)']) {
      expect(hit[k] ?? 0, k).toBeGreaterThan(0);
    }
  });
});
