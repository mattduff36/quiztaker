import { queryRows, withTransaction, type SqlQuery } from '@/lib/db';

/** Connection housekeeping is not the user's course task. */
export const MAINTENANCE_CAPABILITIES = ['list-tabs','cdp-check','fit-tab','start-browser','close-browser','open-url','cert-status','cert-dry-run','tab-inspect'];
export type TaskResolution = {result:'completed'|'failed'; reportedBy:'operator'; requestedAt:string; resolvedAt:string; note?:string};
type TaskRow = Record<string, unknown> & {id:string;user_id:string;helper_id:string;attempt_id:string;status:string;capability_id:string;outcome:Record<string,unknown>|null;input?:Record<string,unknown>;label?:string;browser_session_id?:string};
interface Deps { query:SqlQuery; transaction:<T>(fn:(query:SqlQuery)=>Promise<T>)=>Promise<T>; now:()=>Date }
const defaults:Deps={query:queryRows,transaction:withTransaction,now:()=>new Date()};

export function operatorResolution(outcome:unknown):TaskResolution|null {
  if(!outcome||typeof outcome!=='object')return null;
  const r=(outcome as Record<string,unknown>).operatorResolution as TaskResolution|undefined;
  return r?.reportedBy==='operator'&&(r.result==='completed'||r.result==='failed')?r:null;
}
export function taskStillStopping(job: {id:string;outcome?:unknown}, helper:{active_job_id?:unknown;last_seen_at?:unknown}|undefined, now=Date.now()):boolean {
  return Boolean(operatorResolution(job.outcome)&&helper?.active_job_id===job.id&&helper.last_seen_at&&now-new Date(String(helper.last_seen_at)).getTime()<120_000);
}
export async function readLatestTask(userId:string,helperId:string,query:SqlQuery=queryRows) {
  const [task]=await query<TaskRow>(`select jobs.id,jobs.status,jobs.capability_id,jobs.input,jobs.outcome,jobs.diagnosis,jobs.result,jobs.output_url,jobs.created_at,plans.label,
    coalesce((helpers.active_job_id=jobs.id and helpers.last_seen_at>now()-interval '120 seconds' and jobs.outcome->'operatorResolution'->>'reportedBy'='operator'),false) as stopping
    from jobs join plans on plans.id=jobs.plan_id join helpers on helpers.id=jobs.helper_id
    where jobs.user_id=$1 and jobs.helper_id=$2 and not(jobs.capability_id=any($3::text[]))
    order by jobs.created_at desc,jobs.id desc limit 1`,[userId,helperId,MAINTENANCE_CAPABILITIES]);
  return task??null;
}

/** An operator closes a task, never changes the LMS or fabricates verified learning. */
export async function finishOperatorTask(input:{userId:string;helperId:string;jobId:string;result:'completed'|'failed';note?:string},deps:Deps=defaults) {
  return deps.transaction(async sql=>{
    // Same order as terminal ingestion/recovery; no helper -> job lock inversion.
    const [job]=await sql<TaskRow>(`select jobs.*,plans.label,plans.browser_session_id
      from jobs join plans on plans.id=jobs.plan_id
      where jobs.id=$1 and jobs.user_id=$2 and jobs.helper_id=$3 for no key update of jobs`,[input.jobId,input.userId,input.helperId]);
    if(!job)throw new Error('Task not found');
    if(MAINTENANCE_CAPABILITIES.includes(job.capability_id))throw new Error('Choose a course task, not a connection check.');
    const [helper]=await sql<{active_job_id:string|null;last_seen_at:string|null}>(`select active_job_id,last_seen_at from helpers where id=$1 and user_id=$2 and revoked_at is null for no key update`,[input.helperId,input.userId]);
    if(!helper)throw new Error('Helper not found');
    const [latest]=await sql<{id:string}>(`select id from jobs where user_id=$1 and helper_id=$2 and not(capability_id=any($3::text[])) order by created_at desc,id desc limit 1`,[input.userId,input.helperId,MAINTENANCE_CAPABILITIES]);
    if(latest?.id!==job.id)throw new Error('The current task changed. Refresh before marking its result.');
    const previous=operatorResolution(job.outcome);
    if(previous)return {ok:true,status:taskStillStopping(job,helper,deps.now().getTime())?'stopping':previous.result,jobId:job.id};
    const at=deps.now().toISOString();
    const resolution:TaskResolution={result:input.result,reportedBy:'operator',requestedAt:at,resolvedAt:at,...(input.note?.trim()?{note:input.note.trim().slice(0,1000)}:{})};
    const outcome={outcome:input.result==='completed'?'success':'failure',verified:false,status:`operator-${input.result}`,operatorResolution:resolution,...(job.outcome?{automaticOutcome:job.outcome}:{})};
    const detail=`Marked ${input.result==='completed'?'complete':'failed'} by the operator. This records the task outcome; it does not verify or change the course result.`;
    await sql(`update jobs set status=$4,cancel_requested=true,outcome=$5::jsonb,diagnosis=null,finished_at=$6 where id=$1 and user_id=$2 and helper_id=$3`,[job.id,input.userId,input.helperId,input.result,JSON.stringify(outcome),at]);
    // Keep the helper's live ownership until its next idle heartbeat. New course jobs
    // cannot start while it is still stopping the old process; offline closure works.
    await sql(`insert into attempt_events(user_id,attempt_id,event,data,occurred_at) values($1,$2,'operator-task-finished',$3::jsonb,$4)`,[input.userId,job.attempt_id,JSON.stringify({jobId:job.id,...outcome}),at]);
    await sql(`insert into history_events(user_id,helper_id,source_id,kind,title,result,detail,occurred_at,payload)
      values($1,$2,$3,'automation',$4,$5,$6,$7,$8::jsonb)
      on conflict(user_id,helper_id,source_id) do update set result=excluded.result,detail=excluded.detail,payload=excluded.payload,occurred_at=excluded.occurred_at`,[input.userId,input.helperId,`job:${job.id}`,job.label||job.capability_id,outcome.status,detail,at,JSON.stringify({jobId:job.id,outcome})]);
    // Preserve all facts/history, but append a real terminal turn so an earlier
    // ask-user entry cannot masquerade as the current unresolved question.
    const conversationId=job.input?.conversationId;
    if(typeof conversationId==='string'&&job.browser_session_id) {
      const turn=JSON.stringify([{role:'assistant',text:JSON.stringify({taskFinished:input.result,reportedBy:'operator'}),at}]);
      await sql(`update learner_sessions set history=(select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) from jsonb_array_elements(history||$5::jsonb) with ordinality e(value,ord) where ord>greatest(jsonb_array_length(history)+1-40,0)),updated_at=now()
        where id=$1 and user_id=$2 and helper_id=$3 and browser_session_id=$4`,[conversationId,input.userId,input.helperId,job.browser_session_id,turn]);
    }
    return {ok:true,status:taskStillStopping({...job,outcome},helper,deps.now().getTime())?'stopping':input.result,jobId:job.id};
  });
}
