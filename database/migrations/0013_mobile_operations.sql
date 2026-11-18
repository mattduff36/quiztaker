-- Ephemeral encrypted relay. Only one latest frame and one pending command per viewer.
create table remote_sessions (
  id uuid primary key,
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid not null references helpers(id) on delete cascade,
  client_id uuid not null,
  viewer_key text not null check (length(viewer_key) = 88),
  helper_key text check (length(helper_key) = 88),
  expires_at timestamptz not null,
  ready boolean not null default false,
  frame jsonb,
  frame_seq bigint not null default 0,
  command jsonb,
  command_seq bigint not null default 0,
  acknowledged_seq bigint not null default 0,
  status text not null default 'Connecting to helper',
  unique(helper_id,client_id)
);
create index remote_sessions_expiry_idx on remote_sessions(expires_at);
alter table helpers add column remote_session_id uuid, add column remote_lease_until timestamptz;
create table operations_drafts (
  helper_id uuid primary key references helpers(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  session_id uuid,
  revision bigint not null default 1,
  client_id uuid,
  draft jsonb not null default '{}'::jsonb,
  workflow_id uuid,
  workflow_client_id uuid,
  workflow_until timestamptz,
  updated_at timestamptz not null default now()
);
create table operations_requests (
  helper_id uuid not null references helpers(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  request_id uuid not null,
  request_hash text not null,
  response jsonb not null,
  status integer not null,
  expires_at timestamptz not null default now()+interval '1 day',
  primary key(helper_id,request_id)
);
do $$
declare t text;
begin
  foreach t in array array['remote_sessions','operations_drafts','operations_requests'] loop
    execute format('alter table %I enable row level security',t);
    execute format('create policy %I on %I using (user_id=current_app_user_id()) with check (user_id=current_app_user_id())',t||'_owner_policy',t);
  end loop;
end $$;

-- Preserve the existing claim/recovery implementation behind an atomic helper gate.
alter table plans add column operations_workflow_id uuid, add column operations_client_id uuid;
alter function claim_next_helper_job(uuid,text) rename to claim_next_helper_job_without_remote;
create function claim_next_helper_job(p_helper_id uuid,p_user_id text)
returns setof jobs language plpgsql security invoker set search_path=public as $$
declare h helpers;
begin
  select * into h from helpers where id=p_helper_id and user_id=p_user_id and revoked_at is null for update;
  if h.id is null or h.remote_lease_until > now() then return; end if;
  return query select * from claim_next_helper_job_without_remote(p_helper_id,p_user_id);
end $$;
