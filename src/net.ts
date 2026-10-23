// 点对点网络层（WebRTC，经 PeerJS 公共信令中转建立连接；之后游戏数据直接在手机之间传输，不经过任何游戏服务器）。
// 房主手机运行 HostCore（法官），其他手机作为客户端只收到自己的视图。
import { Peer, DataConnection } from 'peerjs';
import type { Action, GameState } from '@engine/types';
import type { PrivateView, PublicView } from '@engine/views';
import { HostCore, ViewMsg, newCode, newSecret } from '@shared/hostcore';

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
}

const PEER_PREFIX = 'lrs-werewolf-';
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 隐私模式等 */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* */ } },
};

/** 本机的私密令牌：既是你的身份凭证，也是你的座位凭证，只保存在你的手机里 */
export function mySecret(): string {
  let s = store.get('lrs-secret');
  if (!s) { s = newSecret(); store.set('lrs-secret', s); }
  return s;
}
export const savedNick = () => store.get('lrs-nick') ?? '';
export const saveNick = (n: string) => store.set('lrs-nick', n);
export const hasHostRecord = (code: string) => !!store.get('lrs-host-' + code);
export function forgetRoom(code: string) {
  store.del('lrs-view-' + code);
  store.del('lrs-host-' + code);
}

type Listener = (s: Snapshot) => void;

abstract class BaseSession {
  snap: Snapshot = { pub: null, priv: null, online: [], status: 'connecting', version: 0 };
  private listeners = new Set<Listener>();
  abstract readonly isHost: boolean;
  constructor(public code: string, protected secret: string) {}
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.snap);
    return () => { this.listeners.delete(fn); };
  }
  protected emit(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((f) => f(this.snap));
  }
  abstract act(action: Action): Promise<void>;
  abstract destroy(): void;
}

// ---------------- 房主 ----------------
export class HostSession extends BaseSession {
  readonly isHost = true;
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>(); // uid -> conn
  private dead = false;
  private lock: { release(): Promise<void> } | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;

  private constructor(code: string, secret: string, public core: HostCore) {
    super(code, secret);
    this.push();
  }

  /** 新建房间：选择一个未被占用的房间代码 */
  static async create(name: string): Promise<HostSession> {
    const secret = mySecret();
    for (let i = 0; i < 6; i++) {
      const code = newCode();
      const peer = await tryOpen(PEER_PREFIX + code);
      if (!peer) continue;
      const core = HostCore.create(code, secret, name, undefined, (s, v) => store.set('lrs-host-' + code, JSON.stringify({ s, v })));
      const h = new HostSession(code, secret, core);
      h.attach(peer);
      return h;
    }
    throw new ApiError('PEER', '无法连接到信令服务，请检查网络后重试');
  }

  /** 房主刷新页面后从本机存档恢复 */
  static resume(code: string): HostSession | null {
    const raw = store.get('lrs-host-' + code);
    if (!raw) return null;
    try {
      const { s, v } = JSON.parse(raw) as { s: GameState; v: number };
      const secret = mySecret();
      if (s.hostUid !== secret) return null;
      const core = new HostCore(s, v, undefined, (st, ver) => store.set('lrs-host-' + code, JSON.stringify({ s: st, v: ver })));
      const h = new HostSession(code, secret, core);
      h.open();
      return h;
    } catch { return null; }
  }

  private open() {
    if (this.dead) return;
    this.emit({ status: 'connecting' });
    const peer = new Peer(PEER_PREFIX + this.code);
    peer.on('open', () => { this.attach(peer); });
    peer.on('error', (e: { type?: string }) => {
      // 刷新后信令服务可能还保留着旧 ID：稍后重试
      if (e.type === 'unavailable-id' || e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
        peer.destroy();
        this.retry = setTimeout(() => this.open(), 2500);
      }
    });
  }

  private attach(peer: Peer) {
    this.peer = peer;
    peer.on('connection', (c) => this.onConn(c));
    peer.on('disconnected', () => { if (!this.dead) peer.reconnect(); });
    this.emit({ status: 'connected' });
    this.push();
    this.requestWakeLock();
  }

  private async requestWakeLock() {
    try {
      const nav = navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
      this.lock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch { /* 不支持则忽略 */ }
  }

  private onConn(c: DataConnection) {
    let uid: string | null = null;
    c.on('data', (raw) => {
      const m = raw as { t?: string; secret?: string; action?: Action; reqId?: number };
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello' && typeof m.secret === 'string' && m.secret.length >= 8 && m.secret.length <= 64) {
        uid = m.secret;
        const old = this.conns.get(uid);
        if (old && old !== c) old.close();
        this.conns.set(uid, c);
        this.core.setConnected(uid, true);
        this.push();
      } else if (m.t === 'act' && uid && m.action && typeof m.action === 'object') {
        const r = this.core.handle(uid, m.action);
        c.send({ t: 'ack', reqId: m.reqId, ...r });
        this.push();
      }
    });
    const gone = () => {
      if (uid && this.conns.get(uid) === c) {
        this.conns.delete(uid);
        this.core.setConnected(uid, false);
        this.push();
      }
    };
    c.on('close', gone);
    c.on('error', gone);
  }

  /** 把最新状态推送给每位在线玩家（各自只收到自己的视图）并更新本机界面 */
  private push() {
    const mine = this.core.viewFor(this.secret);
    this.emit({ pub: mine.pub, priv: mine.priv, online: mine.online, version: mine.version });
    for (const [uid, c] of this.conns) if (c.open) c.send(this.core.viewFor(uid));
  }

  async act(action: Action) {
    const r = this.core.handle(this.secret, action);
    this.push();
    if (!r.ok) throw new ApiError(r.code, r.message);
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.retry);
    this.lock?.release().catch(() => {});
    this.peer?.destroy();
  }
}

function tryOpen(id: string): Promise<Peer | null> {
  return new Promise((resolve) => {
    const peer = new Peer(id);
    const timer = setTimeout(() => { peer.destroy(); resolve(null); }, 10000);
    peer.on('open', () => { clearTimeout(timer); resolve(peer); });
    peer.on('error', () => { clearTimeout(timer); peer.destroy(); resolve(null); });
  });
}

// ---------------- 客户端 ----------------
export class ClientSession extends BaseSession {
  readonly isHost = false;
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private dead = false;
  private seq = 0;
  private pending = new Map<number, { ok(): void; fail(e: ApiError): void }>();
  private timer: ReturnType<typeof setInterval>;

  constructor(code: string) {
    super(code, mySecret());
    const cached = store.get('lrs-view-' + code);
    if (cached) {
      try {
        const v = JSON.parse(cached) as ViewMsg;
        this.snap = { ...this.snap, pub: v.pub, priv: v.priv, online: v.online, version: v.version };
      } catch { /* */ }
    }
    this.connect();
    this.timer = setInterval(() => this.connect(), 3000);
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('online', this.onVis);
  }

  private onVis = () => { if (document.visibilityState === 'visible') this.connect(); };

  private connect() {
    if (this.dead || this.conn?.open) return;
    if (!this.peer || this.peer.destroyed) {
      this.peer = new Peer();
      this.peer.on('error', () => this.emit({ status: 'offline' }));
    }
    const peer = this.peer;
    const go = () => {
      if (this.dead || this.conn?.open) return;
      this.conn?.close();
      const c = peer.connect(PEER_PREFIX + this.code, { reliable: true });
      this.conn = c;
      c.on('open', () => {
        c.send({ t: 'hello', secret: this.secret });
        this.emit({ status: 'connected' });
      });
      c.on('data', (raw) => {
        const m = raw as { t?: string; reqId?: number; ok?: boolean; code?: string; message?: string } & Partial<Omit<ViewMsg, 't'>>;
        if (m.t === 'view' && m.pub) {
          if ((m.version ?? 0) >= this.snap.version) {
            this.emit({ pub: m.pub, priv: m.priv ?? null, online: m.online ?? [], version: m.version ?? 0 });
            store.set('lrs-view-' + this.code, JSON.stringify(m));
          }
        } else if (m.t === 'ack' && m.reqId !== undefined) {
          const p = this.pending.get(m.reqId);
          this.pending.delete(m.reqId);
          if (p) {
            if (m.ok) p.ok(); else p.fail(new ApiError(m.code ?? 'ERR', m.message ?? '操作失败'));
          }
        }
      });
      const lost = () => { if (this.conn === c) this.emit({ status: 'offline' }); };
      c.on('close', lost);
      c.on('error', lost);
    };
    if (peer.open) go(); else peer.once('open', go);
  }

  act(action: Action): Promise<void> {
    const c = this.conn;
    if (!c?.open) return Promise.reject(new ApiError('OFFLINE', '未连接到房主，请稍候'));
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(reqId); reject(new ApiError('TIMEOUT', '房主无响应')); }, 8000);
      this.pending.set(reqId, { ok: () => { clearTimeout(t); resolve(); }, fail: (e) => { clearTimeout(t); reject(e); } });
      c.send({ t: 'act', action, reqId });
    });
  }

  destroy() {
    this.dead = true;
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('online', this.onVis);
    this.peer?.destroy();
  }
}
