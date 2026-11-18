import {queryRows,withTransaction,type SqlQuery} from '@/lib/db';
import {completedCourseTask,type TaskFollowup} from './task-followup-policy';

/** Called only with real terminal evidence, never when an old page is opened. */
export async function armTaskFollowup(sql:SqlQuery,job:{id:string;user_id:string;helper_id:string;capability_id:string;status:string;outcome:Parameters<typeof completedCourseTask>[0]['outcome']}) {
  if(!completedCourseTask(job))return;
  await sql(`insert into operations_followups(job_id,user_id,helper_id,browser_session_id)
    select j.id,j.user_id,j.helper_id,p.browser_session_id from jobs j join plans p on p.id=j.plan_id
    join browser_sessions s on s.id=p.browser_session_id and s.user_id=j.user_id and s.helper_id=j.helper_id and s.closed_at is null
    join operations_drafts d on d.user_id=j.user_id and d.helper_id=j.helper_id and d.session_id=s.id
    where j.id=$1 and j.user_id=$2 and j.helper_id=$3 and j.finished_at>now()-interval '30 seconds'
    on conflict(job_id) do nothing`,[job.id,job.user_id,job.helper_id]);
}
export async function cancelTaskFollowup(userId:string,helperId:string,jobId?:string,sql:SqlQuery=queryRows) {
  await sql(`update operations_followups set state='cancelled',updated_at=now()
    where user_id=$1 and helper_id=$2 and state='waiting' and ($3::uuid is null or job_id=$3)`,[userId,helperId,jobId??null]);
}
export async function readTaskFollowup(userId:string,helperId:string):Promise<TaskFollowup|null> {
  await queryRows("update operations_followups set state='failed',updated_at=now() where user_id=$1 and helper_id=$2 and state='closing' and close_job_id is null and updated_at<now()-interval '60 seconds'",[userId,helperId]);
  const [row]=await queryRows<{job_id:string;browser_session_id:string;deadline:string;server_now:string;state:TaskFollowup['state'];close_job_id:string|null}>(`select f.*,clock_timestamp() as server_now from operations_followups f
    where f.user_id=$1 and f.helper_id=$2 order by f.created_at desc limit 1`,[userId,helperId]);
  return row?{jobId:row.job_id,sessionId:row.browser_session_id,deadline:new Date(row.deadline).toISOString(),serverNow:new Date(row.server_now).toISOString(),state:row.state,closeJobId:row.close_job_id}:null;
}
/** Job -> helper -> followup lock order matches terminal ingestion. */
export async function expireTaskFollowup(userId:string,helperId:string,jobId:string,deps:{query:SqlQuery;transaction:typeof withTransaction;endSession:(input:{userId:string;helperId:string;idempotencyKey:string;forceClose:boolean})=>Promise<{status:string;closeJobId:string|null}>}={query:queryRows,transaction:withTransaction,endSession:async input=>(await import('./operations')).endOperatorSession(input)}) {
  const ready=await deps.transaction(async sql=>{
    const [job]=await sql<any>('select * from jobs where id=$1 and user_id=$2 and helper_id=$3 for no key update',[jobId,userId,helperId]);
    const [helper]=await sql<any>('select id,active_job_id,(remote_lease_until>now()) as manual from helpers where id=$1 and user_id=$2 and revoked_at is null for update',[helperId,userId]);
    const [f]=await sql<any>('select *,deadline<=now() as due from operations_followups where job_id=$1 and user_id=$2 and helper_id=$3 for update',[jobId,userId,helperId]);
    if(!job||!helper||!f)return false;
    if(f.state==='closing')return false;
    if(f.state!=='waiting'||!f.due)return false;
    const [guard]=await sql<any>(`select
      exists(select 1 from browser_sessions where id=$3 and user_id=$1 and helper_id=$2 and closed_at is null) as same_session,
      exists(select 1 from jobs where user_id=$1 and helper_id=$2 and status in ('queued','dispatched','running') and capability_id<>'list-tabs') as active,
      exists(select 1 from operator_activity where user_id=$1 and helper_id=$2 and (paused_at is not null or last_activity_at>(select created_at from operations_followups where job_id=$4))) as touched,
      exists(select 1 from operations_drafts where user_id=$1 and helper_id=$2 and workflow_until>now()) as preparing,
      exists(select 1 from jobs where user_id=$1 and helper_id=$2 and created_at>(select created_at from jobs where id=$4) and capability_id in ('quiz-learn','quick-scrape','scorm-complete','cert-batch','class-batch','container-batch','slickquiz-solve')) as newer`,[userId,helperId,f.browser_session_id,jobId]);
    if(!completedCourseTask(job)||helper.active_job_id===jobId||helper.manual||!guard?.same_session||guard.active||guard.touched||guard.preparing||guard.newer){
      await sql("update operations_followups set state='cancelled',updated_at=now() where job_id=$1",[jobId]);return false;
    }
    await sql("update operations_followups set state='closing',updated_at=now() where job_id=$1",[jobId]);return true;
  });
  if(!ready)return {status:'kept-open'};
  try{
    const result=await deps.endSession({userId,helperId,idempotencyKey:`after-task:${jobId}`,forceClose:false});
    await deps.query("update operations_followups set close_job_id=$2,state=$4,updated_at=now() where job_id=$1 and user_id=$3 and state='closing'",[jobId,result.closeJobId,userId,result.status==='ended'?'closed':result.status==='close_failed'?'failed':'closing']);
    return result;
  }catch(error){await deps.query("update operations_followups set state='failed',updated_at=now() where job_id=$1 and user_id=$2",[jobId,userId]);throw error;}
}
