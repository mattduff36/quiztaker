-- helpers.* is expanded when the view is created. Columns added in 0003 and
-- 0004 were not visible through helper_presence until the view was replaced.
drop view if exists helper_presence;

create view helper_presence
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
