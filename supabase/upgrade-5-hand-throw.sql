-- Tap-In — upgrade 5: hand-gesture throwing.
-- Items ticked in the Throw console are "armed"; the next grab-and-throw gesture in Air Swipe Slides sends them, then un-ticks them.
-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again. Requires upgrades 2–4.

alter table public.throws add column if not exists armed boolean not null default false;

create or replace function public.set_armed(p_pin text, p_throw uuid, p_armed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare src public.throws;
begin
  select * into src from public.throws where id = p_throw;
  if src.id is null then raise exception 'Item not found'; end if;
  if not public.can_manage(src.programme_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  update public.throws set armed = coalesce(p_armed, false) where id = p_throw;
end $$;

-- Sends every ticked item once, then clears the ticks so a repeated gesture sends nothing.
create or replace function public.throw_armed(p_pin text, p_programme uuid, p_target text)
returns setof public.throws language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  for r in
    update public.throws set armed = false
     where programme_id = p_programme and armed
     returning id
  loop
    return next public.send_throw(p_pin, r.id, p_target);
  end loop;
end $$;

grant execute on function public.set_armed(text, uuid, boolean)    to anon, authenticated;
grant execute on function public.throw_armed(text, uuid, text)     to anon, authenticated;
