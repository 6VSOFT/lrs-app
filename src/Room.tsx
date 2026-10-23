import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { Action } from '@engine/types';
import { ROLE_NAMES } from '@engine/types';
import type { PrivateView, PublicView, Todo } from '@engine/views';
import { ApiError, Session, saveNick, savedNick } from './net';
import { Shell } from './App';
import { Btn, Card, Confirm, Pill, SeatPicker, useCountdown } from './ui';

const PHASE_NAMES: Record<string, string> = {
  WAITING_ROOM: '等待室', ROLE_ASSIGNMENT: '查看身份', NIGHT: '黑夜', DAY_ANNOUNCEMENT: '天亮了', DAY_SPEECH: '白天发言',
  SHERIFF_REGISTRATION: '警长竞选 · 报名', SHERIFF_WITHDRAWAL: '警长竞选 · 退水', SHERIFF_VOTING: '警长竞选 · 投票',
  SHERIFF_TIE_RESOLUTION: '警长竞选 · 平票重投', DAY_VOTING: '放逐投票', DAY_TIE_RESOLUTION: '放逐 · 平票处理',
  IDIOT_REVEAL: '白痴翻牌', HUNTER_SHOOTING: '猎人开枪', SHERIFF_HANDOVER: '警徽移交', GAME_OVER: '游戏结束',
};
const ROLE_DESC: Record<string, string> = {
  wolf: '每晚与队友共同选择击杀目标，可自刀。', seer: '每晚查验一名玩家是“好人”还是“狼人”。',
  witch: '一瓶解药、一瓶毒药；同夜只能用一种，不可自救。', hunter: '被狼人刀杀或被放逐时可开枪带走一人；被毒杀不能开枪。',
  idiot: '被放逐时可选择翻牌亮明身份（随后出局）。', villager: '没有技能，靠发言与投票找出狼人。',
};

type Run = (a: Action) => Promise<void>;

export function Room({ session, onExit }: { session: Session; onExit: () => void }) {
  const [snap, setSnap] = useState(session.snap);
  useEffect(() => session.subscribe(setSnap), [session]);
  const [toast, setToast] = useState('');
  const [waited, setWaited] = useState(false);
  const busy = useRef(false);
  const code = session.code;
  const online = new Set(snap.online);
  const run: Run = async (a) => {
    if (busy.current) return;
    busy.current = true;
    try { await session.act(a); } catch (e) { setToast(e instanceof ApiError ? e.message : '操作失败'); }
    busy.current = false;
  };
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { const t = setTimeout(() => setWaited(true), 12000); return () => clearTimeout(t); }, []);

  const { pub, priv } = snap;
  let body;
  if (snap.gone) body = (
    <Card className="mt-10 text-center space-y-3"><p>找不到房间 {code}，请确认代码是否正确。</p><Btn onClick={onExit}>返回首页</Btn></Card>
  );
  else if (!pub) body = (
    <Card className="mt-10 text-center space-y-3">
      <p className="text-slate-300">{waited ? `连接失败（房间 ${code}）` : '连接中…'}</p>
      {waited && <p className="text-sm text-slate-400">请检查网络后重试。</p>}
      <Btn tone="ghost" onClick={onExit}>返回首页</Btn>
    </Card>
  );
  else if (!priv) body = pub.phase === 'WAITING_ROOM'
    ? <JoinForm code={code} pub={pub} run={run} onExit={onExit} />
    : <Card className="mt-10 text-center space-y-3"><p>游戏已经开始，你不在这个房间的玩家名单中。</p><Btn onClick={onExit}>返回首页</Btn></Card>;
  else if (pub.phase === 'WAITING_ROOM') body = <Lobby pub={pub} priv={priv} run={run} online={online} onExit={onExit} />;
  else body = <Game pub={pub} priv={priv} run={run} online={online} />;

  return (
    <Shell>
      {snap.status === 'offline' && <div className="mt-2 rounded-xl bg-rose-500/20 border border-rose-500/40 px-3 py-2 text-xs text-rose-200">网络连接中断，正在重连…（你的座位会保留）</div>}
      {body}
      {toast && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-rose-600 text-white px-4 py-2 rounded-xl shadow-lg">{toast}</div>}
    </Shell>
  );
}

function JoinForm({ code, pub, run, onExit }: { code: string; pub: PublicView; run: Run; onExit: () => void }) {
  const [name, setName] = useState(savedNick);
  return (
    <Card className="mt-10 space-y-3">
      <h2 className="text-xl font-bold">加入房间 {code}</h2>
      <p className="text-slate-400 text-sm">当前 {pub.players.length}/12 人</p>
      <input value={name} maxLength={10} onChange={(e) => setName(e.target.value)} placeholder="你的昵称"
        className="w-full rounded-xl bg-slate-900 border border-slate-600 px-4 py-3 text-lg outline-none" />
      <Btn disabled={!name.trim() || pub.players.length >= 12} onClick={() => { saveNick(name.trim()); run({ type: 'join', name: name.trim() }); }}>
        {pub.players.length >= 12 ? '房间已满' : '加入'}
      </Btn>
      <Btn tone="ghost" onClick={onExit}>返回</Btn>
    </Card>
  );
}

function Lobby({ pub, priv, run, online, onExit }: { pub: PublicView; priv: PrivateView; run: Run; online: Set<number>; onExit: () => void }) {
  const [qr, setQr] = useState('');
  const link = `${location.origin}${location.pathname}#/r/${pub.code}`;
  useEffect(() => { QRCode.toDataURL(link, { margin: 1, width: 220 }).then(setQr).catch(() => setQr('')); }, [link]);
  const me = pub.players.find((p) => p.seat === priv.seat)!;
  const isHost = pub.hostSeat === priv.seat;
  const full = pub.players.length === 12;
  const allReady = full && pub.players.every((p) => p.ready);
  const seats = Array.from({ length: 12 }, (_, i) => pub.players.find((p) => p.seat === i + 1) ?? null);
  return (
    <div className="space-y-4 pt-4">
      <Card className="text-center space-y-2">
        <div className="text-sm text-slate-400">房间代码</div>
        <div className="text-4xl font-extrabold tracking-[0.3em]">{pub.code}</div>
        {qr && <img src={qr} alt="QR" className="mx-auto rounded-xl bg-white p-1" width={180} height={180} />}
        <button className="text-indigo-300 text-sm underline" onClick={() => navigator.clipboard?.writeText(link)}>复制邀请链接</button>
      </Card>
      <Card>
        <div className="flex justify-between mb-2"><b>玩家 {pub.players.length}/12</b><span className="text-sm text-slate-400">全员准备后由创建者开始</span></div>
        <div className="grid grid-cols-3 gap-2">
          {seats.map((p, i) => (
            <div key={i} className={`rounded-xl border p-2 text-center min-h-[64px] ${p ? 'border-slate-600 bg-slate-700' : 'border-dashed border-slate-700 text-slate-600'}`}>
              <div className="font-bold">{i + 1}号</div>
              {p ? (
                <>
                  <div className="truncate text-sm">{p.name}{p.seat === pub.hostSeat ? ' 👑' : ''}{p.seat === priv.seat ? '（我）' : ''}</div>
                  <div className="text-xs">{p.ready ? <span className="text-emerald-400">已准备</span> : <span className="text-slate-400">未准备</span>}
                    {!online.has(p.seat) && p.seat !== priv.seat && <span className="text-amber-400"> · 离线</span>}</div>
                </>
              ) : <div className="text-xs">空位</div>}
            </div>
          ))}
        </div>
      </Card>
      <Btn tone={me.ready ? 'ghost' : 'good'} onClick={() => run({ type: 'ready', ready: !me.ready })}>{me.ready ? '取消准备' : '准备'}</Btn>
      {isHost && <Btn disabled={!allReady} onClick={() => run({ type: 'start' })}>{allReady ? '开始游戏' : `等待全员准备（${pub.players.filter((p) => p.ready).length}/12）`}</Btn>}
      <Btn tone="ghost" onClick={async () => { await run({ type: 'leave' }); onExit(); }}>离开房间</Btn>
    </div>
  );
}

function RoleCard({ role }: { role: string }) {
  return (
    <div className="text-center py-3">
      <div className="text-5xl mb-2">{({ wolf: '🐺', seer: '🔮', witch: '🧪', hunter: '🔫', idiot: '🤡', villager: '🧑‍🌾' } as Record<string, string>)[role]}</div>
      <div className="text-3xl font-extrabold">{ROLE_NAMES[role as keyof typeof ROLE_NAMES]}</div>
      <p className="text-slate-400 text-sm mt-2">{ROLE_DESC[role]}</p>
    </div>
  );
}

function Game({ pub, priv, run, online }: { pub: PublicView; priv: PrivateView; run: Run; online: Set<number> }) {
  const [showRole, setShowRole] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const me = pub.players.find((p) => p.seat === priv.seat)!;
  const aliveN = pub.players.filter((p) => p.alive).length;
  const over = pub.phase === 'GAME_OVER';

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-400">房间 {pub.code}</span>
        <span>存活 {aliveN}/12</span>
        <button className="rounded-full bg-slate-700 px-3 py-1" onClick={() => setShowRole((x) => !x)}>
          {me.alive ? '' : '💀 '}{showRole ? ROLE_NAMES[priv.role!] : '查看身份'}
        </button>
      </div>
      {showRole && priv.role && <Card><RoleCard role={priv.role} /></Card>}
      <div className={`rounded-2xl p-4 text-center ${pub.phase === 'NIGHT' ? 'bg-indigo-950 border border-indigo-800' : 'bg-slate-800 border border-slate-700'}`}>
        <div className="text-xs text-slate-400">{pub.round > 0 ? `第 ${pub.round} ${pub.phase === 'NIGHT' ? '夜' : '天'}` : ''}</div>
        <div className="text-2xl font-bold">{pub.phase === 'NIGHT' ? '🌙 ' : over ? '🏁 ' : '☀️ '}{PHASE_NAMES[pub.phase]}</div>
        {!me.alive && !over && <div className="text-rose-300 text-sm mt-1">你已出局，可继续观战</div>}
      </div>

      {pub.announce && pub.phase !== 'NIGHT' && !over && (
        <Card className="text-center">
          昨晚：{pub.announce.deaths.length ? <b className="text-rose-300">{pub.announce.deaths.map((s) => `${s}号`).join('、')} 出局</b> : <b className="text-emerald-300">平安夜</b>}
        </Card>
      )}

      {over ? <Over pub={pub} run={run} isHost={pub.hostSeat === priv.seat} /> : <ActionPanel pub={pub} priv={priv} run={run} />}

      {pub.lastVote && !over && <VoteResult v={pub.lastVote} />}

      <Players pub={pub} priv={priv} online={online} />
      <Btn tone="ghost" onClick={() => setShowLog((x) => !x)}>{showLog ? '收起游戏记录' : '游戏记录'}</Btn>
      {showLog && <LogList pub={pub} />}
    </div>
  );
}

function Players({ pub, priv, online }: { pub: PublicView; priv: PrivateView; online: Set<number> }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {pub.players.map((p) => (
        <div key={p.seat} className={`rounded-xl border p-2 text-center text-xs ${p.alive ? 'bg-slate-800 border-slate-600' : 'bg-slate-900 border-slate-800 text-slate-600 line-through'} ${p.seat === priv.seat ? 'ring-2 ring-indigo-400' : ''}`}>
          <div className="text-base font-bold">{p.seat}{p.sheriff ? '🎖️' : ''}</div>
          <div className="truncate">{p.name}</div>
          {!p.alive && <div className="no-underline">💀</div>}
          {p.role && <div className="text-amber-300">{ROLE_NAMES[p.role]}</div>}
          {p.alive && !online.has(p.seat) && p.seat !== priv.seat && <div className="text-amber-400">离线</div>}
          {pub.waiting.includes(p.seat) && <div className="text-sky-300">待操作</div>}
        </div>
      ))}
    </div>
  );
}

function VoteResult({ v }: { v: NonNullable<PublicView['lastVote']> }) {
  return (
    <Card className="space-y-1 text-sm">
      <b>{v.title}结果</b>
      <div>{Object.entries(v.tally).filter(([, n]) => n > 0).map(([k, n]) => `${k}号 ${n} 票`).join('　') || '无人得票'}</div>
      <div className="text-slate-400">{v.ballots.map((b) => `${b.voter}→${b.target || '弃'}`).join('  ')}</div>
      <div className="text-amber-300">{v.outcome}</div>
    </Card>
  );
}

function LogList({ pub }: { pub: PublicView }) {
  return (
    <Card className="text-sm space-y-1 max-h-96 overflow-auto">
      {pub.log.map((l, i) => <div key={i} className={l.secret ? 'text-amber-300' : ''}><span className="text-slate-500">[{l.round}]</span> {l.text}</div>)}
    </Card>
  );
}

function Over({ pub, run, isHost }: { pub: PublicView; run: Run; isHost: boolean }) {
  return (
    <div className="space-y-3">
      <Card className="text-center space-y-1">
        <div className="text-3xl font-extrabold">{pub.winner === 'wolf' ? '🐺 狼人阵营获胜' : '🎉 好人阵营获胜'}</div>
        <div className="text-slate-300">{pub.winReason}</div>
      </Card>
      <Card>
        <b>完整身份</b>
        <div className="grid grid-cols-2 gap-1 mt-2 text-sm">
          {pub.players.map((p) => (
            <div key={p.seat} className={p.alive ? '' : 'text-slate-500'}>{p.seat}号 {p.name} — <b className={p.role === 'wolf' ? 'text-rose-300' : 'text-emerald-300'}>{p.role ? ROLE_NAMES[p.role] : '?'}</b></div>
          ))}
        </div>
      </Card>
      <LogList pub={pub} />
      {isHost ? <Btn onClick={() => run({ type: 'playAgain' })}>再来一局（回到等待室）</Btn> : <p className="text-center text-slate-400 text-sm">等待创建者重新开局</p>}
    </div>
  );
}

function Picked({ options, pub, label, noneLabel, onSubmit, locked, lockedText, extra }: {
  options: number[]; pub: PublicView; label: string; noneLabel?: string; locked?: boolean; lockedText?: string;
  onSubmit: (t: number) => void; extra?: React.ReactNode;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const [ask, setAsk] = useState(false);
  if (locked) return <Card className="text-center"><Pill tone="green">已锁定</Pill><p className="mt-2">{lockedText ?? '等待其他玩家…'}</p></Card>;
  return (
    <Card className="space-y-3">
      <b>{label}</b>
      {extra}
      <SeatPicker players={pub.players} options={options} value={sel} onChange={setSel} />
      <Btn disabled={sel === null} onClick={() => setAsk(true)}>确认选择{sel ? `（${sel}号）` : ''}</Btn>
      {noneLabel && <Btn tone="ghost" onClick={() => onSubmit(0)}>{noneLabel}</Btn>}
      {ask && sel !== null && <Confirm text={`确认选择 ${sel} 号？`} onYes={() => { setAsk(false); onSubmit(sel); }} onNo={() => setAsk(false)} />}
    </Card>
  );
}

function YesNo({ q, yes, no, onPick, locked }: { q: string; yes: string; no: string; onPick: (v: boolean) => void; locked?: boolean }) {
  if (locked) return <Card className="text-center"><Pill tone="green">已锁定</Pill><p className="mt-2">等待其他玩家…</p></Card>;
  return <Card className="space-y-3"><b>{q}</b><Btn onClick={() => onPick(true)}>{yes}</Btn><Btn tone="ghost" onClick={() => onPick(false)}>{no}</Btn></Card>;
}

function SpeechTimer() {
  const t = useCountdown(60);
  return (
    <div className="flex items-center gap-3 justify-center text-slate-300">
      <span className="text-2xl tabular-nums">{String(Math.floor(t.left / 60)).padStart(1, '0')}:{String(t.left % 60).padStart(2, '0')}</span>
      <button className="rounded-full bg-slate-700 px-3 py-1 text-sm" onClick={t.running ? t.stop : t.start}>{t.running ? '暂停' : '开始计时'}</button>
      <span className="text-xs text-slate-500">仅供参考</span>
    </div>
  );
}

function ActionPanel({ pub, priv, run }: { pub: PublicView; priv: PrivateView; run: Run }) {
  const t: Todo | null = priv.todo;
  const [confirm, setConfirm] = useState<null | { text: string; a: Action }>(null);
  const ask = (text: string, a: Action) => setConfirm({ text, a });
  const dlg = confirm && <Confirm text={confirm.text} onYes={() => { run(confirm.a); setConfirm(null); }} onNo={() => setConfirm(null)} />;
  const me = pub.players.find((p) => p.seat === priv.seat)!;

  const wait = (() => {
    if (pub.phase === 'NIGHT') return me.alive ? '天黑请闭眼…请保持安静，等待天亮。' : '夜晚进行中…';
    const who = pub.waiting.length ? `等待：${pub.waiting.map((s) => s + '号').join('、')}` : '';
    if (pub.phase === 'DAY_SPEECH') {
      if (!pub.speech?.order.length) return `等待警长 ${pub.sheriff}号 选择发言顺序…`;
      return `当前发言：${pub.speech.order[pub.speech.idx]}号`;
    }
    if (pub.phase === 'DAY_VOTING' && pub.voting?.call === null) return `等待警长 ${pub.sheriff}号 归票…`;
    if (pub.phase === 'DAY_TIE_RESOLUTION' && pub.speech) return `平票发言：${pub.speech.order[pub.speech.idx]}号（${pub.speech.order.join('、')}号 平票）`;
    if (['HUNTER_SHOOTING', 'IDIOT_REVEAL', 'SHERIFF_HANDOVER'].includes(pub.phase)) return `等待 ${pub.actorSeat}号 操作…`;
    return who || '等待中…';
  })();

  let main: React.ReactNode = null;
  if (t) {
    switch (t.kind) {
      case 'ack':
        main = (
          <Card className="space-y-3">
            <b className="block text-center">你的身份</b>
            <RoleCard role={priv.role!} />
            {priv.wolves && <p className="text-center text-rose-300">狼队友：{priv.wolves.filter((w) => w.seat !== priv.seat).map((w) => `${w.seat}号${w.name}`).join('、')}</p>}
            <Btn onClick={() => run({ type: 'ack' })}>我已记住身份</Btn>
          </Card>
        );
        break;
      case 'wolf':
        main = (
          <Picked pub={pub} options={t.options} locked={t.locked} label="🐺 选择今晚击杀目标（可自刀）"
            lockedText={`你选择了 ${t.myPick}号，等待其他狼人…`}
            extra={<p className="text-sm text-slate-400">狼队友：{priv.wolves!.map((w) => `${w.seat}号${w.name}${priv.teamVotes?.[w.seat] ? `(已选${priv.teamVotes[w.seat]})` : ''}`).join('、')}</p>}
            onSubmit={(x) => run({ type: 'wolfKill', target: x })} />
        );
        break;
      case 'seer':
        main = <Picked pub={pub} options={t.options} label="🔮 选择今晚查验的玩家" onSubmit={(x) => run({ type: 'seerCheck', target: x })} />;
        break;
      case 'witch':
        main = <WitchPanel pub={pub} t={t} run={run} />;
        break;
      case 'register':
        main = <YesNo locked={t.locked} q="🎖️ 是否竞选警长？" yes="上警" no="不上警" onPick={(v) => run({ type: 'register', run: v })} />;
        break;
      case 'withdraw':
        main = <YesNo locked={t.locked} q="你是警长候选人，是否退水？" yes="继续竞选" no="退水" onPick={(v) => run({ type: 'withdraw', withdraw: !v })} />;
        break;
      case 'vote':
        main = (
          <Picked pub={pub} options={t.options} locked={t.locked} label="🗳️ 请投票（提交前他人不可见）" noneLabel="弃票"
            lockedText={`你投给了 ${t.myVote ? t.myVote + '号' : '弃票'}，等待其他玩家…`}
            onSubmit={(x) => run({ type: 'vote', target: x })} />
        );
        break;
      case 'call':
        main = <Picked pub={pub} options={t.options} label="🎖️ 警长归票：建议放逐谁？（归票后警长票 1.5）" noneLabel="不归票（警长票 1）" onSubmit={(x) => run({ type: 'call', target: x })} />;
        break;
      case 'direction':
        main = (
          <Card className="space-y-3"><b>🎖️ 选择发言顺序</b>
            <Btn onClick={() => run({ type: 'direction', dir: 'cw' })}>顺时针（座位号递增）</Btn>
            <Btn tone="ghost" onClick={() => run({ type: 'direction', dir: 'ccw' })}>逆时针（座位号递减）</Btn></Card>
        );
        break;
      case 'speech':
        main = <Card className="space-y-3"><b className="block text-center text-xl">🎤 轮到你发言</b><SpeechTimer /><Btn onClick={() => run({ type: 'speechDone' })}>发言完毕</Btn></Card>;
        break;
      case 'flip':
        main = (
          <Card className="space-y-3"><b>你被放逐了！是否翻牌亮出白痴身份？</b>
            <Btn onClick={() => ask('确认翻牌？你将公开身份并出局', { type: 'flip', flip: true })}>翻牌</Btn>
            <Btn tone="ghost" onClick={() => ask('确认不翻牌？你将出局', { type: 'flip', flip: false })}>不翻牌</Btn></Card>
        );
        break;
      case 'shoot':
        main = <Picked pub={pub} options={t.options} label="🔫 猎人开枪：选择带走的玩家" noneLabel="不开枪" onSubmit={(x) => run({ type: 'shoot', target: x })} />;
        break;
      case 'handover':
        main = <Picked pub={pub} options={t.options} label="🎖️ 你已出局：移交警徽给谁？" noneLabel="撕毁警徽" onSubmit={(x) => run({ type: 'handover', target: x })} />;
        break;
    }
  }

  return (
    <div className="space-y-3">
      {main}
      {priv.seerHistory && priv.seerHistory.length > 0 && (
        <Card className="text-sm"><b>🔮 查验记录</b>
          {priv.seerHistory.map((h) => <div key={h.round}>第{h.round}夜：{h.seat}号 — <b className={h.isWolf ? 'text-rose-300' : 'text-emerald-300'}>{h.isWolf ? '狼人' : '好人'}</b></div>)}
        </Card>
      )}
      {priv.witch && <Card className="text-sm">🧪 解药：{priv.witch.heal ? '有' : '已用'}　毒药：{priv.witch.poison ? '有' : '已用'}</Card>}
      {!t && wait && (
        <Card className="text-center text-slate-300 space-y-2">
          <div>{wait}</div>
          {(pub.phase === 'DAY_SPEECH' || pub.phase === 'DAY_TIE_RESOLUTION') && pub.speech && pub.speech.order.length > 0 && me.alive && (
            <button className="text-xs text-slate-500 underline" onClick={() => ask('当前发言者无法操作，确认跳过？', { type: 'speechSkip' })}>跳过当前发言者</button>
          )}
        </Card>
      )}
      {pub.speech && pub.speech.order.length > 0 && (
        <Card className="text-sm">发言顺序{pub.speech.direction ? (pub.speech.direction === 'cw' ? '（顺时针）' : '（逆时针）') : ''}：
          {pub.speech.order.map((s, i) => <span key={s} className={i === pub.speech!.idx ? 'text-amber-300 font-bold' : i < pub.speech!.idx ? 'text-slate-600' : ''}> {s}号</span>)}
        </Card>
      )}
      {dlg}
    </div>
  );
}

function WitchPanel({ pub, t, run }: { pub: PublicView; t: Extract<Todo, { kind: 'witch' }>; run: Run }) {
  const [mode, setMode] = useState<'none' | 'poison'>('none');
  const [sel, setSel] = useState<number | null>(null);
  const [ask, setAsk] = useState<null | { text: string; a: Action }>(null);
  return (
    <Card className="space-y-3">
      <b>🧪 女巫</b>
      {t.knife !== null ? <p>今晚被刀的是 <b className="text-rose-300">{t.knife}号</b></p> : <p className="text-slate-400">你已使用过解药，不再获知刀口。</p>}
      {t.knife !== null && <Btn tone="good" disabled={!t.canSave} onClick={() => setAsk({ text: `对 ${t.knife}号 使用解药？`, a: { type: 'witch', use: 'save' } })}>{t.canSave ? '使用解药' : '解药不可用（不可自救）'}</Btn>}
      <Btn tone="danger" disabled={!t.canPoison} onClick={() => setMode(mode === 'poison' ? 'none' : 'poison')}>{t.canPoison ? '使用毒药…' : '毒药已用完'}</Btn>
      {mode === 'poison' && (
        <>
          <SeatPicker players={pub.players} options={t.options} value={sel} onChange={setSel} />
          <Btn tone="danger" disabled={sel === null} onClick={() => setAsk({ text: `对 ${sel}号 使用毒药？`, a: { type: 'witch', use: 'poison', target: sel! } })}>确认毒杀 {sel ?? ''}号</Btn>
        </>
      )}
      <Btn tone="ghost" onClick={() => setAsk({ text: '今晚不使用任何药剂？', a: { type: 'witch', use: 'none' } })}>不使用药剂</Btn>
      {ask && <Confirm text={ask.text} onYes={() => { run(ask.a); setAsk(null); }} onNo={() => setAsk(null)} />}
    </Card>
  );
}
