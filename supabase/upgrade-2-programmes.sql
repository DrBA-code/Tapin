-- Tap-In Welcome — upgrade 2: programmes, per-programme QR codes, tap-out.
-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Requires setup.sql to have been run first (it created the organiser PIN).

-- 1. Programmes ------------------------------------------------------------
create table if not exists public.programmes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null check (char_length(name) between 3 and 160),
  status      text not null default 'open' check (status in ('open','closed')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
alter table public.programmes add column if not exists programme_code text not null default '';
alter table public.programmes add column if not exists coordinator    text not null default '';
alter table public.programmes enable row level security;
drop policy if exists "anyone can read programmes" on public.programmes;
create policy "anyone can read programmes" on public.programmes for select to anon, authenticated using (true);
-- No insert/update policies: only the organiser functions below change programmes.

-- 2. Check-ins belong to a programme and can be tapped out ------------------
alter table public.checkins add column if not exists programme_id uuid references public.programmes(id) on delete cascade;
alter table public.checkins add column if not exists tap_out_at timestamptz;
create index if not exists checkins_programme_idx on public.checkins (programme_id, arrived_at);

-- New check-ins must name an open programme.
drop policy if exists "anyone can check in" on public.checkins;
create policy "anyone can check in" on public.checkins for insert to anon, authenticated
  with check (
    tap_out_at is null
    and programme_id is not null
    and exists (select 1 from public.programmes p where p.id = programme_id and p.status = 'open')
  );

-- 3. Organiser actions -----------------------------------------------------
drop function if exists public.create_programme(text, text);
create or replace function public.create_programme(p_pin text, p_name text, p_programme_code text, p_coordinator text)
returns public.programmes language plpgsql security definer set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  new_code text;
  rec public.programmes;
begin
  if not public.organiser_check(p_pin) then raise exception 'Wrong organiser PIN'; end if;
  if char_length(trim(coalesce(p_name,''))) < 3 then raise exception 'Programme name is too short'; end if;
  loop
    new_code := '';
    for i in 1..6 loop
      new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.programmes where code = new_code);
  end loop;
  if char_length(trim(coalesce(p_coordinator,''))) < 3 then raise exception 'Coordinator name is too short'; end if;
  insert into public.programmes (code, name, programme_code, coordinator)
  values (new_code, left(trim(p_name), 160), left(trim(coalesce(p_programme_code,'')), 60), left(trim(p_coordinator), 120))
  returning * into rec;
  return rec;
end $$;

create or replace function public.set_programme_status(p_pin text, p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.organiser_check(p_pin) then raise exception 'Wrong organiser PIN'; end if;
  if p_status not in ('open','closed') then raise exception 'Unknown status'; end if;
  update public.programmes
     set status = p_status,
         closed_at = case when p_status = 'closed' then now() else null end
   where id = p_id;
end $$;

drop function if exists public.rename_programme(text, uuid, text);
create or replace function public.update_programme(p_pin text, p_id uuid, p_name text, p_programme_code text, p_coordinator text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.organiser_check(p_pin) then raise exception 'Wrong organiser PIN'; end if;
  update public.programmes
     set name = left(trim(p_name), 160),
         programme_code = left(trim(coalesce(p_programme_code,'')), 60),
         coordinator = left(trim(coalesce(p_coordinator,'')), 120)
   where id = p_id;
end $$;

-- 4. Tap out (attendees) — only sets the time once, only while the programme is open.
create or replace function public.tap_out(p_checkin uuid)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  update public.checkins c
     set tap_out_at = now()
   where c.id = p_checkin
     and c.tap_out_at is null
     and exists (select 1 from public.programmes p where p.id = c.programme_id and p.status = 'open')
  returning tap_out_at into t;
  if t is null then raise exception 'Already tapped out, or the programme is closed'; end if;
  return t;
end $$;

grant execute on function public.create_programme(text, text, text, text)    to anon, authenticated;
grant execute on function public.set_programme_status(text, uuid, text)      to anon, authenticated;
grant execute on function public.update_programme(text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.tap_out(uuid)                               to anon, authenticated;

-- 5. Live updates ----------------------------------------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.programmes; exception when duplicate_object then null; end;
end $$;
alter table public.checkins replica identity full;
