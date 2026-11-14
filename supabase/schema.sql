-- Run in the Supabase SQL Editor. One private, user-owned profile per account.
create table if not exists public.gemby_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chats jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.gemby_profiles enable row level security;
revoke all on public.gemby_profiles from public, anon;
grant select, insert, update, delete on public.gemby_profiles to authenticated;
drop policy if exists "users read own profile" on public.gemby_profiles;
drop policy if exists "users insert own profile" on public.gemby_profiles;
drop policy if exists "users update own profile" on public.gemby_profiles;
drop policy if exists "users delete own profile" on public.gemby_profiles;
create policy "users read own profile" on public.gemby_profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "users insert own profile" on public.gemby_profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "users update own profile" on public.gemby_profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "users delete own profile" on public.gemby_profiles for delete to authenticated using ((select auth.uid()) = user_id);

-- Per-user usage quotas for the shared server-side keys (CodeCraft, web search).
-- Safe to re-run. The table is not readable or writable by clients; only the
-- security-definer function below touches it, and only for auth.uid().
create table if not exists public.gemby_quota (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, bucket, window_start)
);
alter table public.gemby_quota enable row level security;
revoke all on public.gemby_quota from public, anon, authenticated;

create or replace function public.gemby_consume_quota(p_bucket text, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_seconds integer;
  v_window timestamptz;
  v_count integer;
begin
  if v_uid is null then return false; end if;
  v_seconds := case p_bucket
    when 'codecraft_minute' then 60 when 'codecraft_day' then 86400
    when 'search_minute' then 60 when 'search_day' then 86400
    else null end;
  if v_seconds is null or p_limit is null or p_limit < 1 then raise exception 'invalid quota bucket'; end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / v_seconds) * v_seconds);
  insert into public.gemby_quota as q (user_id, bucket, window_start, count)
    values (v_uid, p_bucket, v_window, 1)
    on conflict (user_id, bucket, window_start) do update set count = q.count + 1
    returning q.count into v_count;
  delete from public.gemby_quota where user_id = v_uid and window_start < now() - interval '2 days';
  return v_count <= p_limit;
end;
$$;
revoke all on function public.gemby_consume_quota(text, integer) from public, anon;
grant execute on function public.gemby_consume_quota(text, integer) to authenticated;
