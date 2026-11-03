'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { OPERATOR_IDLE_MS, OPERATOR_WARNING_MS } from '@/lib/operations-policy';
import { readJsonResponse } from '@/lib/operations-readiness';
import type { OperatorActivity } from '@/lib/operator-activity';

export function useOperatorActivity(helperId: string) {
  const [ready,setReady] = useState(false), [paused,setPaused] = useState(false);
  const [remaining,setRemaining] = useState(OPERATOR_IDLE_MS), [error,setError] = useState('');
  const deadline = useRef(Date.now()+OPERATOR_IDLE_MS), isPaused = useRef(false), serverVersion = useRef(0);
  const sync = useCallback((value?: OperatorActivity | null) => {
    if (!value || Date.parse(value.serverNow)<serverVersion.current) return;
    serverVersion.current=Date.parse(value.serverNow);
    const left=Math.max(0,Date.parse(value.expiresAt)-Date.parse(value.serverNow));
    deadline.current=Date.now()+left; isPaused.current=value.paused;
    setPaused(value.paused); setRemaining(left); setReady(true);
  },[]);
  const send = useCallback(async(action:'check'|'activity'|'resume'|'pause') => {
    try {
      const response=await fetch('/api/operations/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({helperId,action}),signal:AbortSignal.timeout(15_000)});
      const value=await readJsonResponse<OperatorActivity>(response,'Could not update session protection.');
      sync(value); setError(''); return value;
    } catch (cause) {setError(cause instanceof Error?cause.message:'Could not update session protection.');return null;}
  },[helperId,sync]);
  const pause = useCallback(async()=>{isPaused.current=true;setPaused(true);await send('pause');},[send]);
  const expire = useCallback(async()=>{isPaused.current=true;setPaused(true);await send('check');},[send]);
  const resume = useCallback(async()=>{await send('resume');},[send]);
  useEffect(()=>{
    void send('check');
    let lastPost=0, lastInput=0, trailing:ReturnType<typeof setTimeout>|undefined;
    const activity=(event:Event)=>{
      if (!event.isTrusted || isPaused.current) return;
      if (Date.now()>=deadline.current) {void expire();return;}
      lastInput=Date.now();
      deadline.current=Date.now()+OPERATOR_IDLE_MS;
      setRemaining(OPERATOR_IDLE_MS);
      if (Date.now()-lastPost>=10_000) {lastPost=Date.now();void send('activity');}
      else if (!trailing) trailing=setTimeout(()=>{trailing=undefined;if(!isPaused.current&&Date.now()-lastInput<15_000){lastPost=Date.now();void send('activity');}},10_000-(Date.now()-lastPost));
    };
    const events=['pointerdown','keydown','input','change','wheel','touchstart'];
    events.forEach(name=>window.addEventListener(name,activity,{passive:true}));
    const timer=setInterval(()=>{
      if(isPaused.current)return;
      const left=Math.max(0,deadline.current-Date.now());
      if(left<=OPERATOR_WARNING_MS)setRemaining(left);
      if(left===0)void expire();
    },1000);
    return()=>{clearInterval(timer);clearTimeout(trailing);events.forEach(name=>window.removeEventListener(name,activity));};
  },[send,expire]);
  return {ready,paused,remainingMs:remaining,warning:!paused&&remaining<=OPERATOR_WARNING_MS,error,sync,pause,resume};
}
