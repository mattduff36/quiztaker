create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

create table public.helpers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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

create table public.pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  helper_id uuid references public.helpers(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  helper_id uuid not null references public.helpers(id) on delete cascade,
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

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  helper_id uuid not null references public.helpers(id) on delete cascade,
  plan_id uuid not null unique references public.plans(id) on delete cascade,
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
  output_path text,
  dispatched_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.helpers
  add constraint helpers_active_job_id_fkey
  foreign key (active_job_id) references public.jobs(id) on delete set null
  deferrable initially deferred;

create table public.job_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  event text not null check (event in ('accepted', 'started', 'stdout', 'stderr', 'completed', 'failed', 'cancelled')),
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (job_id, sequence)
);

create table public.attempt_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_id uuid not null,
  event text not null,
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table public.history_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  helper_id uuid references public.helpers(id) on delete set null,
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

create table public.strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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

create table public.review_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_id uuid,
  strategy_id uuid references public.strategies(id) on delete set null,
  type text not null,
  title text not null,
  detail text not null default '',
  next_action text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  helper_id uuid references public.helpers(id) on delete set null,
  job_id uuid references public.jobs(id) on delete cascade,
  storage_path text not null unique,
  media_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  created_at timestamptz not null default now()
);

create index helpers_user_presence_idx on public.helpers (user_id, last_seen_at desc);
create index pairing_codes_expiry_idx on public.pairing_codes (expires_at) where claimed_at is null;
create index plans_user_expiry_idx on public.plans (user_id, expires_at desc);
create index jobs_helper_poll_idx on public.jobs (helper_id, created_at) where status = 'queued';
create index jobs_user_status_idx on public.jobs (user_id, status, created_at desc);
create index job_events_job_sequence_idx on public.job_events (job_id, sequence);
create index attempt_events_attempt_idx on public.attempt_events (attempt_id, occurred_at);
create index history_events_user_time_idx on public.history_events (user_id, occurred_at desc);
create index review_items_user_status_idx on public.review_items (user_id, status, created_at desc);

alter table public.profiles enable row level security;
alter table public.helpers enable row level security;
alter table public.pairing_codes enable row level security;
alter table public.plans enable row level security;
alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.attempt_events enable row level security;
alter table public.history_events enable row level security;
alter table public.strategies enable row level security;
alter table public.review_items enable row level security;
alter table public.artifacts enable row level security;

create policy "users manage own profiles" on public.profiles
  for all using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'helpers', 'pairing_codes', 'plans', 'jobs', 'job_events',
    'attempt_events', 'history_events', 'strategies', 'review_items', 'artifacts'
  ] loop
    execute format(
      'create policy "users manage own %1$s" on public.%1$I for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name
    );
  end loop;
end $$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

insert into storage.buckets (id, name, public, file_size_limit)
values ('private-artifacts', 'private-artifacts', false, 52428800)
on conflict (id) do nothing;

create policy "users read own artifact objects" on storage.objects
  for select using (
    bucket_id = 'private-artifacts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "users upload own artifact objects" on storage.objects
  for insert with check (
    bucket_id = 'private-artifacts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
