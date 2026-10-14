-- User-owned course conversation memory. Rows are bound to one owner, helper,
-- and browser session. The application also filters those columns on every read
-- and write; remembered text is not authorization material.
create table if not exists learner_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references profiles(id) on delete cascade,
  helper_id uuid not null references helpers(id) on delete cascade,
  browser_session_id uuid not null,
  objective text,
  history jsonb not null default '[]'::jsonb,
  materials jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, helper_id, browser_session_id),
  constraint learner_sessions_objective_len check (
    objective is null or char_length(objective) <= 1000
  ),
  constraint learner_sessions_history_array check (jsonb_typeof(history) = 'array'),
  constraint learner_sessions_materials_array check (jsonb_typeof(materials) = 'array')
);

create index if not exists learner_sessions_scope_idx
  on learner_sessions (user_id, helper_id, browser_session_id, updated_at desc);

alter table learner_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = current_schema()
      and tablename = 'learner_sessions'
      and policyname = 'learner_sessions_owner_policy'
  ) then
    execute $policy$
      create policy learner_sessions_owner_policy on learner_sessions
        using (user_id = current_app_user_id())
        with check (user_id = current_app_user_id())
    $policy$;
  end if;
end $$;
