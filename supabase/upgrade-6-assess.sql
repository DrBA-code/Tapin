-- Tap-In — upgrade 6: Assessments (polls, quizzes, first to catch, word clouds, tests, feedback…).
-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Requires setup.sql and upgrades 2–5 first.
--
-- How it fits together
--   activities   the facilitator's saved activities (questions live in data.steps). Private: answers are in here.
--   live_state   one row per programme: which activity/step is on screen and whether answers are open. Public, live.
--   responses    one answer per phone per step. Scored here, on the server. Private: read through results().
--   tallies      room counts from the finger vote (webcam), saved by the facilitator.
--   session_feedback   stars + comment left at tap-out.

-- 1. Tables ----------------------------------------------------------------
create table if not exists public.activities (
  id            uuid primary key default gen_random_uuid(),
  programme_id  uuid not null references public.programmes(id) on delete cascade,
  kind          text not null check (kind in ('poll','finger','words','scale','quiz','buzz','order','match','spot','battle','case','test','exit','feedback')),
  title         text not null default '' check (char_length(title) <= 200),
  data          jsonb not null default '{"steps":[]}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists activities_programme_idx on public.activities (programme_id, created_at);
alter table public.activities enable row level security;   -- no policies: only the functions below read it

create table if not exists public.live_state (
  programme_id  uuid primary key references public.programmes(id) on delete cascade,
  activity_id   uuid references public.activities(id) on delete set null,
  run           text not null default '',
  step          int  not null default 0,
  phase         text not null default 'idle' check (phase in ('idle','ready','open','closed','reveal')),
  seconds       int  not null default 0,
  opened_at     timestamptz,
  updated_at    timestamptz not null default now()
);
alter table public.live_state enable row level security;
drop policy if exists "anyone sees what is live" on public.live_state;
create policy "anyone sees what is live" on public.live_state for select to anon, authenticated using (true);

create table if not exists public.responses (
  id            uuid primary key default gen_random_uuid(),
  activity_id   uuid not null references public.activities(id) on delete cascade,
  programme_id  uuid not null references public.programmes(id) on delete cascade,
  run           text not null,
  step          int  not null,
  device        uuid not null,
  checkin_id    uuid references public.checkins(id) on delete set null,
  name          text not null default '' check (char_length(name) <= 120),
  grp           text not null default 'all' check (grp in ('all','A','B')),
  answer        jsonb not null default '{}',
  score         numeric,          -- 0..1 for marked questions, null for opinions
  points        int not null default 0,
  ms            int not null default 0,
  feedback      text,
  created_at    timestamptz not null default clock_timestamp(),
  unique (activity_id, run, step, device)
);
create index if not exists responses_programme_idx on public.responses (programme_id, created_at);
alter table public.responses enable row level security;     -- no policies

create table if not exists public.tallies (
  activity_id   uuid not null references public.activities(id) on delete cascade,
  run           text not null,
  step          int  not null,
  counts        jsonb not null default '[]',
  saved_at      timestamptz not null default now(),
  primary key (activity_id, run, step)
);
alter table public.tallies enable row level security;       -- no policies

create table if not exists public.session_feedback (
  checkin_id    uuid primary key references public.checkins(id) on delete cascade,
  programme_id  uuid not null references public.programmes(id) on delete cascade,
  stars         int  not null check (stars between 1 and 5),
  comment       text not null default '' check (char_length(comment) <= 1000),
  created_at    timestamptz not null default now()
);
alter table public.session_feedback enable row level security;  -- no policies

-- 2. Helpers -----------------------------------------------------------------
-- Same shuffle for everyone in a run, different each run.
create or replace function public.assess_shuffle(arr jsonb, seed text)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(x order by md5(x::text || seed)), '[]'::jsonb) from jsonb_array_elements(coalesce(arr,'[]'::jsonb)) x;
$$;

-- What a phone may see of a question: never the answer, until the facilitator reveals it.
create or replace function public.assess_public_step(p_kind text, s jsonb, p_run text, p_reveal boolean)
returns jsonb language plpgsql immutable as $$
declare base jsonb := coalesce(s,'{}'::jsonb) - 'correct' - 'region' - 'items' - 'pairs';
begin
  if p_kind = 'order' then
    base := base || jsonb_build_object('items', public.assess_shuffle(s->'items', p_run));
    if p_reveal then base := base || jsonb_build_object('answer_items', s->'items'); end if;
  elsif p_kind = 'match' then
    base := base || jsonb_build_object(
      'lefts',  (select coalesce(jsonb_agg(p->'l'), '[]'::jsonb) from jsonb_array_elements(coalesce(s->'pairs','[]'::jsonb)) p),
      'rights', public.assess_shuffle((select coalesce(jsonb_agg(p->'r'), '[]'::jsonb) from jsonb_array_elements(coalesce(s->'pairs','[]'::jsonb)) p), p_run));
    if p_reveal then base := base || jsonb_build_object('answer_pairs', s->'pairs'); end if;
  elsif p_kind in ('quiz','buzz','battle','test') then
    if p_reveal then base := base || jsonb_build_object('correct', s->'correct'); end if;
  elsif p_kind = 'spot' then
    if p_reveal then base := base || jsonb_build_object('region', s->'region'); end if;
  end if;
  return base;
end $$;

-- 3. Facilitator: activities ------------------------------------------------
create or replace function public.save_activity(p_pin text, p_programme uuid, p_id uuid, p_kind text, p_title text, p_data jsonb)
returns public.activities language plpgsql security definer set search_path = public as $$
declare rec public.activities;
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  if octet_length(coalesce(p_data,'{}'::jsonb)::text) > 200000 then raise exception 'This activity is too large'; end if;
  if p_id is null then
    insert into public.activities (programme_id, kind, title, data)
    values (p_programme, p_kind, left(coalesce(p_title,''),200), coalesce(p_data,'{"steps":[]}'::jsonb)) returning * into rec;
  else
    update public.activities set kind = p_kind, title = left(coalesce(p_title,''),200), data = coalesce(p_data,'{"steps":[]}'::jsonb), updated_at = now()
     where id = p_id and programme_id = p_programme returning * into rec;
    if rec.id is null then raise exception 'Activity not found'; end if;
  end if;
  return rec;
end $$;

create or replace function public.list_activities(p_pin text, p_programme uuid)
returns setof public.activities language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  return query select * from public.activities where programme_id = p_programme order by created_at desc;
end $$;

-- Question bank: activities from every programme this PIN can manage (to copy into this one).
create or replace function public.bank_activities(p_pin text)
returns table (id uuid, programme text, kind text, title text, data jsonb, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  return query
    select a.id, p.name, a.kind, a.title, a.data, a.created_at
      from public.activities a join public.programmes p on p.id = a.programme_id
     where public.can_manage(p.id, p_pin)
     order by a.created_at desc limit 500;
end $$;

create or replace function public.delete_activity(p_pin text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a public.activities;
begin
  select * into a from public.activities where id = p_id;
  if a.id is null then return; end if;
  if not public.can_manage(a.programme_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  delete from public.activities where id = p_id;
end $$;

-- 4. Facilitator: what is on screen ----------------------------------------
create or replace function public.set_live(p_pin text, p_programme uuid, p_activity uuid, p_run text, p_step int, p_phase text, p_seconds int)
returns public.live_state language plpgsql security definer set search_path = public as $$
declare rec public.live_state;
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  if p_activity is not null and not exists (select 1 from public.activities where id = p_activity and programme_id = p_programme) then
    raise exception 'Activity not found';
  end if;
  insert into public.live_state as l (programme_id, activity_id, run, step, phase, seconds, opened_at, updated_at)
  values (p_programme, p_activity, coalesce(p_run,''), coalesce(p_step,0), p_phase, greatest(coalesce(p_seconds,0),0),
          case when p_phase = 'open' then now() end, now())
  on conflict (programme_id) do update
     set activity_id = excluded.activity_id, run = excluded.run, step = excluded.step, phase = excluded.phase,
         seconds = excluded.seconds,
         opened_at = case when excluded.phase = 'open' then now() else l.opened_at end,
         updated_at = now()
  returning * into rec;
  return rec;
end $$;

-- 5. Phones: see the live question and answer it ---------------------------
create or replace function public.room_current(p_code text, p_device uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.programmes; st public.live_state; a public.activities; s jsonb; mine public.responses;
begin
  select * into pr from public.programmes where code = upper(p_code);
  if pr.id is null then return null; end if;
  select * into st from public.live_state where programme_id = pr.id;
  if st.programme_id is null or st.activity_id is null or st.phase = 'idle' then return jsonb_build_object('phase','idle'); end if;
  select * into a from public.activities where id = st.activity_id;
  if a.id is null then return jsonb_build_object('phase','idle'); end if;
  s := a.data->'steps'->st.step;
  select * into mine from public.responses r where r.activity_id = a.id and r.run = st.run and r.step = st.step and r.device = p_device;
  return jsonb_build_object(
    'phase', st.phase, 'activity', a.id, 'kind', a.kind, 'title', a.title, 'run', st.run, 'step', st.step,
    'steps', jsonb_array_length(coalesce(a.data->'steps','[]'::jsonb)),
    'teams', coalesce((a.data->>'teams')::boolean, a.kind in ('battle','case')),
    'seconds', st.seconds,
    'left', case when st.seconds > 0 and st.phase = 'open' then greatest(0, st.seconds - extract(epoch from now() - st.opened_at)) end,
    'q', public.assess_public_step(a.kind, s, st.run, st.phase = 'reveal'),
    'mine', case when mine.id is not null then jsonb_build_object('answer', mine.answer, 'score', mine.score, 'points', mine.points, 'grp', mine.grp) end,
    'key', st.updated_at);
end $$;

create or replace function public.submit_answer(p_code text, p_device uuid, p_checkin uuid, p_name text, p_grp text, p_answer jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pr public.programmes; st public.live_state; a public.activities; s jsonb;
  sc numeric := null; pts int := 0; ms int; n int; hits int; rk int; rec public.responses; chk uuid := null;
  dx numeric; dy numeric;
begin
  if p_device is null then raise exception 'Missing device'; end if;
  if octet_length(coalesce(p_answer,'{}'::jsonb)::text) > 4000 then raise exception 'Answer is too long'; end if;
  select * into pr from public.programmes where code = upper(p_code);
  if pr.id is null then raise exception 'Room not found'; end if;
  select * into st from public.live_state where programme_id = pr.id;
  if st.programme_id is null or st.phase <> 'open' then raise exception 'Answers are closed'; end if;
  if st.seconds > 0 and now() > st.opened_at + make_interval(secs => st.seconds + 2) then raise exception 'Time is up'; end if;
  select * into a from public.activities where id = st.activity_id;
  s := a.data->'steps'->st.step;
  ms := greatest(0, round(extract(epoch from now() - st.opened_at) * 1000))::int;
  if p_checkin is not null and exists (select 1 from public.checkins where id = p_checkin and programme_id = pr.id) then chk := p_checkin; end if;

  if a.kind in ('quiz','buzz','battle','test') then
    sc := case when (p_answer->>'i') is not null and (p_answer->>'i')::int = (s->>'correct')::int then 1 else 0 end;
  elsif a.kind = 'order' then
    n := jsonb_array_length(coalesce(s->'items','[]'::jsonb));
    select count(*) into hits from generate_series(0, greatest(n-1,0)) i where n > 0 and (p_answer->'items'->>i) = (s->'items'->>i);
    sc := case when n > 0 then hits::numeric / n else 0 end;
  elsif a.kind = 'match' then
    n := jsonb_array_length(coalesce(s->'pairs','[]'::jsonb));
    select count(*) into hits from generate_series(0, greatest(n-1,0)) i where n > 0 and (p_answer->'rights'->>i) = (s->'pairs'->i->>'r');
    sc := case when n > 0 then hits::numeric / n else 0 end;
  elsif a.kind = 'spot' and s ? 'region' then
    dx := ((p_answer->>'x')::numeric - (s->'region'->>'x')::numeric) * coalesce((s->>'aspect')::numeric, 1);
    dy := (p_answer->>'y')::numeric - (s->'region'->>'y')::numeric;
    sc := case when sqrt(dx*dx + dy*dy) <= (s->'region'->>'r')::numeric then 1 else 0 end;
  end if;

  if sc is not null then
    sc := round(sc, 4);
    if a.kind in ('quiz','buzz','battle','test') then
      pts := round(sc * (500 + 500 * greatest(0, 1 - ms / (greatest(case when st.seconds > 0 then st.seconds else 30 end, 5) * 1000.0))));
    else
      pts := round(sc * 1000);
    end if;
  end if;

  insert into public.responses (activity_id, programme_id, run, step, device, checkin_id, name, grp, answer, score, points, ms)
  values (a.id, pr.id, st.run, st.step, p_device, chk, left(coalesce(p_name,''),120),
          case when p_grp in ('A','B') then p_grp else 'all' end, coalesce(p_answer,'{}'::jsonb), sc, pts, ms)
  on conflict (activity_id, run, step, device) do nothing
  returning * into rec;
  if rec.id is null then raise exception 'You already answered'; end if;

  if sc = 1 then
    select count(*) + 1 into rk from public.responses r
     where r.activity_id = a.id and r.run = st.run and r.step = st.step and r.score = 1 and r.created_at < rec.created_at;
  end if;
  return jsonb_build_object('score', sc, 'points', pts, 'ms', ms, 'rank', rk);
end $$;

-- Feedback the facilitator (or AI, on the facilitator's laptop) sends back to phones.
create or replace function public.my_feedback(p_code text, p_device uuid)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'title', a.title, 'kind', a.kind, 'step', r.step,
           'q', a.data->'steps'->r.step->>'q', 'answer', r.answer, 'feedback', r.feedback, 'at', r.created_at) order by r.created_at desc), '[]'::jsonb)
    from public.responses r join public.activities a on a.id = r.activity_id join public.programmes p on p.id = r.programme_id
   where p.code = upper(p_code) and r.device = p_device and r.feedback is not null;
$$;

-- 6. Facilitator: results ---------------------------------------------------
create or replace function public.results(p_pin text, p_activity uuid, p_run text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.activities;
begin
  select * into a from public.activities where id = p_activity;
  if a.id is null then return '[]'::jsonb; end if;
  if not public.can_manage(a.programme_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'step', r.step, 'device', r.device, 'checkin', r.checkin_id,
            'name', coalesce(nullif(r.name,''), c.name, ''), 'title', c.title, 'mda', c.mda, 'photo', c.photo_url, 'grp', r.grp,
            'answer', r.answer, 'score', r.score, 'points', r.points, 'ms', r.ms, 'feedback', r.feedback, 'at', r.created_at)
            order by r.created_at), '[]'::jsonb)
          from public.responses r left join public.checkins c on c.id = r.checkin_id
         where r.activity_id = p_activity and r.run = p_run);
end $$;

create or replace function public.programme_results(p_pin text, p_programme uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage(p_programme, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  return jsonb_build_object(
    'responses', (select coalesce(jsonb_agg(jsonb_build_object('activity', r.activity_id, 'run', r.run, 'step', r.step, 'device', r.device,
                   'checkin', r.checkin_id, 'name', coalesce(nullif(r.name,''), c.name, ''), 'grp', r.grp, 'answer', r.answer,
                   'score', r.score, 'points', r.points, 'ms', r.ms, 'feedback', r.feedback, 'at', r.created_at) order by r.created_at), '[]'::jsonb)
                  from public.responses r left join public.checkins c on c.id = r.checkin_id where r.programme_id = p_programme),
    'tallies',   (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.tallies t join public.activities a on a.id = t.activity_id where a.programme_id = p_programme),
    'feedback',  (select coalesce(jsonb_agg(jsonb_build_object('checkin', f.checkin_id, 'name', c.name, 'title', c.title, 'mda', c.mda,
                   'stars', f.stars, 'comment', f.comment, 'at', f.created_at) order by f.created_at), '[]'::jsonb)
                  from public.session_feedback f join public.checkins c on c.id = f.checkin_id where f.programme_id = p_programme));
end $$;

create or replace function public.set_response_feedback(p_pin text, p_response uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.responses;
begin
  select * into r from public.responses where id = p_response;
  if r.id is null then return; end if;
  if not public.can_manage(r.programme_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  update public.responses set feedback = nullif(left(coalesce(p_text,''), 2000), '') where id = p_response;
end $$;

create or replace function public.save_tally(p_pin text, p_activity uuid, p_run text, p_step int, p_counts jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare a public.activities;
begin
  select * into a from public.activities where id = p_activity;
  if a.id is null then raise exception 'Activity not found'; end if;
  if not public.can_manage(a.programme_id, p_pin) then raise exception 'Wrong PIN for this programme'; end if;
  insert into public.tallies (activity_id, run, step, counts) values (p_activity, p_run, p_step, coalesce(p_counts,'[]'::jsonb))
  on conflict (activity_id, run, step) do update set counts = excluded.counts, saved_at = now();
end $$;

-- 7. Tap-out feedback (stars + comment) -------------------------------------
create or replace function public.leave_feedback(p_checkin uuid, p_stars int, p_comment text)
returns void language plpgsql security definer set search_path = public as $$
declare c public.checkins;
begin
  select * into c from public.checkins where id = p_checkin;
  if c.id is null or c.programme_id is null then raise exception 'Check-in not found'; end if;
  if p_stars not between 1 and 5 then raise exception 'Choose 1 to 5 stars'; end if;
  insert into public.session_feedback (checkin_id, programme_id, stars, comment)
  values (c.id, c.programme_id, p_stars, left(coalesce(p_comment,''), 1000))
  on conflict (checkin_id) do update set stars = excluded.stars, comment = excluded.comment, created_at = now();
end $$;

-- 8. Permissions and live updates ------------------------------------------
revoke all on function public.assess_shuffle(jsonb, text) from public, anon, authenticated;
revoke all on function public.assess_public_step(text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.save_activity(text, uuid, uuid, text, text, jsonb)       to anon, authenticated;
grant execute on function public.list_activities(text, uuid)                              to anon, authenticated;
grant execute on function public.bank_activities(text)                                    to anon, authenticated;
grant execute on function public.delete_activity(text, uuid)                              to anon, authenticated;
grant execute on function public.set_live(text, uuid, uuid, text, int, text, int)          to anon, authenticated;
grant execute on function public.room_current(text, uuid)                                 to anon, authenticated;
grant execute on function public.submit_answer(text, uuid, uuid, text, text, jsonb)       to anon, authenticated;
grant execute on function public.my_feedback(text, uuid)                                  to anon, authenticated;
grant execute on function public.results(text, uuid, text)                                to anon, authenticated;
grant execute on function public.programme_results(text, uuid)                            to anon, authenticated;
grant execute on function public.set_response_feedback(text, uuid, text)                  to anon, authenticated;
grant execute on function public.save_tally(text, uuid, text, int, jsonb)                 to anon, authenticated;
grant execute on function public.leave_feedback(uuid, int, text)                          to anon, authenticated;

alter table public.live_state replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.live_state; exception when duplicate_object then null; end;
end $$;
