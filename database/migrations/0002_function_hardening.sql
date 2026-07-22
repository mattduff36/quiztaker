alter function consume_plan_and_create_job(uuid, text, uuid)
  set search_path = public;

alter function claim_next_helper_job(uuid, text)
  set search_path = public;

alter function claim_pairing_code(text, text, text, text, text)
  set search_path = public;

create or replace view helper_presence
with (security_invoker = true)
as
select
  helpers.*,
  (
    helpers.revoked_at is null
    and helpers.status in ('online', 'busy')
    and helpers.last_seen_at > now() - interval '45 seconds'
  ) as is_online
from helpers;
