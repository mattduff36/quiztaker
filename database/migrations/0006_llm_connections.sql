-- One hosted learner connection per owner. Ciphertext is AES-256-GCM material
-- written by the app; queries must also filter on user_id.
create table if not exists llm_connections (
  user_id text primary key references profiles(id) on delete cascade,
  provider text not null,
  model text not null default '',
  ciphertext text,
  iv text,
  auth_tag text,
  tested_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint llm_connections_provider_check check (
    provider in ('openai', 'gemini', 'openrouter', 'disabled')
  ),
  constraint llm_connections_shape_check check (
    (
      provider = 'disabled'
      and model = ''
      and ciphertext is null
      and iv is null
      and auth_tag is null
      and tested_at is null
    )
    or (
      provider in ('openai', 'gemini', 'openrouter')
      and char_length(model) between 1 and 80
      and ciphertext is not null and iv is not null and auth_tag is not null
      and char_length(ciphertext) > 0
      and char_length(iv) > 0
      and char_length(auth_tag) > 0
      and tested_at is not null
    )
  )
);

alter table llm_connections enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = current_schema()
      and tablename = 'llm_connections'
      and policyname = 'llm_connections_owner_policy'
  ) then
    execute $policy$
      create policy llm_connections_owner_policy on llm_connections
        using (user_id = current_app_user_id())
        with check (user_id = current_app_user_id())
    $policy$;
  end if;
end $$;

-- Shared cooldown and cancellation token across serverless instances.
create table llm_connection_tests (
  user_id text primary key references profiles(id) on delete cascade,
  request_id uuid not null default gen_random_uuid(),
  requested_at timestamptz not null default now()
);
alter table llm_connection_tests enable row level security;
create policy llm_connection_tests_owner_policy on llm_connection_tests
  using (user_id = current_app_user_id())
  with check (user_id = current_app_user_id());
