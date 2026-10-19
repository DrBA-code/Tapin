-- Tap-In — upgrade 4: Throw (slides, case studies, contact cards) and contact sharing.
-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Requires setup.sql and upgrades 2 and 3 first.

-- 1. Items the facilitator prepares and throws to the room ----------------
create table if not exists public.throws (
  id            uuid primary key default gen_random_uuid(),
  programme_id  uuid not null references public.programmes(id) on delete cascade,
  kind          text not null check (kind in ('file','image','contact','link')),
  title         text not null default '' check (char_length(title) <= 200),
  url           text,                       -- file / image / link / contact card (.vcf)
  payload       jsonb not null default '{}', -- contact details, file type, etc.
  target        text not null default 'all' check (target in ('all','A','B')),
  created_at    timestamptz not null default now(),
  sent_at       timestamptz                 -- null = prepared, not yet thrown
);
create index if not exists throws_programme_idx on public.throws (programme_id, sent_at);
alter table public.throws enable row level security;
drop policy if exists "anyone sees thrown items" on public.throws;
create policy "anyone sees thrown items" on public.throws for select to anon, authenticated using (sent_at is not null);
-- Prepared (not yet thrown) items are only visible through the organiser functions below.

-- 2. Contacts participants choose to share back with the facilitator ------
create table if not exists public.shared_contacts (
  id            uuid primary key default gen_random_uuid(),
  programme_id  uuid not null references public.programmes(id) on delete cascade,
  checkin_id    uuid references public.checkins(id) on delete set null,
  title         text not null default '' check (char_length(title) <= 20),
  name          text not null check (char_length(name) between 2 and 120),
  mda           text not null default '' check (char_length(mda) <= 160),
  phone         text not null default '' check (char_length(phone) <= 40),
  email         text not null default '' check (char_length(email) <= 160),
  socials       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists shared_contacts_programme_idx on public.shared_contacts (programme_id, created_at);
alter table public.shared_contacts enable row level security;
drop policy if exists "participants share their contact" on public.shared_contacts;
create policy "participants share their contact" on public.shared_contacts for insert to anon, authenticated
  with check (exists (select 1 from public.programmes p where p.id = programme_id and p.status = 'open'));
-- No select policy: only the organiser / coordinator can read shared contacts, through list_shared_contacts().

-- 3. Organiser / coordinator functions (PIN-checked) -----------------------
create or replace function public.prepare_throw(p_pin text, p_programme uuid, p_kind text, p_title text, p_url text, p_payload jsonb)
returns public.throws language plpgsql security definer set search_path = public as $$
declare rec public.throws;
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  insert into public.throws (programme_id, kind, title, url, payload)
  values (p_programme, p_kind, left(coalesce(p_title,''), 200), p_url, coalesce(p_payload, '{}'::jsonb))
  returning * into rec;
  return rec;
end $$;

create or replace function public.list_throws(p_pin text, p_programme uuid)
returns setof public.throws language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  return query select * from public.throws where programme_id = p_programme order by created_at desc;
end $$;

-- Throwing an item sends a copy, so the same item can be thrown again to another group.
create or replace function public.send_throw(p_pin text, p_throw uuid, p_target text)
returns public.throws language plpgsql security definer set search_path = public as $$
declare src public.throws; rec public.throws;
begin
  select * into src from public.throws where id = p_throw;
  if src.id is null then raise exception 'Item not found'; end if;
  if not public.can_manage(src.programme_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  if p_target not in ('all','A','B') then raise exception 'Unknown target'; end if;
  if src.sent_at is null then
    update public.throws set sent_at = now(), target = p_target where id = src.id returning * into rec;
  else
    insert into public.throws (programme_id, kind, title, url, payload, target, sent_at)
    values (src.programme_id, src.kind, src.title, src.url, src.payload, p_target, now()) returning * into rec;
  end if;
  return rec;
end $$;

create or replace function public.delete_throw(p_pin text, p_throw uuid)
returns void language plpgsql security definer set search_path = public as $$
declare src public.throws;
begin
  select * into src from public.throws where id = p_throw;
  if src.id is null then return; end if;
  if not public.can_manage(src.programme_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  delete from public.throws where id = p_throw;
end $$;

create or replace function public.list_shared_contacts(p_pin text, p_programme uuid)
returns setof public.shared_contacts language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  return query select * from public.shared_contacts where programme_id = p_programme order by created_at desc;
end $$;

grant execute on function public.prepare_throw(text, uuid, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.list_throws(text, uuid)                           to anon, authenticated;
grant execute on function public.send_throw(text, uuid, text)                      to anon, authenticated;
grant execute on function public.delete_throw(text, uuid)                          to anon, authenticated;
grant execute on function public.list_shared_contacts(text, uuid)                  to anon, authenticated;

-- 4. Storage for thrown files and contact cards ----------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('throws', 'throws', true, 26214400)   -- 25 MB per file
on conflict (id) do update set public = true, file_size_limit = 26214400;
drop policy if exists "upload throw files" on storage.objects;
create policy "upload throw files" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'throws');
