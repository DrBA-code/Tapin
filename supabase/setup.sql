-- Tap-In Welcome: database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- BEFORE RUNNING: change the organiser PIN on the line marked  <<< CHANGE THIS PIN

-- 1. Check-ins -------------------------------------------------------------
create table if not exists public.checkins (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (title in ('Prof','Dr','Mr','Mrs','Miss')),
  name        text not null check (char_length(name) between 2 and 120),
  mda         text not null check (char_length(mda) between 2 and 160),
  photo_url   text,
  arrived_at  timestamptz not null default now()
);
alter table public.checkins enable row level security;

drop policy if exists "anyone can check in"   on public.checkins;
drop policy if exists "anyone can view roll"  on public.checkins;
create policy "anyone can check in"  on public.checkins for insert to anon, authenticated with check (true);
create policy "anyone can view roll" on public.checkins for select to anon, authenticated using (true);
-- No update/delete policies: only the organiser functions below can remove rows.

-- 2. Settings (programme name shown on the screen) -------------------------
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  event_name  text not null default ''
);
insert into public.settings (id, event_name) values (1, '') on conflict (id) do nothing;
alter table public.settings enable row level security;
drop policy if exists "anyone can read settings" on public.settings;
create policy "anyone can read settings" on public.settings for select to anon, authenticated using (true);

-- 3. Organiser PIN (private: no policies, so the public key cannot read it) -
create table if not exists public.organiser (
  id   int primary key default 1 check (id = 1),
  pin  text not null
);
alter table public.organiser enable row level security;
insert into public.organiser (id, pin) values (1, 'CHANGE-ME-1234')   -- <<< CHANGE THIS PIN
on conflict (id) do update set pin = excluded.pin;

-- 4. Organiser actions -----------------------------------------------------
create or replace function public.organiser_check(p_pin text)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.organiser where id = 1 and pin = p_pin);
$$;

create or replace function public.set_event_name(p_pin text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.organiser_check(p_pin) then raise exception 'Wrong organiser PIN'; end if;
  update public.settings set event_name = left(coalesce(p_name,''), 160) where id = 1;
end $$;

create or replace function public.clear_checkins(p_pin text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.organiser_check(p_pin) then raise exception 'Wrong organiser PIN'; end if;
  delete from public.checkins where true;
end $$;

grant execute on function public.organiser_check(text)          to anon, authenticated;
grant execute on function public.set_event_name(text, text)     to anon, authenticated;
grant execute on function public.clear_checkins(text)           to anon, authenticated;

-- 5. Live updates for the welcome screen -----------------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.checkins; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.settings; exception when duplicate_object then null; end;
end $$;

-- 6. Photo storage (public bucket so the screen can show portraits) --------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 1048576, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

drop policy if exists "anyone can upload a check-in photo" on storage.objects;
create policy "anyone can upload a check-in photo" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'photos');
