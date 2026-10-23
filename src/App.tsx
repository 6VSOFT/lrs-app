import { useEffect, useState } from 'react';
import { createRoom, ApiError } from './lib/api';
import { configured, ensureSession } from './lib/supabase';
import { Room } from './Room';
import { Btn, Card } from './ui';

const parseHash = () => {
  const m = location.hash.match(/#\/r\/([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : null;
};

export function App() {
  const [uid, setUid] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [code, setCode] = useState<string | null>(parseHash());

  useEffect(() => {
    if (!configured) return;
    ensureSession().then(setUid).catch((e) => setErr(String(e.message ?? e)));
  }, []);
  useEffect(() => {
    const f = () => setCode(parseHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  if (!configured)
    return (
      <Shell>
        <Card>
          <h1 className="text-xl font-bold mb-2">尚未配置 Supabase</h1>
          <p className="text-slate-300 text-sm">请复制 .env.example 为 .env.local 并填入 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY，详见 README。</p>
        </Card>
      </Shell>
    );
  if (err) return <Shell><Card><p className="text-rose-400">{err}</p><p className="text-sm text-slate-400 mt-2">请确认 Supabase 已开启匿名登录（Authentication → Sign In / Providers → Anonymous）。</p></Card></Shell>;
  if (!uid) return <Shell><p className="text-center text-slate-400 mt-20">连接中…</p></Shell>;
  if (code) return <Room code={code} uid={uid} onExit={() => { location.hash = ''; setCode(null); }} />;
  return <Home onEnter={(c) => { location.hash = `#/r/${c}`; }} />;
}

export const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto max-w-md min-h-screen px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
);

function Home({ onEnter }: { onEnter: (code: string) => void }) {
  const [name, setName] = useState(() => { try { return localStorage.getItem('nick') ?? ''; } catch { return ''; } });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const save = () => { try { localStorage.setItem('nick', name.trim()); } catch { /* ignore */ } };

  const create = async () => {
    if (!name.trim()) return setMsg('请先输入昵称');
    setBusy(true); setMsg(''); save();
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
        <Btn onClick={create} disabled={busy}>创建房间</Btn>
        <div className="text-center text-slate-500 text-sm">或加入已有房间</div>
        <input
          value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="输入 6 位房间代码" maxLength={6}
          className="w-full rounded-xl bg-slate-900 border border-slate-600 px-4 py-3 text-lg tracking-widest text-center outline-none focus:border-indigo-400"
        />
        <Btn tone="ghost" disabled={code.length < 6} onClick={() => { save(); onEnter(code); }}>加入房间</Btn>
        {msg && <p className="text-rose-400 text-center">{msg}</p>}
      </Card>
      <p className="text-xs text-slate-500 text-center mt-6">12 位玩家各用手机加入同一房间。系统自动发牌、主持夜晚、统计投票、判定胜负。</p>
    </Shell>
  );
}
