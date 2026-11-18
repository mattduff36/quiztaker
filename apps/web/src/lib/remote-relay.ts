import { REMOTE_LEASE_MS, validRemotePublicKey, validSealedRemote, type SealedRemote } from '@quiztaker/core/remote';
import { queryRows, withTransaction, type SqlQuery } from '@/lib/db';
import { operatorActivity } from '@/lib/operator-activity';
const relayDatabase={transaction:withTransaction,pause:(userId:string,helperId:string)=>operatorActivity(userId,helperId,'pause')};

export interface RemoteRow {
  id: string; helper_id: string; client_id: string; viewer_key: string; helper_key: string | null;
  ready: boolean; frame: SealedRemote | null; frame_seq: number; command: (SealedRemote & {viewOnly?:boolean}) | null;
  command_seq: number; acknowledged_seq: number; status: string; expires_at: string;
}
async function ownHelper(sql: SqlQuery, userId: string, helperId: string) {
  const [helper] = await sql<{ remote_session_id: string | null; remote_lease_until: string | null }>(
    'select remote_session_id,remote_lease_until from helpers where id=$1 and user_id=$2 and revoked_at is null for update', [helperId,userId]);
  if (!helper) throw new Error('Helper not found');
  return helper;
}
async function prune(sql: SqlQuery, helperId: string, userId: string) {
  await sql('delete from remote_sessions where helper_id=$1 and user_id=$2 and expires_at<=now()', [helperId,userId]);
  await sql(`update remote_sessions set frame=null where helper_id=$1 and user_id=$2 and (frame->>'expiresAt')::bigint <= extract(epoch from clock_timestamp())*1000`, [helperId,userId]);
  await sql(`update remote_sessions set command=null where helper_id=$1 and user_id=$2 and (command->>'expiresAt')::bigint <= extract(epoch from clock_timestamp())*1000`, [helperId,userId]);
}
export async function remoteViewer(userId: string, input: {
  helperId: string; clientId: string; sessionId: string; action: 'open'|'poll'|'close'|'control'|'release'|'input'|'view-tab';
  publicKey?: string; command?: SealedRemote;
},deps=relayDatabase) {
  // Use the ordinary cancellation path before reserving control. Never call it while holding helpers.
  if (input.action === 'control') {
    await deps.transaction(async sql=>{
      await ownHelper(sql,userId,input.helperId);
      const [owned]=await sql('select id from remote_sessions where id=$1 and user_id=$2 and helper_id=$3 and client_id=$4 and expires_at>now()',
        [input.sessionId,userId,input.helperId,input.clientId]);
      if(!owned)throw new Error('Browser viewer expired. Reconnect.');
    });
    await deps.pause(userId,input.helperId);
  }
  return deps.transaction(async sql => {
    const helper = await ownHelper(sql,userId,input.helperId);
    await prune(sql,input.helperId,userId);
    if (input.action === 'open') {
      if (!validRemotePublicKey(input.publicKey)) throw new Error('Invalid viewer key');
      const [{count}] = await sql<{count:string}>('select count(*) from remote_sessions where helper_id=$1 and user_id=$2',[input.helperId,userId]);
      if (Number(count)>=4) throw new Error('Too many browser viewers. Close another viewer first.');
      // Reopening is explicit: a lost endpoint key never reuses a previous crypto session.
      await sql('delete from remote_sessions where helper_id=$1 and user_id=$2 and client_id=$3',[input.helperId,userId,input.clientId]);
      await sql(`insert into remote_sessions(id,user_id,helper_id,client_id,viewer_key,expires_at)
        values($1,$2,$3,$4,$5,now()+interval '15 seconds')`,[input.sessionId,userId,input.helperId,input.clientId,input.publicKey]);
    }
    const [session] = await sql<RemoteRow>('select * from remote_sessions where id=$1 and user_id=$2 and helper_id=$3 and client_id=$4 for update',
      [input.sessionId,userId,input.helperId,input.clientId]);
    if (!session && input.action==='close') return {closed:true,manual:false};
    if (!session) throw new Error('Browser viewer expired. Reconnect.');
    const leaseLive = Boolean(helper.remote_lease_until && new Date(helper.remote_lease_until).getTime()>Date.now());
    const mine = helper.remote_session_id === session.id && leaseLive;
    if (input.action === 'close' || input.action === 'release') {
      // Keep the admission barrier until the helper acknowledges it is idle (or
      // the bounded lease expires); release cannot race an in-flight input.
      await sql(`update helpers set remote_session_id=null where id=$1 and user_id=$2 and remote_session_id=$3`,[input.helperId,userId,session.id]);
      await sql('update remote_sessions set ready=false,command=null where id=$1 and user_id=$2',[session.id,userId]);
      if(input.action==='close') await sql('delete from remote_sessions where id=$1 and user_id=$2',[session.id,userId]);
      return {closed:input.action==='close',manual:false,controlBlocked:leaseLive};
    }
    if (input.action === 'control') {
      if (leaseLive && !mine) throw new Error('Another device has manual control.');
      await sql(`update helpers set remote_session_id=$3,remote_lease_until=now()+($4::int*interval '1 millisecond') where id=$1 and user_id=$2`,
        [input.helperId,userId,session.id,REMOTE_LEASE_MS]);
      await sql(`update remote_sessions set ready=false,status='Stopping automation before manual control' where id=$1 and user_id=$2`,[session.id,userId]);
      session.ready=false;
    } else if (mine) {
      await sql(`update helpers set remote_lease_until=now()+($3::int*interval '1 millisecond') where id=$1 and user_id=$2`,[input.helperId,userId,REMOTE_LEASE_MS]);
    }
    await sql(`update remote_sessions set expires_at=now()+interval '15 seconds' where id=$1 and user_id=$2`,[session.id,userId]);
    if(input.action==='input'||input.action==='view-tab') {
      if(input.action==='input'&&(!mine || !session.ready)) throw new Error('Manual control is not ready.');
      if(!validSealedRemote(input.command,Date.now(),8_000) || input.command.ciphertext.length>40_000) throw new Error('Invalid or expired input');
      if(input.command.seq<=Number(session.command_seq)) {
        if(input.command.seq===Number(session.command_seq)) return {accepted:true,duplicate:true};
        throw new Error('Input sequence replayed');
      }
      if(session.command) throw new Error('Waiting for the previous input. Refresh the browser image.');
      await sql(`update remote_sessions set command=$3::jsonb,command_seq=$4 where id=$1 and user_id=$2`,
        [session.id,userId,JSON.stringify({...input.command,...(input.action==='view-tab'?{viewOnly:true}:{})}),input.command.seq]);
      return {accepted:true};
    }
    return {sessionId:session.id,helperKey:session.helper_key,frame:session.frame,acknowledgedSeq:Number(session.acknowledged_seq),
      manual:mine && session.ready, reserved:mine || input.action==='control',controlBlocked:leaseLive&&!mine,status:session.status};
  });
}
export async function remoteHelper(userId:string,helperId:string,input:{
  idle:boolean; updates:Array<{sessionId:string;publicKey:string;frame?:SealedRemote;ack?:number;status?:string}>;
},deps=relayDatabase) {
  return deps.transaction(async sql=>{
    const helper=await ownHelper(sql,userId,helperId);
    await prune(sql,helperId,userId);
    const sessions=await sql<RemoteRow>('select * from remote_sessions where helper_id=$1 and user_id=$2 order by id for update',[helperId,userId]);
    const leaseLive=Boolean(helper.remote_lease_until && new Date(helper.remote_lease_until).getTime()>Date.now());
    const [active]=await sql(`select id from jobs where helper_id=$1 and user_id=$2 and status in ('dispatched','running') limit 1`,[helperId,userId]);
    const idle=input.idle && !active;
    if(leaseLive && !helper.remote_session_id && idle) {
      await sql('update helpers set remote_lease_until=null where id=$1 and user_id=$2',[helperId,userId]);
    }
    for(const update of input.updates) {
      const session=sessions.find(s=>s.id===update.sessionId);
      if(!session) continue;
      if(!validRemotePublicKey(update.publicKey)) throw new Error('Invalid helper key');
      if(session.helper_key && session.helper_key!==update.publicKey) throw new Error('Endpoint key changed. Reconnect the viewer.');
      const frame=update.frame;
      if(frame && (!validSealedRemote(frame) || frame.seq<=Number(session.frame_seq))) throw new Error('Invalid frame sequence');
      if(update.ack!==undefined && (!Number.isSafeInteger(update.ack)||update.ack<Number(session.acknowledged_seq)||update.ack>Number(session.command_seq))) throw new Error('Invalid input acknowledgement');
      await sql(`update remote_sessions set helper_key=$3,frame=coalesce($4::jsonb,frame),
        frame_seq=coalesce($5,frame_seq),acknowledged_seq=coalesce($6,acknowledged_seq),status=$7 where id=$1 and user_id=$2`,
        [session.id,userId,update.publicKey,frame?JSON.stringify(frame):null,frame?.seq??null,update.ack??null,update.status||'Connected']);
    }
    const result=[];
    for(const session of sessions) {
      const reserved=leaseLive && helper.remote_session_id===session.id;
      const ready=reserved && idle;
      await sql('update remote_sessions set ready=$3 where id=$1 and user_id=$2',[session.id,userId,ready]);
      // Consume before delivery: a lost response may lose an input but can never replay it.
      const command=ready||session.command?.viewOnly===true?session.command:null;
      if(command) await sql('update remote_sessions set command=null where id=$1 and user_id=$2',[session.id,userId]);
      result.push({sessionId:session.id,clientId:session.client_id,viewerKey:session.viewer_key,reserved,manual:ready,command,
        leaseUntil:reserved?new Date(helper.remote_lease_until!).getTime():0});
    }
    return {sessions:result,manualReserved:leaseLive,leaseUntil:leaseLive?new Date(helper.remote_lease_until!).getTime():0};
  });
}
export async function remoteControlStatus(userId:string,helperId:string) {
  const [row]=await queryRows<{manual:boolean}>(`select (remote_lease_until>now()) as manual from helpers where id=$1 and user_id=$2 and revoked_at is null`,[helperId,userId]);
  return row?.manual===true;
}
