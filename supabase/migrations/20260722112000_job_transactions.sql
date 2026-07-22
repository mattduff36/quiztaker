create or replace function public.consume_plan_and_create_job(
  p_plan_id uuid,
  p_user_id uuid,
  p_job_id uuid
)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_plan public.plans;
  created_job public.jobs;
begin
  update public.plans
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

  insert into public.jobs (
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

create or replace function public.claim_next_helper_job(
  p_helper_id uuid,
  p_user_id uuid
)
returns setof public.jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.jobs
  set status = 'queued',
      dispatched_at = null
  where helper_id = p_helper_id
    and user_id = p_user_id
    and status = 'dispatched'
    and started_at is null
    and dispatched_at < now() - interval '5 minutes'
    and cancel_requested = false;

  update public.jobs
  set status = 'helper-offline',
      finished_at = now(),
      outcome = jsonb_build_object(
        'outcome', 'failure',
        'verified', false,
        'status', 'helper-offline'
      )
  where helper_id = p_helper_id
    and user_id = p_user_id
    and status = 'running'
    and exists (
      select 1 from public.helpers
      where id = p_helper_id
        and last_seen_at < now() - interval '2 minutes'
    );

  return query
    update public.jobs
    set status = 'dispatched',
        dispatched_at = now()
    where id = (
      select id
      from public.jobs
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

revoke all on function public.consume_plan_and_create_job(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_next_helper_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.consume_plan_and_create_job(uuid, uuid, uuid) to service_role;
grant execute on function public.claim_next_helper_job(uuid, uuid) to service_role;
