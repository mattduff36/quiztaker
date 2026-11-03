create table operator_activity (
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid not null references helpers(id) on delete cascade,
  last_activity_at timestamptz not null default now(),
  paused_at timestamptz,
  last_browser_probe_at timestamptz,
  primary key (user_id, helper_id)
);
alter table operator_activity enable row level security;
create policy operator_activity_owner_policy on operator_activity
  using (user_id = current_app_user_id()) with check (user_id = current_app_user_id());
