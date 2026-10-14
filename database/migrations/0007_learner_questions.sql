-- A learner question ends its bounded job without scoring a failed attempt.
alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check check (
  status in ('queued', 'dispatched', 'running', 'completed', 'failed', 'cancelled', 'helper-offline', 'awaiting-input')
);
