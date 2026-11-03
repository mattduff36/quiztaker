import { queryRows, withTransaction, type SqlQuery } from '@/lib/db';
import { requestHelperJobCancellation, type JobRecoveryDeps } from '@/lib/job-recovery';
import { retryDatabaseConflict } from '@/lib/database-retry';
import { OPERATOR_IDLE_MS, BROWSER_REFRESH_MS } from '@/lib/operations-policy';

type Row = { last_activity_at: string | Date; paused_at: string | Date | null; now: string | Date };
export type OperatorActivity = { paused: boolean; lastActivityAt: string; expiresAt: string; serverNow: string };
const database: JobRecoveryDeps = { query: queryRows, transaction: withTransaction };

export async function readOperatorActivity(userId: string, helperId: string): Promise<OperatorActivity | null> {
  const [row] = await queryRows<Row>('select last_activity_at,paused_at,clock_timestamp() as now from operator_activity where user_id=$1 and helper_id=$2',[userId,helperId]);
  if (!row) return null;
  const last = new Date(row.last_activity_at), now = new Date(row.now);
  return {paused:Boolean(row.paused_at) || now.getTime()-last.getTime()>=OPERATOR_IDLE_MS,lastActivityAt:last.toISOString(),expiresAt:new Date(last.getTime()+OPERATOR_IDLE_MS).toISOString(),serverNow:now.toISOString()};
}

export async function operatorActivity(userId: string, helperId: string, action: 'check' | 'activity' | 'resume' | 'pause' = 'check', deps = database): Promise<OperatorActivity> {
  return retryDatabaseConflict(() => deps.transaction(async sql => {
    // Every job admission locks this row before helpers. Never acquire it while holding jobs/helpers.
    await sql(`insert into operator_activity(user_id,helper_id) values($1,$2) on conflict do nothing`, [userId,helperId]);
    const [row] = await sql<Row>(`select last_activity_at,paused_at,clock_timestamp() as now from operator_activity where user_id=$1 and helper_id=$2 for update`, [userId,helperId]);
    const now = new Date(row.now);
    const expired = now.getTime() - new Date(row.last_activity_at).getTime() >= OPERATOR_IDLE_MS;
    const paused = action === 'resume' ? false : action === 'pause' || Boolean(row.paused_at) || expired;
    const renew = action === 'resume' || (action === 'activity' && !paused);
    const last = renew ? now : new Date(row.last_activity_at);
    await sql(`update operator_activity set last_activity_at=$3,paused_at=$4 where user_id=$1 and helper_id=$2`, [userId,helperId,last.toISOString(),paused ? new Date(row.paused_at || now).toISOString() : null]);
    if (paused) {
      // Retain tabs, credentials and course memory. Existing helper cancellation stops its process tree.
      // Reuse the normal cancellation ledger in the same transaction so a concurrent Resume cannot race it.
      await requestHelperJobCancellation({userId,helperId,excludeCapabilities:['close-browser']}, {query:sql,transaction:fn=>fn(sql)});
    }
    return {paused,lastActivityAt:last.toISOString(),expiresAt:new Date(last.getTime()+OPERATOR_IDLE_MS).toISOString(),serverNow:now.toISOString()};
  }));
}

export async function enforceOperatorIdle(userId: string, helperId: string, deps = database): Promise<void> {
  // Helpers without an Operations page remain compatible; only registered sessions have an idle lease.
  const rows = await deps.query(`select 1 from operator_activity where user_id=$1 and helper_id=$2 and (paused_at is not null or last_activity_at <= now()-interval '30 minutes')`, [userId,helperId]);
  if (rows.length) await operatorActivity(userId,helperId,'check',deps);
}

export async function assertOperatorActive(userId: string, helperId: string, sql: SqlQuery): Promise<void> {
  await sql('insert into operator_activity(user_id,helper_id) values($1,$2) on conflict do nothing',[userId,helperId]);
  const [row] = await sql<{paused: boolean}>(`select (paused_at is not null or last_activity_at <= now()-interval '30 minutes') as paused from operator_activity where user_id=$1 and helper_id=$2 for update`, [userId,helperId]);
  if (row?.paused) throw new Error('Your session is paused. Choose Resume session before starting another task.');
}

export async function reserveBrowserRefresh(userId: string, helperId: string, force = false, deps = database): Promise<boolean> {
  return deps.transaction(async sql => {
    await assertOperatorActive(userId,helperId,sql);
    const [row] = await sql(`update operator_activity set last_browser_probe_at=now()
      where user_id=$1 and helper_id=$2 and paused_at is null
      and (last_browser_probe_at is null or last_browser_probe_at < now()-($3::int * interval '1 millisecond'))
      and exists(select 1 from helper_presence where id=$2 and user_id=$1 and is_online)
      and not exists(select 1 from jobs where user_id=$1 and helper_id=$2 and status in ('queued','dispatched','running')) returning helper_id`, [userId,helperId,force ? 2_000 : BROWSER_REFRESH_MS]);
    return Boolean(row);
  });
}
