-- Tap-In — upgrade 7: participant email at check-in, and a 30-day bin for deleted programmes.
-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Requires setup.sql and upgrades 2–6 first.

-- 1. Email at check-in -------------------------------------------------------
-- Kept in its own private table: the check-in list is public (the welcome screen reads it), emails are not.
create table if not exists public.checkin_emails (
  checkin_id  uuid primary key references public.checkins(id) on delete cascade,
  email       text not null check (char_length(email) between 5 and 160 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at  timestamptz not null default now()
);
alter table public.checkin_emails enable row level security;   -- no policies: only the functions below

-- A phone adds the email right after its own check-in (once; it can't overwrite someone else's).
create or replace function public.set_checkin_email(p_checkin uuid, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare c public.checkins;
begin
  select * into c from public.checkins where id = p_checkin;
  if c.id is null then raise exception 'Check-in not found'; end if;
  if c.arrived_at < now() - interval '1 hour' then raise exception 'Too late to add an email to this check-in'; end if;
  insert into public.checkin_emails (checkin_id, email) values (p_checkin, lower(trim(p_email)))
  on conflict (checkin_id) do nothing;
end $$;

create or replace function public.list_emails(p_pin text, p_programme uuid)
returns table (checkin_id uuid, email text) language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  return query select e.checkin_id, e.email from public.checkin_emails e join public.checkins c on c.id = e.checkin_id where c.programme_id = p_programme;
end $$;

-- 2. Bin: deleting a programme hides it for 30 days, then it is removed for good -----
alter table public.programmes add column if not exists deleted_at timestamptz;
drop policy if exists "anyone can read programmes" on public.programmes;
create policy "anyone can read programmes" on public.programmes for select to anon, authenticated using (deleted_at is null);

create or replace function public.delete_programme(p_pin text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(p_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  update public.programmes set deleted_at = now(), status = 'closed', closed_at = coalesce(closed_at, now()) where id = p_id;
  update public.live_state set activity_id = null, phase = 'idle' where programme_id = p_id;
end $$;

create or replace function public.restore_programme(p_pin text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.organiser_check(p_pin) then raise exception 'Only the organiser can restore'; end if;
  update public.programmes set deleted_at = null where id = p_id;
end $$;

-- Organiser: what is in the bin. Anything older than 30 days is removed for good first.
create or replace function public.list_bin(p_pin text)
returns setof public.programmes language plpgsql security definer set search_path = public as $$
begin
  if not public.organiser_check(p_pin) then raise exception 'Wrong organiser PIN'; end if;
  delete from public.programmes where deleted_at < now() - interval '30 days';
  return query select * from public.programmes where deleted_at is not null order by deleted_at desc;
end $$;

-- Organiser: empty one programme from the bin now (check-ins, answers, results and throws go with it).
create or replace function public.purge_programme(p_pin text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.organiser_check(p_pin) then raise exception 'Only the organiser can delete for good'; end if;
  delete from public.programmes where id = p_id and deleted_at is not null;
end $$;

grant execute on function public.set_checkin_email(uuid, text)      to anon, authenticated;
grant execute on function public.list_emails(text, uuid)            to anon, authenticated;
grant execute on function public.delete_programme(text, uuid)       to anon, authenticated;
grant execute on function public.restore_programme(text, uuid)      to anon, authenticated;
grant execute on function public.list_bin(text)                     to anon, authenticated;
grant execute on function public.purge_programme(text, uuid)        to anon, authenticated;
