'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { EMPTY_SHARED,SharedDraftReplica,type OperationsDraft,type SharedSnapshot } from '@/lib/operations-shared';
import { readJsonResponse } from '@/lib/operations-readiness';
export function useSharedOperations(helperId:string) {
  const replica=useRef(new SharedDraftReplica());
  const [clientId]=useState(()=>crypto.randomUUID());
  const [clock,setClock]=useState(0);
  const workflow=useRef<string|null>(null);
  const [snapshot,setSnapshot]=useState(EMPTY_SHARED);
  const [draft,setDraft]=useState<Partial<OperationsDraft>>({});
  const [error,setError]=useState('');
  const inFlight=useRef(false);
  const alive=useRef(true);
  const editedAt=useRef(0);
  const send=useCallback(async(action:string,extra:Record<string,unknown>={})=>{
    const response=await fetch('/api/operations/shared',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
      signal:AbortSignal.timeout(10_000),body:JSON.stringify({helperId,clientId,action,...extra})});
    return readJsonResponse<SharedSnapshot & {conflict?:boolean}>(response,'Shared task unavailable. Your pending edits are kept.');
  },[helperId,clientId]);
  const sync=useCallback(async()=>{
    if(inFlight.current||document.visibilityState==='hidden')return;
    inFlight.current=true;
    const request=replica.current.request();
    const editing=Object.keys(request.patch).length>0&&Date.now()-editedAt.current>=300;
    try{
      const value=await send(editing?'edit':'read',editing?{revision:request.revision,patch:request.patch}:{});
      if(!alive.current)return;
      replica.current.receive(value,editing&&!value.conflict?request:undefined);
      setSnapshot(replica.current.snapshot);setDraft(replica.current.draft);setClock(Date.now());setError('');
    }catch(error){if(alive.current)setError(error instanceof Error?error.message:'Shared task disconnected. Pending edits are kept.');}
    finally{inFlight.current=false;}
  },[send]);
  useEffect(()=>{
    alive.current=true;void sync();
    const timer=setInterval(()=>void sync(),700);
    const visible=()=>{if(document.visibilityState==='visible')void sync();};
    document.addEventListener('visibilitychange',visible);
    return()=>{alive.current=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[sync]);
  const edit=useCallback((patch:Partial<OperationsDraft>)=>{
    editedAt.current=Date.now();replica.current.edit(patch);setDraft(replica.current.draft);
  },[]);
  const clearGuidance=useCallback(async(text:string,sessionId:string)=>{
    if(replica.current.snapshot.sessionId!==sessionId)throw new Error('The browser session changed. The new guidance draft was kept.');
    replica.current.forgetGuidance(text);
    const value=await send('clear-guidance',{text,sessionId});
    replica.current.receive(value);
    if(alive.current){setSnapshot(replica.current.snapshot);setDraft(replica.current.draft);}
  },[send]);
  const begin=useCallback(async()=>{
    // Persist this device's pending input before taking workflow ownership.
    for(let attempt=0;attempt<4;attempt++) {
      const request=replica.current.request();
      if(!Object.keys(request.patch).length)break;
      const value=await send('edit',{revision:request.revision,patch:request.patch});
      replica.current.receive(value,value.conflict?undefined:request);
    }
    if(Object.keys(replica.current.pending).length)throw new Error('The shared draft is changing. Wait for sync before starting.');
    const id=crypto.randomUUID();
    const value=await send('begin',{workflowId:id});
    workflow.current=id;replica.current.receive(value);setSnapshot(value);return id;
  },[send]);
  const end=useCallback(async()=>{
    const id=workflow.current;workflow.current=null;
    if(!id)return;
    try{const value=await send('end',{workflowId:id});replica.current.receive(value);if(alive.current)setSnapshot(value);}
    catch{if(alive.current)setError('Task control release was not confirmed; it expires within 30 seconds.');}
  },[send]);
  useEffect(()=>{
    const timer=setInterval(()=>{
      if(!workflow.current)return;
      void send('renew',{workflowId:workflow.current}).catch(()=>{workflow.current=null;setError('Task control could not be renewed. This device will not queue further steps.');});
    },8000);
    return()=>clearInterval(timer);
  },[send]);
  return {draft,snapshot,error,edit,clearGuidance,begin,end,clientId:()=>clientId,workflowId:()=>workflow.current,
    otherWorkflow:Boolean(snapshot.workflowId&&snapshot.workflowClientId!==clientId&&snapshot.workflowUntil&&Date.parse(snapshot.workflowUntil)>clock),
    ready:snapshot.revision>0&&!error};
}
