import type { Cond, KV, Stored } from './handler.ts';

/** 内存实现（单元测试与本地开发）。每次读取/写入前让出事件循环，以便测试并发竞争。 */
export class MemoryKV implements KV {
  private m = new Map<string, { data: unknown; etag: number }>();
  private n = 0;
  async get<T>(key: string): Promise<Stored<T> | null> {
    await Promise.resolve();
    const e = this.m.get(key);
    return e ? { data: structuredClone(e.data) as T, etag: String(e.etag) } : null;
  }
  async set(key: string, data: unknown, cond?: Cond): Promise<boolean> {
    await Promise.resolve();
    const e = this.m.get(key);
    if (cond?.isNew && e) return false;
    if (cond?.match !== undefined && String(e?.etag) !== cond.match) return false;
    this.m.set(key, { data: structuredClone(data), etag: ++this.n });
    return true;
  }
}
