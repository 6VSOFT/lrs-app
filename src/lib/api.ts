import { supabase } from './supabase';
import type { Action } from '@engine/types';

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function call(body: Record<string, unknown>): Promise<{ code?: string }> {
  const { data, error } = await supabase.functions.invoke('game', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try { const j = await ctx.json(); throw new ApiError(j.code ?? 'ERR', j.message ?? '请求失败'); }
      catch (e) { if (e instanceof ApiError) throw e; }
    }
    throw new ApiError('NETWORK', '网络异常，请稍后重试');
  }
  if (data && data.ok === false) throw new ApiError(data.code, data.message);
  return data;
}

export const createRoom = async (name: string) => (await call({ op: 'create', name })).code as string;
export const act = (code: string, action: Action) => call({ op: 'act', code, action });
