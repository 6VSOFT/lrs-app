-- 狼人杀自动法官：数据结构与安全规则
-- rooms          : 公共信息（任何登录用户可读，任何人不可直接写）
-- player_private : 每位玩家的私人视图（只有本人可读）
-- room_state     : 完整权威状态（含全部身份）。RLS 开启且无任何策略 => 客户端完全不可访问，仅 service_role（Edge Function）可用

create table public.rooms (
  code text primary key,
  public jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.player_private (
  code text not null references public.rooms(code) on delete cascade,
  user_id uuid not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (code, user_id)
);

create table public.room_state (
  code text primary key references public.rooms(code) on delete cascade,
  version integer not null default 1,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;
alter table public.player_private enable row level security;
alter table public.room_state enable row level security;

create policy "rooms readable by signed-in users" on public.rooms
  for select to authenticated using (true);
create policy "own private view only" on public.player_private
  for select to authenticated using (user_id = auth.uid());

revoke all on public.rooms, public.player_private, public.room_state from anon, authenticated;
grant select on public.rooms, public.player_private to authenticated;

-- 原子创建房间
create or replace function public.create_room(p_code text, p_state jsonb, p_public jsonb, p_privates jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into rooms(code, public) values (p_code, p_public || jsonb_build_object('version', 1));
  insert into room_state(code, state, version) values (p_code, p_state, 1);
  insert into player_private(code, user_id, data)
    select p_code, k::uuid, v from jsonb_each(p_privates) as t(k, v);
  return true;
exception when unique_violation then
  return false;
end $$;

-- 乐观锁 + 单事务提交：状态、公共视图、私人视图同时写入，杜绝重复结算与视图乱序
create or replace function public.commit_state(p_code text, p_expected integer, p_state jsonb, p_public jsonb, p_privates jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update room_state set state = p_state, version = version + 1, updated_at = now()
    where code = p_code and version = p_expected;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  update rooms set public = p_public || jsonb_build_object('version', p_expected + 1), updated_at = now()
    where code = p_code;
  delete from player_private where code = p_code
    and user_id::text not in (select jsonb_object_keys(p_privates));
  insert into player_private(code, user_id, data)
    select p_code, k::uuid, v from jsonb_each(p_privates) as t(k, v)
  on conflict (code, user_id) do update set data = excluded.data, updated_at = now();
  return true;
end $$;

revoke all on function public.create_room(text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.commit_state(text, integer, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_room(text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.commit_state(text, integer, jsonb, jsonb, jsonb) to service_role;

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.player_private;
alter table public.player_private replica identity full;
