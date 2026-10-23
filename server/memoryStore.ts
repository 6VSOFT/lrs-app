import type { KV } from './handler.ts';

/** 内存实现（单元测试与本地开发）。每次访问前让出事件循环，以便测试并发竞争。 */
export class MemoryKV implements KV {
  private m = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    await Promise.resolve();
    const e = this.m.get(key);
    return e === undefined ? null : (structuredClone(e) as T);
  }
  async set(key: string, data: unknown): Promise<void> {
    await Promise.resolve();
    this.m.set(key, structuredClone(data));
  }
  async setIfNew(key: string, data: unknown): Promise<boolean> {
    await Promise.resolve();
    if (this.m.has(key)) return false;
    this.m.set(key, structuredClone(data));
    return true;
  }
  /** 测试用：查看原始存储内容 */
  raw() { return this.m; }
}
