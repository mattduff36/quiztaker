'use client';
import {useEffect,useRef,useState} from 'react';
import {TASK_FOLLOWUP_MS,type TaskFollowup} from '@/lib/task-followup-policy';
import {readJsonResponse} from '@/lib/operations-readiness';

/** The server owns the deadline; either device can cancel, and only a visible
 * client may request expiry. A suspended/offline page never closes on its own. */
export function TaskFollowupBar({helperId,value,paused,onClosing}:{helperId:string;value:TaskFollowup|null;paused:boolean;onClosing:(jobId:string)=>void}) {
  const [remaining,setRemaining]=useState(TASK_FOLLOWUP_MS),[cancelled,setCancelled]=useState<string|null>(null),[error,setError]=useState('');
  const cancelledIds=useRef(new Set<string>()),expiring=useRef(new Set<string>()),handled=useRef(new Set<string>());
  useEffect(()=>{
    if(!value||value.state!=='waiting')return;
    const jobId=value.jobId,key=`vitriol-followup-cancel:${helperId}`;
    setError('');
    try{if(sessionStorage.getItem(key)===jobId){cancelledIds.current.add(jobId);setCancelled(jobId);}}catch{/* Private browser storage may be unavailable. */}
    const deadline=Date.now()+Math.max(0,Date.parse(value.deadline)-Date.parse(value.serverNow));
    let alive=true,retry:ReturnType<typeof setTimeout>|undefined;
    const send=async(action:'cancel'|'expire')=>{
      const response=await fetch('/api/operations/followup',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(12_000),body:JSON.stringify({helperId,jobId,action})});
      return readJsonResponse<{closeJobId?:string|null}>(response,'Could not update the follow-up period. The browser will stay open on this device.');
    };
    const persistCancel=()=>{void send('cancel').catch(()=>{if(alive)retry=setTimeout(persistCancel,1500);});};
    const cancel=()=>{if(cancelledIds.current.has(jobId))return;cancelledIds.current.add(jobId);try{sessionStorage.setItem(key,jobId);}catch{}setCancelled(jobId);persistCancel();};
    const input=(event:Event)=>{if(event.isTrusted)cancel();};
    const events=['pointerdown','click','keydown','input','wheel','touchstart','scroll'];
    events.forEach(name=>window.addEventListener(name,input,{passive:true,capture:true}));
    if(paused)cancel();
    if(cancelledIds.current.has(jobId))persistCancel();
    const tick=()=>{
      const left=Math.max(0,deadline-Date.now());setRemaining(left);
      if(left||paused||document.visibilityState!=='visible'||cancelledIds.current.has(jobId)||expiring.current.has(jobId))return;
      expiring.current.add(jobId);
      void send('expire').then(result=>{if(result.closeJobId)onClosing(result.closeJobId);}).catch(cause=>{if(alive)setError(cause instanceof Error?cause.message:'Could not close the browser.');});
    };
    tick();const timer=setInterval(tick,200);
    return()=>{alive=false;clearInterval(timer);clearTimeout(retry);events.forEach(name=>window.removeEventListener(name,input,true));};
  },[helperId,value?.jobId,value?.state,value?.deadline,paused]);
  useEffect(()=>{if(value?.state==='closing'&&value.closeJobId&&!handled.current.has(value.closeJobId)){handled.current.add(value.closeJobId);onClosing(value.closeJobId);}},[value?.state,value?.closeJobId,onClosing]);
  if(!value||paused||cancelled===value.jobId||!['waiting','closing','failed'].includes(value.state))return null;
  if(error||value.state==='failed')return <p role="alert" className="text-sm text-amber-950">{error||'Automatic browser close was not confirmed. Check the browser before trying End browser session.'}</p>;
  return <section data-testid="task-followup" className="w-full overflow-hidden rounded-md border border-cyan-300 bg-cyan-50 text-cyan-950">
    <p role="status" className="px-4 py-3 text-sm">{value.state==='closing'?'Task complete. Ending the browser session…':`Finished. The task will complete and the browser session will end in ${Math.max(0,Math.ceil(remaining/1000))} seconds. Click, scroll or type anywhere to keep it open.`}</p>
    <div role="progressbar" aria-label="Time before browser session ends" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100*(1-remaining/TASK_FOLLOWUP_MS))} className="h-2 w-full bg-cyan-100"><div className="h-full bg-cyan-700 motion-safe:transition-[width] motion-safe:duration-200" style={{width:`${100*(1-remaining/TASK_FOLLOWUP_MS)}%`}}/></div>
  </section>;
}
