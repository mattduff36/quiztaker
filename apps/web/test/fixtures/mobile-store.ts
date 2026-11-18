import type {SqlQuery} from '../../src/lib/db';
/** Offline transaction fixture. No driver, credentials or network database is used. */
export class MobileStore {
  readonly userId='fixture-account';
  readonly helperId='11111111-1111-4111-8111-111111111111';
  sessionId='22222222-2222-4222-8222-222222222222';
  remote=new Map<string,Record<string,unknown>>();
  draft:Record<string,unknown>|null=null;
  requests=new Map<string,Record<string,unknown>>();
  helper:{remote_session_id:string|null;remote_lease_until:string|null}={remote_session_id:null,remote_lease_until:null};
  active=false;
  paused=false;
  pauses=0;
  now=()=>Date.now();
  private tail:Promise<unknown>=Promise.resolve();
  transaction=async<T>(run:(query:SqlQuery)=>Promise<T>):Promise<T>=>{
    const result=this.tail.then(()=>run(this.query));this.tail=result.catch(()=>{});return result;
  };
  pause=async(userId:string,helperId:string)=>{
    if(userId!==this.userId||helperId!==this.helperId)throw new Error('Helper not found');
    this.pauses++;this.paused=true;return {paused:true,lastActivityAt:'',expiresAt:'',serverNow:''};
  };
  query:SqlQuery=async<T>(text:string,values:unknown[]=[])=>{
    const q=text.replace(/\s+/g,' ').trim();
    const v=values;
    const own=v[0]===this.helperId&&v[1]===this.userId;
    let result:unknown[]=[];
    const live=()=>Boolean(this.helper.remote_lease_until&&Date.parse(this.helper.remote_lease_until)>this.now());
    if(q.startsWith('select remote_session_id'))result=own?[{...this.helper}]:[];
    else if(q.startsWith('select (remote_lease_until'))result=own?[{manual:live()}]:[];
    else if(q.startsWith('select id from browser_sessions'))result=own?[{id:this.sessionId}]:[];
    else if(q.startsWith('delete from remote_sessions')&&q.includes('expires_at')){for(const [id,row] of this.remote)if(row.helper_id===v[0]&&row.user_id===v[1]&&Date.parse(String(row.expires_at))<=this.now())this.remote.delete(id);}
    else if(q.startsWith('delete from remote_sessions')&&q.includes('client_id')){for(const [id,row] of this.remote)if(row.helper_id===v[0]&&row.user_id===v[1]&&row.client_id===v[2])this.remote.delete(id);}
    else if(q.startsWith('delete from remote_sessions')){const row=this.remote.get(String(v[0]));if(row?.user_id===v[1])this.remote.delete(String(v[0]));}
    else if(q.startsWith('select count(*) from remote_sessions'))result=[{count:String([...this.remote.values()].filter(row=>row.helper_id===v[0]&&row.user_id===v[1]).length)}];
    else if(q.startsWith('insert into remote_sessions')){
      if(this.remote.has(String(v[0])))throw new Error('Duplicate session');
      this.remote.set(String(v[0]),{id:v[0],user_id:v[1],helper_id:v[2],client_id:v[3],viewer_key:v[4],helper_key:null,
        expires_at:new Date(this.now()+15000).toISOString(),ready:false,frame:null,frame_seq:0,command:null,command_seq:0,acknowledged_seq:0,status:'Connecting to helper'});
    }else if(q.startsWith('select id from remote_sessions')||q.startsWith('select * from remote_sessions where id=')){
      const row=this.remote.get(String(v[0]));
      if(row&&row.user_id===v[1]&&row.helper_id===v[2]&&row.client_id===v[3]&&(!q.includes('expires_at>')||Date.parse(String(row.expires_at))>this.now()))result=[structuredClone(row)];
    }else if(q.startsWith('select * from remote_sessions'))result=[...this.remote.values()].filter(row=>row.helper_id===v[0]&&row.user_id===v[1]).map(row=>structuredClone(row));
    else if(q.startsWith('update remote_sessions set frame=null')||q.startsWith('update remote_sessions set command=null')&&q.includes('expiresAt')){
      const field=q.includes('set frame=')?'frame':'command';
      for(const row of this.remote.values())if(row.helper_id===v[0]&&row.user_id===v[1]&&row[field]&&Number((row[field] as {expiresAt:number}).expiresAt)<=this.now())row[field]=null;
    }else if(q.startsWith('update remote_sessions')){
      const row=this.remote.get(String(v[0]));
      if(row&&row.user_id===v[1]){
        if(q.includes('helper_key=$3')){
          row.helper_key=v[2];if(v[3])row.frame=JSON.parse(String(v[3]));
          if(v[4]!==null)row.frame_seq=v[4];if(v[5]!==null)row.acknowledged_seq=v[5];row.status=v[6];
        }else if(q.includes('command=$3')){row.command=JSON.parse(String(v[2]));row.command_seq=v[3];}
        else if(q.includes('ready=false,command=null')){row.ready=false;row.command=null;}
        else if(q.includes('ready=false,status=')){row.ready=false;row.status='Stopping automation before manual control';}
        else if(q.includes('ready=$3'))row.ready=v[2];
        else if(q.includes('set command=null'))row.command=null;
        else if(q.includes('expires_at='))row.expires_at=new Date(this.now()+15000).toISOString();
        else throw new Error(`Unhandled fixture update: ${q}`);
      }
    }else if(q.startsWith('update helpers')){
      if(own){
        if(q.startsWith('update helpers set remote_session_id=$3')){this.helper.remote_session_id=String(v[2]);this.helper.remote_lease_until=new Date(this.now()+Number(v[3])).toISOString();}
        else if(q.includes('remote_session_id=null')){if(this.helper.remote_session_id===v[2])this.helper.remote_session_id=null;}
        else if(q.includes('remote_lease_until=null'))this.helper.remote_lease_until=null;
        else if(q.includes('remote_lease_until=now()'))this.helper.remote_lease_until=new Date(this.now()+Number(v[2])).toISOString();
        else throw new Error(`Unhandled fixture helper update: ${q}`);
      }
    }else if(q.startsWith('select id from jobs'))result=own&&this.active?[{id:'active-job'}]:[];
    else if(q.startsWith('insert into operations_drafts')){if(!this.draft)this.draft={helper_id:v[0],user_id:v[1],session_id:v[2],revision:1,client_id:null,draft:{},workflow_id:null,workflow_client_id:null,workflow_until:null};}
    else if(q.startsWith('select * from operations_drafts'))result=own&&this.draft?[structuredClone(this.draft)]:[];
    else if(q.startsWith('select workflow_id'))result=own&&this.draft?.workflow_until&&Date.parse(String(this.draft.workflow_until))>this.now()?[structuredClone(this.draft)]:[];
    else if(q.startsWith('update operations_drafts')){
      if(own&&this.draft){
        const row=this.draft;row.revision=Number(row.revision)+1;
        if(q.includes('session_id=$3')){row.session_id=v[2];row.draft={};row.workflow_id=null;row.workflow_client_id=null;row.workflow_until=null;}
        else if(q.includes('set draft=')){row.draft={...row.draft as object,...JSON.parse(String(v[2]))};row.client_id=v[3];}
        else if(q.includes('workflow_id=$3')){row.workflow_id=v[2];row.workflow_client_id=v[3];row.workflow_until=new Date(this.now()+30000).toISOString();}
        else if(q.includes('workflow_id=null')){row.workflow_id=null;row.workflow_client_id=null;row.workflow_until=null;}
        else throw new Error(`Unhandled draft update: ${q}`);
        result=[structuredClone(row)];
      }
    }else if(q.startsWith('select pg_advisory_xact_lock')){}
    else if(q.startsWith('select request_hash')){const row=this.requests.get(String(v[2]));result=own&&row?[row]:[];}
    else if(q.startsWith('insert into operations_requests'))this.requests.set(String(v[2]),{request_hash:v[3],response:JSON.parse(String(v[4])),status:v[5]});
    else if(q.startsWith('update operations_requests')){const row=this.requests.get(String(v[2]));if(own&&row){row.response=JSON.parse(String(v[3]));row.status=v[4];}}
    else if(q.startsWith('delete from operations_requests')){}
    else throw new Error(`Unhandled offline SQL: ${q}`);
    return result as T[];
  };
}
