alter table helpers add column browser_change_token text;
alter table browser_sessions add column browser_change_token text;

-- Only newly completed tasks create a countdown; history is never backfilled.
create table operations_followups (
  job_id uuid primary key references jobs(id) on delete cascade,
  helper_id uuid not null references helpers(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  browser_session_id uuid not null references browser_sessions(id) on delete cascade,
  deadline timestamptz not null default now()+interval '20 seconds',
  state text not null default 'waiting' check(state in ('waiting','cancelled','closing','closed','failed')),
  close_job_id uuid references jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index operations_followups_helper_idx on operations_followups(user_id,helper_id,created_at desc);
alter table operations_followups enable row level security;
create policy own_operations_followups on operations_followups for all
  using(user_id=current_app_user_id())
  with check(user_id=current_app_user_id());
