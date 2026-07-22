create or replace view public.helper_presence
with (security_invoker = true)
as
select
  helpers.*,
  (
    helpers.revoked_at is null
    and helpers.status in ('online', 'busy')
    and helpers.last_seen_at > now() - interval '45 seconds'
  ) as is_online
from public.helpers;

grant select on public.helper_presence to authenticated, service_role;
