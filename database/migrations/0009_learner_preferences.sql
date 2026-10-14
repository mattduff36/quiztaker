-- One reusable learner-instruction row per owner. The application also filters
-- on user_id for every read and write. Instruction text is an operator
-- preference, not authorization material.
create table if not exists learner_preferences (
  user_id text primary key references profiles(id) on delete cascade,
  instructions text not null,
  updated_at timestamptz not null default now(),
  constraint learner_preferences_instructions_len check (
    char_length(instructions) between 1 and 2000
  )
);

alter table learner_preferences enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = current_schema()
      and tablename = 'learner_preferences'
      and policyname = 'learner_preferences_owner_policy'
  ) then
    execute $policy$
      create policy learner_preferences_owner_policy on learner_preferences
        using (user_id = current_app_user_id())
        with check (user_id = current_app_user_id())
    $policy$;
  end if;
end $$;
