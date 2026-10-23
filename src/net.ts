// 客户端网络层：通过 Netlify Function 与可信后端通信（长轮询获取视图，POST 提交操作）。
// 完整状态（含全部身份）只在后端；本机只缓存「公共视图 + 自己的私人视图」。
import type { Action } from '@engine/types';
import type { PrivateView, PublicView } from '@engine/views';
import { newSecret } from '@shared/hostcore';

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export type Status = 'connecting' | 'connected' | 'offline';
export interface Snapshot {
  pub: PublicView | null;
  priv: PrivateView | null;
  online: number[];
  status: Status;
  version: number;
  gone: boolean; // 房间不存在
}

const API = '/.netlify/functions/game';
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 隐私模式等 */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* */ } },
};

/** 本机私密令牌：你的身份凭证，后端只保存它的哈希 */
export function mySecret(): string {
  let s = store.get('lrs-secret');
  if (!s) { s = newSecret(); store.set('lrs-secret', s); }
  return s;
}
export const savedNick = () => store.get('lrs-nick') ?? '';
export const saveNick = (n: string) => store.set('lrs-nick', n);
export const forgetRoom = (code: string) => store.del('lrs-view-' + code);

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await fetch(API, { method: 'POST', headers: { Authorization: 'Bearer ' + mySecret(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new ApiError('NETWORK', '网络异常，请稍后重试'); }
  let j: Record<string, unknown> = {};
  try { j = await r.json(); } catch { /* */ }
  if (!r.ok || j.ok === false) throw new ApiError(String(j.code ?? 'ERR'), String(j.message ?? '请求失败'));
  return j;
}

export async function createRoom(name: string): Promise<string> {
  return (await post({ op: 'create', name })).code as string;
}

type Listener = (s: Snapshot) => void;

export class Session {
  snap: Snapshot = { pub: null, priv: null, online: [], status: 'connecting', version: 0, gone: false };
  private listeners = new Set<Listener>();
  private dead = false;
  private ctl: AbortController | null = null;

  constructor(public code: string) {
    const cached = store.get('lrs-view-' + code);
    if (cached) {
      try {
        const v = JSON.parse(cached) as { pub: PublicView; priv: PrivateView | null; version: number };
        this.snap = { ...this.snap, pub: v.pub, priv: v.priv, version: v.version };
      } catch { /* */ }
    }
    void this.loop();
    document.addEventListener('visibilitychange', this.kick);
    window.addEventListener('online', this.kick);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.snap);
    return () => { this.listeners.delete(fn); };
  }
  private emit(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((f) => f(this.snap));
  }

  /** 立即重新拉取（提交操作后 / 页面重新可见时） */
  private kick = () => { this.ctl?.abort(); };

  private async loop() {
    while (!this.dead) {
      this.ctl = new AbortController();
      try {
        const r = await fetch(`${API}?code=${this.code}&since=${this.snap.version}&wait=1`, {
          headers: { Authorization: 'Bearer ' + mySecret() }, signal: this.ctl.signal, cache: 'no-store',
        });
        if (r.status === 404) {
          this.emit({ gone: true, status: 'connected' });
          await new Promise((res) => setTimeout(res, 3000));
          continue;
        }
        if (!r.ok) throw new Error('http ' + r.status);
        const m = await r.json() as { unchanged?: boolean; version: number; pub?: PublicView; priv?: PrivateView | null; online: number[] };
        if (m.unchanged || !m.pub) {
          this.emit({ online: m.online ?? [], status: 'connected', gone: false });
        } else {
          this.emit({ pub: m.pub, priv: m.priv ?? null, online: m.online ?? [], version: m.version, status: 'connected', gone: false });
          store.set('lrs-view-' + this.code, JSON.stringify({ pub: m.pub, priv: m.priv, version: m.version }));
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') continue;
        this.emit({ status: 'offline' });
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  }

  async act(action: Action): Promise<void> {
    try { await post({ op: 'act', code: this.code, action }); }
    finally { this.kick(); }
  }

  destroy() {
    this.dead = true;
    this.ctl?.abort();
    document.removeEventListener('visibilitychange', this.kick);
    window.removeEventListener('online', this.kick);
  }
}
