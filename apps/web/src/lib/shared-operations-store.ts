import { z } from 'zod';
import { createHash } from 'node:crypto';
import { queryRows,withTransaction, type SqlQuery } from '@/lib/db';
import type { OperationsDraft, SharedSnapshot } from './operations-shared';
export const draftPatchSchema=z.object({
  taskResetId:z.string().uuid(),dismissedTaskId:z.string().uuid().nullable(),
  selectedTarget:z.string().max(200),selectedCdpTarget:z.string().max(200),objective:z.string().max(1000),objectiveEdited:z.boolean(),
  chosenIntent:z.enum(['read','quiz','read-and-assess']).nullable(),
  mode:z.enum(['independent','coordinate','quick']),answer:z.string().max(1400),guidance:z.string().max(2000),
  question:z.object({question:z.string().max(4000),options:z.array(z.string().max(1000)).max(30).optional(),
    next:z.string().max(2000).optional(),model:z.boolean().optional(),targetId:z.string().max(200).optional(),cdpTargetId:z.string().max(200).optional(),
    sessionId:z.string().max(200).optional(),url:z.string().max(10000).optional(),intent:z.enum(['read','quiz','read-and-assess','coordinate']).optional()}).strict().nullable(),
}).partial().strict();
type DraftRow={revision:number;session_id:string|null;client_id:string|null;draft:Partial<OperationsDraft>;workflow_id:string|null;workflow_client_id:string|null;workflow_until:string|null};
export async function sharedOperations(userId:string,input:{
  helperId:string;clientId:string;action:'read'|'edit'|'begin'|'renew'|'end'|'clear-guidance';
  revision?:number;patch?:Partial<OperationsDraft>;workflowId?:string;text?:string;sessionId?:string;
},deps={transaction:withTransaction}):Promise<SharedSnapshot & {conflict?:boolean}> {
  return deps.transaction(async sql=>{
    const [helper]=await sql<{manual:boolean}>('select (remote_lease_until>now()) as manual from helpers where id=$1 and user_id=$2 and revoked_at is null for update',[input.helperId,userId]);
    if(!helper)throw new Error('Helper not found');
    const [session]=await sql<{id:string}>('select id from browser_sessions where helper_id=$1 and user_id=$2 and closed_at is null order by updated_at desc limit 1',[input.helperId,userId]);
    await sql(`insert into operations_drafts(helper_id,user_id,session_id) values($1,$2,$3) on conflict do nothing`,[input.helperId,userId,session?.id??null]);
    let [row]=await sql<DraftRow>('select * from operations_drafts where helper_id=$1 and user_id=$2 for update',[input.helperId,userId]);
    if(!row)throw new Error('Shared task unavailable');
    if(row.session_id!==(session?.id??null)) {
      [row]=await sql<DraftRow>(`update operations_drafts set session_id=$3,revision=revision+1,draft='{}'::jsonb,
        workflow_id=null,workflow_client_id=null,workflow_until=null where helper_id=$1 and user_id=$2 returning *`,[input.helperId,userId,session?.id??null]);
    }
    const live=Boolean(row!.workflow_until&&new Date(row!.workflow_until).getTime()>Date.now());
    let conflict=false;
    if(input.action==='clear-guidance') {
      if(typeof input.text!=='string'||input.text.length>2000)throw new Error('Invalid accepted guidance');
      if(input.sessionId!==row!.session_id)throw new Error('The browser session changed. The new guidance draft was kept.');
      const patch=row!.draft.guidance?.trim()===input.text?{guidance:''}:{};
      [row]=await sql<DraftRow>(`update operations_drafts set draft=draft||$3::jsonb,revision=revision+1,client_id=$4,updated_at=now()
        where helper_id=$1 and user_id=$2 returning *`,[input.helperId,userId,JSON.stringify(patch),input.clientId]);
    } else if(input.action==='edit') {
      conflict=input.revision!==Number(row!.revision);
      if(!conflict) [row]=await sql<DraftRow>(`update operations_drafts set draft=draft||$3::jsonb,revision=revision+1,client_id=$4,updated_at=now()
        where helper_id=$1 and user_id=$2 returning *`,[input.helperId,userId,JSON.stringify(input.patch??{}),input.clientId]);
    } else if(input.action==='begin'||input.action==='renew') {
      if(helper.manual)throw new Error('Release manual browser control before starting automation.');
      if(!input.workflowId)throw new Error('Task request identity required');
      if(live&&(row!.workflow_id!==input.workflowId||row!.workflow_client_id!==input.clientId))throw new Error('Another device is preparing this task. Follow its current run here.');
      if(input.action==='renew'&&(!live||row!.workflow_id!==input.workflowId))throw new Error('Task control expired. Inspect the page again.');
      [row]=await sql<DraftRow>(`update operations_drafts set workflow_id=$3,workflow_client_id=$4,workflow_until=now()+interval '30 seconds',revision=revision+1
        where helper_id=$1 and user_id=$2 returning *`,[input.helperId,userId,input.workflowId,input.clientId]);
    } else if(input.action==='end'&&row!.workflow_id===input.workflowId&&row!.workflow_client_id===input.clientId) {
      [row]=await sql<DraftRow>(`update operations_drafts set workflow_id=null,workflow_client_id=null,workflow_until=null,revision=revision+1
        where helper_id=$1 and user_id=$2 returning *`,[input.helperId,userId]);
    }
    return {revision:Number(row!.revision),sessionId:row!.session_id,clientId:row!.client_id,draft:row!.draft,
      workflowId:row!.workflow_id,workflowClientId:row!.workflow_client_id,workflowUntil:row!.workflow_until,manual:helper.manual===true,conflict};
  });
}
export async function assertSharedWorkflow(sql:SqlQuery,userId:string,helperId:string,clientId?:string,workflowId?:string) {
  const [owner]=await sql<{workflow_id:string;workflow_client_id:string}>(`select workflow_id,workflow_client_id from operations_drafts
    where helper_id=$1 and user_id=$2 and workflow_until>now()`,[helperId,userId]);
  if(owner&&(owner.workflow_id!==workflowId||owner.workflow_client_id!==clientId))throw new Error('Another device is preparing this task.');
  if(workflowId&&!owner)throw new Error('Task control expired. Inspect the page again.');
}
export type WorkflowOwner={clientId?:string;workflowId?:string};
export async function bindPlanWorkflow(userId:string,helperId:string,planId:string,owner:WorkflowOwner) {
  return withTransaction(async sql=>{
    const [helper]=await sql('select id from helpers where id=$1 and user_id=$2 and revoked_at is null for update',[helperId,userId]);
    if(!helper)throw new Error('Helper is unavailable');
    await assertSharedWorkflow(sql,userId,helperId,owner.clientId,owner.workflowId);
    if(Boolean(owner.clientId)!==Boolean(owner.workflowId))throw new Error('Task ownership is incomplete');
    const [plan]=await sql('update plans set operations_workflow_id=$4,operations_client_id=$5 where id=$1 and user_id=$2 and helper_id=$3 and consumed=false returning id',
      [planId,userId,helperId,owner.workflowId??null,owner.clientId??null]);
    if(!plan)throw new Error('Plan is no longer available');
  });
}
export async function assertPlanWorkflow(sql:SqlQuery,userId:string,helperId:string,planId:string,owner:WorkflowOwner={}) {
  const [plan]=await sql<{operations_workflow_id:string|null;operations_client_id:string|null}>(
    'select operations_workflow_id,operations_client_id from plans where id=$1 and user_id=$2 and helper_id=$3 for update',[planId,userId,helperId]);
  if(!plan)throw new Error('Plan not found');
  if((plan.operations_workflow_id||plan.operations_client_id)
    &&(plan.operations_workflow_id!==owner.workflowId||plan.operations_client_id!==owner.clientId))throw new Error('Task ownership changed. Inspect again on this device.');
  await assertSharedWorkflow(sql,userId,helperId,owner.clientId,owner.workflowId);
}
export async function idempotentOperation(userId:string,helperId:string,requestId:string,body:unknown,run:()=>Promise<Response>,deps={transaction:withTransaction,query:queryRows}):Promise<Response> {
  const hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const prior=await deps.transaction(async sql=>{
    await sql('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${userId}:${helperId}:${requestId}`]);
    const [prior]=await sql<{request_hash:string;response:unknown;status:number}>('select request_hash,response,status from operations_requests where helper_id=$1 and user_id=$2 and request_id=$3',[helperId,userId,requestId]);
    if(prior) {
      if(prior.request_hash!==hash)throw new Error('Request identity reused for a different action');
      return prior;
    }
    // Persist a fail-closed reservation BEFORE any plan/job side effect. A crash
    // leaves an explicit unknown outcome rather than running a second job.
    await sql(`insert into operations_requests(helper_id,user_id,request_id,request_hash,response,status) values($1,$2,$3,$4,$5::jsonb,$6)`,
      [helperId,userId,requestId,hash,JSON.stringify({error:'This request is still in progress or its response was lost. Inspect the current job before starting another.'}),409]);
    await sql('delete from operations_requests where helper_id=$1 and user_id=$2 and expires_at<now()',[helperId,userId]);
    return null;
  });
  if(prior)return Response.json(prior.response,{status:prior.status});
  const response=await run();
  const value=await response.clone().json();
  await deps.query('update operations_requests set response=$4::jsonb,status=$5 where helper_id=$1 and user_id=$2 and request_id=$3',
    [helperId,userId,requestId,JSON.stringify(value),response.status]);
  return response;
}
