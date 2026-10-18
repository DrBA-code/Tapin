-- Tap-In Welcome — upgrade 3: a PIN for each programme coordinator.
-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Requires setup.sql and upgrade-2-programmes.sql first.

-- 1. Private table of coordinator PINs (no policies: the public key cannot read it).
create table if not exists public.programme_pins (
  programme_id uuid primary key references public.programmes(id) on delete cascade,
  pin          text not null check (char_length(pin) between 4 and 40)
);
alter table public.programme_pins enable row level security;

-- 2. Who may manage a programme: the organiser, or that programme's coordinator.
create or replace function public.can_manage(p_id uuid, p_pin text)
returns boolean language sql security definer set search_path = public as $$
  select public.organiser_check(p_pin)
      or exists (select 1 from public.programme_pins where programme_id = p_id and pin = p_pin);
$$;

-- Used by the register page: is this PIN good for the programme with this link code?
create or replace function public.coordinator_check(p_code text, p_pin text)
returns text language sql security definer set search_path = public as $$
  select case
    when public.organiser_check(p_pin) then 'organiser'
    when exists (select 1 from public.programmes p join public.programme_pins x on x.programme_id = p.id
                 where p.code = upper(p_code) and x.pin = p_pin) then 'coordinator'
    else null end;
$$;

-- 3. Create a programme with its coordinator PIN (organiser only).
drop function if exists public.create_programme(text, text, text, text);
create or replace function public.create_programme(p_pin text, p_name text, p_programme_code text, p_coordinator text, p_coordinator_pin text)
returns public.programmes language plpgsql security definer set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  new_code text;
  rec public.programmes;
begin
  if not public.organiser_check(p_pin) then raise exception 'Wrong organiser PIN'; end if;
  if char_length(trim(coalesce(p_name,''))) < 3 then raise exception 'Programme name is too short'; end if;
  if char_length(trim(coalesce(p_coordinator,''))) < 3 then raise exception 'Coordinator name is too short'; end if;
  if char_length(coalesce(p_coordinator_pin,'')) < 4 then raise exception 'Coordinator PIN must be at least 4 characters'; end if;
  loop
    new_code := '';
    for i in 1..6 loop
      new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.programmes where code = new_code);
  end loop;
  insert into public.programmes (code, name, programme_code, coordinator)
  values (new_code, left(trim(p_name), 160), left(trim(coalesce(p_programme_code,'')), 60), left(trim(p_coordinator), 120))
  returning * into rec;
  insert into public.programme_pins (programme_id, pin) values (rec.id, p_coordinator_pin);
  return rec;
end $$;

-- 4. Set or change a coordinator PIN (organiser only).
create or replace function public.set_coordinator_pin(p_pin text, p_id uuid, p_new_pin text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.organiser_check(p_pin) then raise exception 'Wrong organiser PIN'; end if;
  if char_length(coalesce(p_new_pin,'')) < 4 then raise exception 'Coordinator PIN must be at least 4 characters'; end if;
  insert into public.programme_pins (programme_id, pin) values (p_id, p_new_pin)
  on conflict (programme_id) do update set pin = excluded.pin;
end $$;

-- 5. Coordinators may also close and reopen their own programme.
create or replace function public.set_programme_status(p_pin text, p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(p_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  if p_status not in ('open','closed') then raise exception 'Unknown status'; end if;
  update public.programmes
     set status = p_status,
         closed_at = case when p_status = 'closed' then now() else null end
   where id = p_id;
end $$;

-- Lock helper functions to what the app needs.
revoke all on function public.can_manage(uuid, text) from public, anon, authenticated;
grant execute on function public.coordinator_check(text, text)                         to anon, authenticated;
grant execute on function public.create_programme(text, text, text, text, text)        to anon, authenticated;
grant execute on function public.set_coordinator_pin(text, uuid, text)                 to anon, authenticated;
grant execute on function public.set_programme_status(text, uuid, text)                to anon, authenticated;
