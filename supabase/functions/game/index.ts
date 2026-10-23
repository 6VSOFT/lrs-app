// 可信后端：所有游戏操作都经由此函数校验并写入。客户端无法直接写任何游戏表。
import { createClient } from 'npm:@supabase/supabase-js@2';
import { applyAction, newRoom } from '../_shared/engine/engine.ts';
import { publicView, privateView } from '../_shared/engine/views.ts';
import { Action, GameError, GameState } from '../_shared/engine/types.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

/** 密码学安全的 [0,n) 随机整数（拒绝采样，无模偏差） */
function secureInt(n: number): number {
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= max);
  return buf[0] % n;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[secureInt(ALPHABET.length)]).join('');

function views(s: GameState) {
  const privates: Record<string, unknown> = {};
  for (const p of s.players) privates[p.uid] = privateView(s, p.uid);
  return { pub: publicView(s), privates };
}

const VALID = new Set([
  'join', 'leave', 'ready', 'start', 'ack', 'wolfKill', 'seerCheck', 'witch', 'register', 'withdraw', 'vote',
  'speechDone', 'speechSkip', 'direction', 'call', 'flip', 'shoot', 'handover', 'playAgain',
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: u, error: ue } = await admin.auth.getUser(token);
    if (ue || !u.user) return json({ ok: false, code: 'UNAUTH', message: '请重新登录' }, 401);
    const uid = u.user.id;
    const body = await req.json();

    if (body.op === 'create') {
      const name = String(body.name ?? '');
      for (let i = 0; i < 8; i++) {
        const code = newCode();
        const s = newRoom(code, uid, name); // 昵称不合法会抛 GameError
        const { pub, privates } = views(s);
        const { data, error } = await admin.rpc('create_room', { p_code: code, p_state: s, p_public: pub, p_privates: privates });
        if (error) throw error;
        if (data) return json({ ok: true, code });
      }
      return json({ ok: false, code: 'RETRY', message: '创建失败，请重试' }, 500);
    }

    if (body.op === 'act') {
      const code = String(body.code ?? '').toUpperCase();
      const action = body.action as Action;
      if (!action || !VALID.has(action.type)) return json({ ok: false, code: 'BAD_ACTION', message: '无效操作' }, 400);
      for (let attempt = 0; attempt < 25; attempt++) {
        const { data: row, error } = await admin.from('room_state').select('version,state').eq('code', code).maybeSingle();
        if (error) throw error;
        if (!row) return json({ ok: false, code: 'NO_ROOM', message: '房间不存在' }, 404);
        const next = applyAction(row.state as GameState, uid, action, secureInt);
        const { pub, privates } = views(next);
        const { data: okc, error: ce } = await admin.rpc('commit_state', {
          p_code: code, p_expected: row.version, p_state: next, p_public: pub, p_privates: privates,
        });
        if (ce) throw ce;
        if (okc) return json({ ok: true });
        await new Promise((r) => setTimeout(r, 20 + secureInt(60))); // 乐观锁冲突：退避重试
      }
      return json({ ok: false, code: 'BUSY', message: '服务器繁忙，请重试' }, 503);
    }
    return json({ ok: false, code: 'BAD_OP', message: '无效请求' }, 400);
  } catch (e) {
    if (e instanceof GameError) return json({ ok: false, code: e.code, message: e.message }, 409);
    console.error(e);
    return json({ ok: false, code: 'SERVER', message: '服务器错误' }, 500);
  }
});
