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
