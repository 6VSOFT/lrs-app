import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrivateView, PublicView } from '@engine/views';
import { supabase } from './lib/supabase';

export interface RoomData {
  pub: PublicView | null;
  priv: PrivateView | null;
  loading: boolean;
  notFound: boolean;
  online: Set<number>;
}

/** 订阅公共房间视图 + 本人私人视图；Realtime 为主，3 秒轮询兜底；Presence 显示在线状态 */
export function useRoom(code: string, uid: string): RoomData & { refresh: () => void } {
  const [pub, setPub] = useState<PublicView | null>(null);
  const [priv, setPriv] = useState<PrivateView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [online, setOnline] = useState<Set<number>>(new Set());
  const verRef = useRef(0);
  const seatRef = useRef<number | null>(null);
  const chanRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const refresh = useCallback(async () => {
    const [r, p] = await Promise.all([
      supabase.from('rooms').select('public').eq('code', code).maybeSingle(),
      supabase.from('player_private').select('data').eq('code', code).eq('user_id', uid).maybeSingle(),
    ]);
    if (r.error && !r.data) { setLoading(false); return; }
    if (!r.data) { setNotFound(true); setLoading(false); return; }
    const v = r.data.public as PublicView;
    if ((v.version ?? 0) >= verRef.current) {
      verRef.current = v.version ?? 0;
      setPub(v);
      setPriv((p.data?.data as PrivateView) ?? null);
    }
    setNotFound(false);
    setLoading(false);
  }, [code, uid]);

  useEffect(() => {
    verRef.current = 0;
    setLoading(true);
    refresh();
    const ch = supabase
      .channel(`db:${code}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${code}` }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_private', filter: `code=eq.${code}` }, () => refresh())
      .subscribe();
    const poll = setInterval(refresh, 3000);
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onVis);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onVis);
      supabase.removeChannel(ch);
    };
  }, [code, refresh]);

  useEffect(() => { seatRef.current = priv?.seat ?? null; }, [priv?.seat]);

  const mySeat = priv?.seat ?? null;
  useEffect(() => {
    if (mySeat === null) return;
    const ch = supabase.channel(`presence:${code}`, { config: { presence: { key: String(mySeat) } } });
    chanRef.current = ch;
    const sync = () => setOnline(new Set(Object.keys(ch.presenceState()).map(Number)));
    ch.on('presence', { event: 'sync' }, sync).subscribe(async (st) => {
      if (st === 'SUBSCRIBED') await ch.track({ seat: mySeat });
    });
    return () => { supabase.removeChannel(ch); };
  }, [code, mySeat]);

  return { pub, priv, loading, notFound, online, refresh };
}
