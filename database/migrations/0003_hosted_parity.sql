alter table helpers
  add column if not exists protocol_version integer not null default 1,
  add column if not exists supported_capabilities jsonb not null default '[]'::jsonb;

alter table plans
  add column if not exists input jsonb not null default '{}'::jsonb,
  add column if not exists browser_session_id uuid,
  add column if not exists target_revision integer;

alter table jobs
  add column if not exists input jsonb not null default '{}'::jsonb,
  add column if not exists result jsonb;

alter table strategies
  add column if not exists revision bigint not null default 1,
  add column if not exists evidence jsonb not null default '{}'::jsonb;

-- helper_presence selects helpers.*, so protocol_version and supported_capabilities
-- are visible without replacing the security_invoker view.

create table if not exists browser_sessions (
  id uuid primary key,
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid not null references helpers(id) on delete cascade,
  revision integer not null check (revision > 0),
  cdp_connected boolean not null default false,
  tabs jsonb not null default '[]'::jsonb,
  roster jsonb,
  detection jsonb,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists browser_sessions_open_helper_idx
  on browser_sessions (helper_id)
  where closed_at is null;

create table if not exists recent_urls (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid references helpers(id) on delete set null,
  url text not null,
  title text not null default '',
  seen_count integer not null default 1 check (seen_count > 0),
  last_seen_at timestamptz not null default now(),
  forgotten_at timestamptz,
  last_job_id uuid,
  unique (user_id, url)
);

alter table recent_urls add column if not exists last_job_id uuid;

create index if not exists recent_urls_user_seen_idx
  on recent_urls (user_id, last_seen_at desc)
  where forgotten_at is null;

create table if not exists operator_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid references helpers(id) on delete set null,
  idempotency_key text not null,
  status text not null check (status in ('open', 'ending', 'ended', 'close_failed')),
  recap jsonb not null default '{}'::jsonb,
  needs_review jsonb not null default '[]'::jsonb,
  close_job_id uuid references jobs(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (user_id, idempotency_key)
);

create table if not exists learning_captures (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid references helpers(id) on delete set null,
  source_id text not null,
  fingerprint text,
  title text not null,
  detail text not null default '',
  artifact_ids jsonb not null default '[]'::jsonb,
  probe jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null,
  unique (user_id, source_id)
);

create table if not exists sync_cursors (
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid not null references helpers(id) on delete cascade,
  stream text not null,
  cursor text not null,
  updated_at timestamptz not null default now(),
  primary key (helper_id, stream)
);

alter table browser_sessions enable row level security;
alter table recent_urls enable row level security;
alter table operator_sessions enable row level security;
alter table learning_captures enable row level security;
alter table sync_cursors enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'browser_sessions', 'recent_urls', 'operator_sessions', 'learning_captures', 'sync_cursors'
  ] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = current_schema()
        and tablename = table_name
        and policyname = table_name || '_owner_policy'
    ) then
      execute format(
        'create policy %1$I on %2$I using (user_id = current_app_user_id()) with check (user_id = current_app_user_id())',
        table_name || '_owner_policy',
        table_name
      );
    end if;
  end loop;
end $$;

create or replace function consume_plan_and_create_job(
  p_plan_id uuid,
  p_user_id text,
  p_job_id uuid
)
returns jobs
language plpgsql
security invoker
as $$
declare
  selected_plan plans;
  created_job jobs;
begin
  update plans
  set consumed = true
  where id = p_plan_id
    and user_id = p_user_id
    and confirmed = true
    and consumed = false
    and expires_at > now()
  returning * into selected_plan;

  if selected_plan.id is null then
    raise exception 'Plan is missing, unconfirmed, consumed, or expired';
  end if;

  insert into jobs (
    id, user_id, helper_id, plan_id, attempt_id,
    capability_id, capability_version, script, args, fingerprint, input
  ) values (
    p_job_id, selected_plan.user_id, selected_plan.helper_id, selected_plan.id, selected_plan.attempt_id,
    selected_plan.capability_id, selected_plan.capability_version, selected_plan.script,
    selected_plan.args, selected_plan.fingerprint, selected_plan.input
  ) returning * into created_job;

  return created_job;
end;
$$;
