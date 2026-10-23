// 房主设备上的「法官」：保管完整状态、校验并执行每个玩家的操作、为每位玩家生成各自可见的视图。
// 与网络传输完全解耦，便于单元测试。
import { applyAction, newRoom } from './engine/engine.ts';
import { Action, GameError, GameState, Rand } from './engine/types.ts';
import { PrivateView, PublicView, privateView, publicView } from './engine/views.ts';

export interface ViewMsg {
  t: 'view';
  version: number;
  pub: PublicView;
  priv: PrivateView | null;
  online: number[];
}

/** 密码学安全的 [0,n) 随机整数（拒绝采样，无模偏差） */
export const secureInt: Rand = (n) => {
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= max);
  return buf[0] % n;
};

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[secureInt(CODE_ALPHABET.length)]).join('');
export const newSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

export class HostCore {
  version: number;
  private connected = new Set<string>();

  constructor(
    public state: GameState,
    version = 1,
    private rand: Rand = secureInt,
    private persist: (state: GameState, version: number) => void = () => {},
  ) {
    this.version = version;
  }

  static create(code: string, hostUid: string, hostName: string, rand: Rand = secureInt, persist?: (s: GameState, v: number) => void) {
    const core = new HostCore(newRoom(code, hostUid, hostName), 1, rand, persist);
    core.persist(core.state, core.version);
    return core;
  }

  /** 处理某位玩家（uid = 其本机私密令牌）的操作。非法操作返回错误，不改变状态。 */
  handle(uid: string, action: Action): { ok: true } | { ok: false; code: string; message: string } {
    try {
      this.state = applyAction(this.state, uid, action, this.rand);
      this.version += 1;
      this.persist(this.state, this.version);
      return { ok: true };
    } catch (e) {
      if (e instanceof GameError) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: 'SERVER', message: '内部错误' };
    }
  }

  setConnected(uid: string, on: boolean) { if (on) this.connected.add(uid); else this.connected.delete(uid); }
  isConnected(uid: string) { return this.connected.has(uid); }

  /** 某位玩家能看到的一切：公共视图 + 仅属于他的私人视图 */
  viewFor(uid: string): ViewMsg {
    const online = this.state.players.filter((p) => this.connected.has(p.uid) || p.uid === this.state.hostUid).map((p) => p.seat);
    return { t: 'view', version: this.version, pub: publicView(this.state), priv: privateView(this.state, uid), online };
  }
}
