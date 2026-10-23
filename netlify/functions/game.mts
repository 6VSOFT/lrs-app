import { getStore } from '@netlify/blobs';
import type { Cond, KV, Stored } from '../../server/handler.ts';
import { handle } from '../../server/handler.ts';

function blobKV(name: string): KV {
  const store = getStore({ name, consistency: 'strong' });
  return {
    async get<T>(key: string): Promise<Stored<T> | null> {
      const r = await store.getWithMetadata(key, { type: 'json' });
      return r ? { data: r.data as T, etag: r.etag as string } : null;
    },
    async set(key: string, data: unknown, cond?: Cond) {
      const opts = cond?.isNew ? { onlyIfNew: true } : cond?.match ? { onlyIfMatch: cond.match } : {};
      const r = await store.setJSON(key, data, opts);
      return r.modified;
    },
  };
}

export default async (req: Request): Promise<Response> => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const url = new URL(req.url);
  const secret = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '') || null;
  let body: unknown = null;
  if (req.method === 'POST') {
    const text = await req.text();
    if (text.length > 4000) return json(413, { ok: false, code: 'TOO_BIG', message: '请求过大' });
    try { body = JSON.parse(text); } catch { return json(400, { ok: false, code: 'BAD_JSON', message: '请求格式错误' }); }
  }
  const r = await handle(
    { rooms: blobKV('rooms'), seen: blobKV('seen') },
    { method: req.method, query: Object.fromEntries(url.searchParams), body, secret },
  );
  return json(r.status, r.body);
};
