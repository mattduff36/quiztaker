/** Serialize terminal events without blocking heartbeat's active_job_id FK check. */
export const TERMINAL_JOB_LOCK_SQL =
  'select status from jobs where id = $1 and helper_id = $2 and user_id = $3 for no key update';
