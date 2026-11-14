-- Row-level security proof. Paste into the Supabase SQL Editor AFTER running schema.sql.
-- Everything runs in one transaction that is rolled back, so no data is kept.
-- Success: the final query returns 'RLS checks passed'. Any failure raises an error.
begin;

-- 1. Every table in the public schema must have RLS enabled.
do $$ declare bad text; begin
  select string_agg(relname, ', ') into bad from pg_class
   where relnamespace = 'public'::regnamespace and relkind in ('r','p') and not relrowsecurity;
  if bad is not null then raise exception 'RLS disabled on: %', bad; end if;
end $$;

-- 2. Two throwaway users.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-00000000000a', 'rls-a@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000000000b', 'rls-b@example.invalid', 'authenticated', 'authenticated');
insert into public.gemby_profiles (user_id, chats) values
  ('00000000-0000-4000-8000-00000000000b', '[{"id":"b-secret"}]');

-- 3. Anonymous clients can read nothing.
set local role anon;
do $$ begin
  begin perform 1 from public.gemby_profiles; raise exception 'anon can read gemby_profiles';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.gemby_quota; raise exception 'anon can read gemby_quota';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 4. Signed in as user A.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
do $$ declare n int; begin
  insert into public.gemby_profiles (user_id) values ('00000000-0000-4000-8000-00000000000a');
  select count(*) into n from public.gemby_profiles;
  if n <> 1 then raise exception 'A sees % profiles, expected only their own', n; end if;
  select count(*) into n from public.gemby_profiles where user_id = '00000000-0000-4000-8000-00000000000b';
  if n <> 0 then raise exception 'A can read B'; end if;
  update public.gemby_profiles set chats = '[]' where user_id = '00000000-0000-4000-8000-00000000000b';
  get diagnostics n = row_count; if n <> 0 then raise exception 'A can update B'; end if;
  delete from public.gemby_profiles where user_id = '00000000-0000-4000-8000-00000000000b';
  get diagnostics n = row_count; if n <> 0 then raise exception 'A can delete B'; end if;
  begin
    insert into public.gemby_profiles (user_id) values ('00000000-0000-4000-8000-00000000000b')
      on conflict (user_id) do update set chats = '[]';
    raise exception 'A can write a row for B';
  exception when insufficient_privilege then null; end;
  begin
    update public.gemby_profiles set user_id = '00000000-0000-4000-8000-00000000000b' where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'A can move their row to B';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.gemby_quota; raise exception 'clients can read gemby_quota';
  exception when insufficient_privilege then null; end;
  -- Quota function counts only for the caller and enforces the limit.
  if not public.gemby_consume_quota('codecraft_minute', 2) then raise exception 'quota 1 rejected'; end if;
  if not public.gemby_consume_quota('codecraft_minute', 2) then raise exception 'quota 2 rejected'; end if;
  if public.gemby_consume_quota('codecraft_minute', 2) then raise exception 'quota 3 allowed'; end if;
  begin perform public.gemby_consume_quota('anything_else', 5); raise exception 'unknown bucket allowed';
  exception when raise_exception then if sqlerrm <> 'invalid quota bucket' then raise; end if; end;
end $$;
reset role;

-- 5. B's data is untouched and B's quota is independent of A's.
do $$ begin
  if (select chats from public.gemby_profiles where user_id = '00000000-0000-4000-8000-00000000000b') <> '[{"id":"b-secret"}]'::jsonb
    then raise exception 'B data changed'; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  if not public.gemby_consume_quota('codecraft_minute', 2) then raise exception 'B affected by A quota'; end if;
end $$;
reset role;

select 'RLS checks passed' as result;
rollback;
