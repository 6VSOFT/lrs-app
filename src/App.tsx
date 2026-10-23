import { useEffect, useState } from 'react';
import { ApiError, Session, createRoom, forgetRoom, saveNick, savedNick } from './net';
import { Room } from './Room';
import { Btn, Card } from './ui';

const parseHash = () => {
  const m = location.hash.match(/#\/r\/([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : null;
};

export const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto max-w-md min-h-screen px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
);

export function App() {
  const [code, setCode] = useState<string | null>(parseHash());
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const f = () => setCode(parseHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  useEffect(() => {
    if (!code) { setSession(null); return; }
    if (session?.code === code) return;
    session?.destroy();
    setSession(new Session(code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  useEffect(() => () => session?.destroy(), [session]);

  const exit = () => { if (session) forgetRoom(session.code); session?.destroy(); setSession(null); location.hash = ''; };

  if (code && session) return <Room session={session} onExit={exit} />;
  return (
    <Home onEnter={(c) => { location.hash = `#/r/${c}`; }} />
  );
}

function Home({ onEnter }: { onEnter: (code: string) => void }) {
  const [name, setName] = useState(savedNick);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const create = async () => {
    if (!name.trim()) return setMsg('请先输入昵称');
    setBusy(true); setMsg(''); saveNick(name.trim());
    try { onEnter(await createRoom(name.trim())); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : '创建失败'); }
    setBusy(false);
  };
  return (
    <Shell>
      <div className="text-center pt-10 pb-6">
        <div className="text-6xl">🐺</div>
        <h1 className="text-3xl font-extrabold mt-3">狼人杀自动法官</h1>
        <p className="text-slate-400 mt-1">12 人 · 预女猎白 · 无需真人法官</p>
      </div>
      <Card className="space-y-3">
        <label className="text-sm text-slate-400">你的昵称（最多 10 字）</label>
        <input
          value={name} maxLength={10} onChange={(e) => setName(e.target.value)} placeholder="例如：小明"
          className="w-full rounded-xl bg-slate-900 border border-slate-600 px-4 py-3 text-lg outline-none focus:border-indigo-400"
        />
        <Btn onClick={create} disabled={busy}>{busy ? '创建中…' : '创建房间'}</Btn>
        <div className="text-center text-slate-500 text-sm">或加入已有房间</div>
        <input
          value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="输入 6 位房间代码" maxLength={6}
          className="w-full rounded-xl bg-slate-900 border border-slate-600 px-4 py-3 text-lg tracking-widest text-center outline-none focus:border-indigo-400"
        />
        <Btn tone="ghost" disabled={code.length < 6} onClick={() => { saveNick(name.trim()); onEnter(code); }}>加入房间</Btn>
        {msg && <p className="text-rose-400 text-center">{msg}</p>}
      </Card>
      <p className="text-xs text-slate-500 text-center mt-6">身份与规则结算全部由后端（Netlify Functions + Blobs）负责：创建者和其他玩家一样，只能看到自己的身份。</p>
    </Shell>
  );
}
