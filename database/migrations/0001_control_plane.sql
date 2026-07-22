create extension if not exists pgcrypto;

create table profiles (
  id text primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table helpers (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  device_name text not null,
  platform text not null default 'win32',
  architecture text not null default 'x64',
  version text not null,
  status text not null default 'offline' check (status in ('offline', 'online', 'busy', 'revoked')),
  cdp_port integer not null default 9222 check (cdp_port between 1024 and 65535),
  active_job_id uuid,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  unique (user_id, device_name)
);

create table pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  helper_id uuid references helpers(id) on delete set null,
  created_at timestamptz not null default now()
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid not null references helpers(id) on delete cascade,
  source text not null,
  capability_id text not null,
  capability_version integer not null,
  script text not null,
  args jsonb not null default '[]'::jsonb check (jsonb_typeof(args) = 'array'),
  label text not null,
  risk text not null check (risk in ('none', 'low', 'medium', 'high')),
  mutates_course boolean not null,
  verifier text not null,
  steps jsonb not null default '[]'::jsonb,
  constraints jsonb,
  targets jsonb not null default '[]'::jsonb,
  confidence double precision not null default 0 check (confidence between 0 and 1),
  evidence jsonb not null default '[]'::jsonb,
  fingerprint text,
  tab_idx integer,
  confirmed boolean not null default false,
  consumed boolean not null default false,
  confirmed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid not null references helpers(id) on delete cascade,
  plan_id uuid not null unique references plans(id) on delete cascade,
  attempt_id uuid not null,
  capability_id text not null,
  capability_version integer not null,
  script text not null,
  args jsonb not null default '[]'::jsonb,
  fingerprint text,
  nonce uuid not null default gen_random_uuid() unique,
  status text not null default 'queued' check (
    status in ('queued', 'dispatched', 'running', 'completed', 'failed', 'cancelled', 'helper-offline')
  ),
  cancel_requested boolean not null default false,
  exit_code integer,
  outcome jsonb,
  diagnosis jsonb,
  output_url text,
  dispatched_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

alter table helpers
  add constraint helpers_active_job_id_fkey
  foreign key (active_job_id) references jobs(id) on delete set null
  deferrable initially deferred;

create table job_events (
  id bigint generated always as identity primary key,
  user_id text not null references profiles(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  event text not null check (event in ('accepted', 'started', 'stdout', 'stderr', 'completed', 'failed', 'cancelled')),
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (job_id, sequence)
);

create table attempt_events (
  id bigint generated always as identity primary key,
  user_id text not null references profiles(id) on delete cascade,
  attempt_id uuid not null,
  event text not null,
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table history_events (
  id bigint generated always as identity primary key,
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid references helpers(id) on delete set null,
  source_id text,
  kind text not null,
  title text not null,
  result text not null,
  detail text not null default '',
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique nulls not distinct (user_id, helper_id, source_id)
);

create table strategies (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  capability_id text not null,
  capability_version integer not null,
  fingerprint text,
  status text not null default 'candidate' check (status in ('candidate', 'promoted', 'needs-review')),
  successes integer not null default 0 check (successes >= 0),
  failures integer not null default 0 check (failures >= 0),
  targets jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  last_failure_signature text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique nulls not distinct (user_id, capability_id, capability_version, fingerprint)
);

create table review_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  attempt_id uuid,
  strategy_id uuid references strategies(id) on delete set null,
  type text not null,
  title text not null,
  detail text not null default '',
  next_action text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid references helpers(id) on delete set null,
  job_id uuid references jobs(id) on delete cascade,
  storage_url text not null unique,
  pathname text not null,
  media_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  created_at timestamptz not null default now()
);

create index helpers_user_presence_idx on helpers (user_id, last_seen_at desc);
create index pairing_codes_expiry_idx on pairing_codes (expires_at) where claimed_at is null;
create index plans_user_expiry_idx on plans (user_id, expires_at desc);
create index jobs_helper_poll_idx on jobs (helper_id, created_at) where status = 'queued' and cancel_requested = false;
create index jobs_user_status_idx on jobs (user_id, status, created_at desc);
create index job_events_job_sequence_idx on job_events (job_id, sequence);
create index attempt_events_attempt_idx on attempt_events (attempt_id, occurred_at);
create index history_events_user_time_idx on history_events (user_id, occurred_at desc);
create index review_items_user_status_idx on review_items (user_id, status, created_at desc);

create or replace function current_app_user_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '');
$$;

alter table profiles enable row level security;
alter table helpers enable row level security;
alter table pairing_codes enable row level security;
alter table plans enable row level security;
alter table jobs enable row level security;
alter table job_events enable row level security;
alter table attempt_events enable row level security;
alter table history_events enable row level security;
alter table strategies enable row level security;
alter table review_items enable row level security;
alter table artifacts enable row level security;

create policy profiles_owner_policy on profiles
  using (id = current_app_user_id())
  with check (id = current_app_user_id());

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'helpers', 'pairing_codes', 'plans', 'jobs', 'job_events',
    'attempt_events', 'history_events', 'strategies', 'review_items', 'artifacts'
  ] loop
    execute format(
      'create policy %1$I on %2$I using (user_id = current_app_user_id()) with check (user_id = current_app_user_id())',
      table_name || '_owner_policy',
      table_name
    );
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
    capability_id, capability_version, script, args, fingerprint
  ) values (
    p_job_id, selected_plan.user_id, selected_plan.helper_id, selected_plan.id, selected_plan.attempt_id,
    selected_plan.capability_id, selected_plan.capability_version, selected_plan.script,
    selected_plan.args, selected_plan.fingerprint
  ) returning * into created_job;

  return created_job;
end;
$$;

create or replace function claim_next_helper_job(
  p_helper_id uuid,
  p_user_id text
)
returns setof jobs
language plpgsql
security invoker
as $$
begin
  update jobs
  set status = 'queued',
      dispatched_at = null
  where helper_id = p_helper_id
    and user_id = p_user_id
    and status = 'dispatched'
    and started_at is null
    and dispatched_at < now() - interval '5 minutes'
    and cancel_requested = false;

  update jobs
  set status = 'helper-offline',
      finished_at = now(),
      outcome = jsonb_build_object('outcome', 'failure', 'verified', false, 'status', 'helper-offline')
  where helper_id = p_helper_id
    and user_id = p_user_id
    and status = 'running'
    and exists (
      select 1 from helpers
      where id = p_helper_id
        and last_seen_at < now() - interval '2 minutes'
    );

  return query
    update jobs
    set status = 'dispatched',
        dispatched_at = now()
    where id = (
      select id
      from jobs
      where helper_id = p_helper_id
        and user_id = p_user_id
        and status = 'queued'
        and cancel_requested = false
      order by created_at
      for update skip locked
      limit 1
    )
    returning *;
end;
$$;

create or replace function claim_pairing_code(
  p_code_hash text,
  p_device_name text,
  p_platform text,
  p_architecture text,
  p_version text
)
returns helpers
language plpgsql
security invoker
as $$
declare
  pairing pairing_codes;
  claimed_helper helpers;
begin
  select * into pairing
  from pairing_codes
  where code_hash = p_code_hash
    and claimed_at is null
    and expires_at > now()
  for update;

  if pairing.id is null then
    raise exception 'Pairing code is invalid or expired';
  end if;

  update helpers
  set status = 'revoked', revoked_at = now()
  where user_id = pairing.user_id
    and device_name <> p_device_name
    and revoked_at is null;

  insert into helpers (
    user_id, device_name, platform, architecture, version,
    status, last_seen_at, revoked_at
  ) values (
    pairing.user_id, p_device_name, p_platform, p_architecture, p_version,
    'online', now(), null
  )
  on conflict (user_id, device_name) do update set
    platform = excluded.platform,
    architecture = excluded.architecture,
    version = excluded.version,
    status = 'online',
    last_seen_at = now(),
    revoked_at = null
  returning * into claimed_helper;

  update pairing_codes
  set claimed_at = now(), helper_id = claimed_helper.id
  where id = pairing.id;

  return claimed_helper;
end;
$$;

create or replace view helper_presence as
select
  helpers.*,
  (
    helpers.revoked_at is null
    and helpers.status in ('online', 'busy')
    and helpers.last_seen_at > now() - interval '45 seconds'
  ) as is_online
from helpers;
