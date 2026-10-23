import { ReactNode, useEffect, useState } from 'react';

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-2xl bg-slate-800/80 border border-slate-700 p-4 ${className}`}>{children}</div>
);

type BtnProps = { children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: 'primary' | 'danger' | 'ghost' | 'good'; className?: string };
export const Btn = ({ children, onClick, disabled, tone = 'primary', className = '' }: BtnProps) => {
  const tones = {
    primary: 'bg-indigo-500 active:bg-indigo-600 text-white',
    danger: 'bg-rose-600 active:bg-rose-700 text-white',
    good: 'bg-emerald-600 active:bg-emerald-700 text-white',
    ghost: 'bg-slate-700 active:bg-slate-600 text-slate-100',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full min-h-[52px] rounded-xl px-4 text-lg font-semibold transition disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
};

export function Confirm({ text, onYes, onNo }: { text: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-slate-800 p-5 border border-slate-600 space-y-4">
        <p className="text-lg text-center">{text}</p>
        <p className="text-sm text-slate-400 text-center">提交后将锁定，不能更改</p>
        <div className="grid grid-cols-2 gap-3">
          <Btn tone="ghost" onClick={onNo}>再想想</Btn>
          <Btn onClick={onYes}>确认</Btn>
        </div>
      </div>
    </div>
  );
}

/** 选择座位：options 内可选；allowNone 提供“弃权/不选”按钮 */
export function SeatPicker({
  players, options, value, onChange, disabled,
}: {
  players: { seat: number; name: string; alive: boolean }[];
  options: number[]; value: number | null; onChange: (s: number) => void; disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {players.map((p) => {
        const ok = options.includes(p.seat) && !disabled;
        const sel = value === p.seat;
        return (
          <button
            key={p.seat}
            disabled={!ok}
            onClick={() => onChange(p.seat)}
            className={`min-h-[56px] rounded-xl border px-1 text-sm transition ${
              sel ? 'bg-indigo-500 border-indigo-300 text-white' : ok ? 'bg-slate-700 border-slate-600' : 'bg-slate-900 border-slate-800 text-slate-600'
            }`}
          >
            <div className="text-lg font-bold">{p.seat}号</div>
            <div className="truncate text-xs opacity-80">{p.name}</div>
          </button>
        );
      })}
    </div>
  );
}

export function useCountdown(seconds: number) {
  const [left, setLeft] = useState(seconds);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setLeft((x) => (x > 0 ? x - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [running]);
  return { left, running, start: () => { setLeft(seconds); setRunning(true); }, stop: () => setRunning(false) };
}

export const Pill = ({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'red' | 'amber' | 'indigo' }) => {
  const t = {
    slate: 'bg-slate-700 text-slate-200', green: 'bg-emerald-600/80 text-white', red: 'bg-rose-600/80 text-white',
    amber: 'bg-amber-500/90 text-slate-900', indigo: 'bg-indigo-500/80 text-white',
  }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${t}`}>{children}</span>;
};
