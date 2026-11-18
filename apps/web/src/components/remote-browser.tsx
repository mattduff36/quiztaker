'use client';
import { useEffect,useEffectEvent,useRef,useState } from 'react';
import { RefreshCw,Hand,Eye,ArrowDown,ArrowUp,ArrowLeft,ArrowRight,Send,Minimize2,Maximize2,X } from 'lucide-react';
import { createRemoteKeys,deriveRemoteKey,openRemote,sealRemote,REMOTE_KEYS,type RemoteAction,type RemoteContext,type RemoteFrame,type SealedRemote } from '@quiztaker/core/remote';
import { readJsonResponse } from '@/lib/operations-readiness';
import { BrowserPictureInPicture } from './browser-picture-in-picture';
type Relay={helperKey?:string|null;frame?:SealedRemote|null;manual?:boolean;reserved?:boolean;controlBlocked?:boolean;status?:string;acknowledgedSeq?:number};
type Endpoint={context:RemoteContext;privateKey:CryptoKey;key?:CryptoKey;frameSeq:number;inputSeq:number};
export function RemoteBrowserView(props:{helperId:string;selectedCdpTargetId?:string;onManual:()=>void;onTab?:(cdpTargetId:string)=>void;floating?:boolean;onFloat?:()=>void;onExpand?:()=>void;onClose?:()=>void}) {
  const [frame,setFrame]=useState<RemoteFrame|null>(null);
  const [relay,setRelay]=useState<Relay>({});
  const [error,setError]=useState('');
  const [actionError,setActionError]=useState('');
  const [text,setText]=useState('');
  const [pending,setPending]=useState(false);
  const [commandSeq,setCommandSeq]=useState(0);
  const [reconnect,setReconnect]=useState(0);
  const [visible,setVisible]=useState(true);
  const [clock,setClock]=useState(Date.now());
  const sentAt=useRef(0);
  const [uncertain,setUncertain]=useState(false);
  const endpoint=useRef<Endpoint|null>(null);
  const inputLock=useRef(false);
  const selectedTab=useRef<string|null>(null);
  const mounted=useRef(true);
  const onTab=useRef(props.onTab);onTab.current=props.onTab;
  const onManual=useRef(props.onManual);onManual.current=props.onManual;
  async function request(context:RemoteContext,action:string,extra:Record<string,unknown>={},keepalive=false) {
    const response=await fetch('/api/operations/remote',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',keepalive,
      ...(!keepalive?{signal:AbortSignal.timeout(10_000)}:{}),body:JSON.stringify({...context,action,...extra})});
    return readJsonResponse<Relay>(response,'Private browser connection unavailable. Reconnect to retry.');
  }
  useEffect(()=>{
    const changed=()=>setVisible(document.visibilityState==='visible');
    document.addEventListener('visibilitychange',changed);
    return()=>document.removeEventListener('visibilitychange',changed);
  },[]);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    mounted.current=true;let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    let current:Endpoint|undefined;
    const openedAt=Date.now();
    inputLock.current=false;setPending(false);setUncertain(false);selectedTab.current=null;
    async function poll() {
      if(disposed||!current)return;
      try{
        const value=await request(current.context,'poll');
        if(disposed)return;
        if(!value.helperKey&&Date.now()-openedAt>12_000)throw new Error('No private-browser response from the helper. Connect the compatible helper release, then reconnect.');
        if(value.helperKey&&!current.key)current.key=await deriveRemoteKey(current.privateKey,value.helperKey);
        if(value.frame&&current.key&&value.frame.seq>current.frameSeq) {
          const image=await openRemote<RemoteFrame>(current.key,current.context,'frame',value.frame,current.frameSeq);
          if(disposed)return;
          if(!image.jpeg||image.jpeg.length>650_000||!Array.isArray(image.tabs)||image.tabs.length>100)throw new Error('Invalid browser image');
          current.frameSeq=value.frame.seq;setFrame(image);
          if(selectedTab.current===image.tabId){onTab.current?.(image.tabId);selectedTab.current=null;}
          else if(!selectedTab.current&&!preferred.current)onTab.current?.(image.tabId);
        }
        if(disposed)return;
        if(Number(value.acknowledgedSeq??0)>=current.inputSeq&&value.status?.startsWith('Action not confirmed'))selectedTab.current=null;
        setRelay(value);setError('');
      }catch(cause){if(!disposed&&document.visibilityState!=='hidden'){setRelay(value=>({...value,manual:false}));setError(cause instanceof Error?cause.message:'Browser disconnected. Reconnect to retry.');}}
      finally{if(!disposed)timer=setTimeout(()=>void poll(),800);}
    }
    async function open() {
      if(!visible)return;
      try{
        const keys=await createRemoteKeys();
        if(disposed)return;
        setFrame(null);setRelay({});setCommandSeq(0);setError('');setActionError('');
        current={context:{helperId:props.helperId,sessionId:crypto.randomUUID(),clientId:crypto.randomUUID()},privateKey:keys.privateKey,frameSeq:0,inputSeq:0};
        endpoint.current=current;
        await request(current.context,'open',{publicKey:keys.publicKey});
        if(disposed){void request(current.context,'close',{},true).catch(()=>{});return;}
        void poll();
      }catch(cause){if(!disposed)setError(cause instanceof Error?cause.message:'Private browser could not connect.');}
    }
    void open();
    const leaving=()=>{if(current)void request(current.context,'close',{},true).catch(()=>{});};
    window.addEventListener('pagehide',leaving);
    return()=>{
      disposed=true;mounted.current=false;clearTimeout(timer);window.removeEventListener('pagehide',leaving);
      endpoint.current=null;setText('');
      // A failed close cannot leave control indefinite: both viewer and lease expire in 15s.
      if(current)void request(current.context,'close',{},true).catch(()=>{});
    };
  },[props.helperId,reconnect,visible]);
  const fresh=Boolean(frame&&clock-frame.capturedAt<8000&&!error);
  const waiting=commandSeq>Number(relay.acknowledgedSeq??0);
  useEffect(()=>{if(waiting&&sentAt.current&&clock-sentAt.current>12_000)setUncertain(true);},[waiting,clock]);
  const canInput=relay.manual===true&&fresh&&!pending&&!waiting&&!uncertain;
  const canChoose=fresh&&!pending&&!waiting&&!uncertain;
  const preferred=useRef(props.selectedCdpTargetId);
  useEffect(()=>{preferred.current=props.selectedCdpTargetId;},[props.selectedCdpTargetId]);
  const followPreferred=useEffectEvent(()=>{
    const target=preferred.current;
    if(target&&frame?.tabId===target){preferred.current=undefined;return;}
    if(canChoose&&target&&frame?.tabs.some(tab=>tab.id===target)){
      preferred.current=undefined;
      void input({type:'select-tab',targetId:target},false);
    }
  });
  useEffect(()=>{followPreferred();},[canChoose,frame?.tabId,frame?.tabs,props.selectedCdpTargetId]);
  async function control(action:'control'|'release') {
    const current=endpoint.current;
    if(!current||inputLock.current)return false;
    inputLock.current=true;setPending(true);
    setActionError('');
    try{
      await request(current.context,action);
      if(endpoint.current!==current)return;
      setRelay(value=>({...value,manual:false,reserved:action==='control',controlBlocked:action==='release',status:action==='control'?'Stopping automation; waiting for the helper to be idle':'Manual control released'}));
      onManual.current();
      return true;
    }catch(cause){if(endpoint.current===current)setActionError(cause instanceof Error?cause.message:'Control request failed.');return false;}
    finally{if(endpoint.current===current){inputLock.current=false;if(mounted.current)setPending(false);}}
  }
  async function input(action:RemoteAction,notify=true) {
    const current=endpoint.current;
    if(!(action.type==='select-tab'?canChoose:canInput)||!current?.key||!frame||inputLock.current)return;
    inputLock.current=true;setPending(true);
    setActionError('');
    try{
      const seq=++current.inputSeq;
      const command=await sealRemote(current.key,current.context,'input',seq,{...action,frameId:frame.frameId,tabId:frame.tabId,geometry:frame.geometry});
      if(endpoint.current!==current)return;
      sentAt.current=Date.now();setCommandSeq(seq);
      await request(current.context,action.type==='select-tab'?'view-tab':'input',{command});
      if(endpoint.current!==current)return;
      if(action.type==='select-tab'&&notify)selectedTab.current=action.targetId;
      if(action.type==='type')setText('');
    }catch(cause){if(endpoint.current===current){setUncertain(true);setActionError(cause instanceof Error?cause.message:'Input was not confirmed. Reconnect and inspect before retrying.');}}
    finally{if(endpoint.current===current){inputLock.current=false;if(mounted.current)setPending(false);}}
  }
  async function minimize() {
    if((relay.reserved||relay.manual)&&!await control('release'))return;
    props.onFloat?.();
  }
  const button='inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-cyan-700 disabled:opacity-40';
  return <section aria-labelledby="remote-browser-heading" className={props.floating?'fixed bottom-4 right-3 z-40 w-[min(340px,calc(100vw-24px))] overflow-hidden rounded-xl border border-slate-500 bg-white shadow-lg':'min-w-0 overflow-hidden rounded-xl border border-slate-300 bg-white'}>
    {props.floating?<><header className="flex items-center justify-between px-3 py-1"><h2 id="remote-browser-heading" className="text-sm font-semibold">Live course browser</h2><div className="flex"><button type="button" aria-label="Expand browser preview" onClick={props.onExpand} className="grid min-h-11 min-w-11 place-items-center"><Maximize2 className="size-4"/></button><button type="button" aria-label="Close browser preview" onClick={props.onClose} className="grid min-h-11 min-w-11 place-items-center"><X className="size-4"/></button></div></header>{frame?<button type="button" onClick={props.onExpand} aria-label="Open full browser view" className="block w-full bg-slate-950"><img src={`data:image/jpeg;base64,${frame.jpeg}`} alt="Live course browser preview" className="mx-auto max-h-[32vh] w-auto max-w-full"/></button>:<p className="p-3 text-sm">{error||'Connecting to the course browser…'}</p>}<p role="status" className="px-3 py-2 text-xs text-slate-600">{!visible?'Preview paused while this app is in the background.':!fresh?'Waiting for a fresh image…':'View only · tap to expand'}</p></>:<>
    <header className="space-y-3 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="remote-browser-heading" className="text-xl font-semibold text-slate-950">Course browser</h2><span role="status" className="flex items-center gap-2 text-sm font-semibold text-cyan-900">{relay.manual?<Hand className="size-4" aria-hidden="true"/>:<Eye className="size-4" aria-hidden="true"/>}{relay.manual?'You have manual control':relay.reserved?'Waiting for automation to stop':'View only'}</span></div>
      <p className="max-w-2xl text-sm leading-6 text-slate-600">This is the existing browser on your Windows helper, not a new session. Take control to sign in or interact. Its window size and zoom stay unchanged.</p>
      <div className="flex flex-wrap gap-2">
        {relay.reserved?<button type="button" disabled={pending} onClick={()=>void control('release')} className={button}>Release control</button>
          :<button type="button" disabled={!fresh||pending||relay.controlBlocked===true} onClick={()=>void control('control')} className={button}><Hand className="size-4" aria-hidden="true"/>Take control</button>}
        <button type="button" onClick={()=>setReconnect(value=>value+1)} className={button}><RefreshCw className="size-4" aria-hidden="true"/>Reconnect</button>
        {props.onFloat?<button type="button" disabled={pending} onClick={()=>void minimize()} className={button}><Minimize2 className="size-4" aria-hidden="true"/>Float preview</button>:null}
      </div>
      {relay.controlBlocked?<p role="status" className="text-sm text-slate-700">Waiting for the helper to release previous control, or another device has control.</p>:null}
      {actionError?<p role="alert" className="text-sm text-rose-800">{actionError}</p>:null}
      {uncertain?<p role="alert" className="text-sm text-amber-950">The last action could not be confirmed. Reconnect and inspect the page before trying again. It will not be repeated automatically.</p>:null}
      {error?<p role="alert" className="text-sm text-rose-800">{error}</p>:<p role="status" className="text-sm text-slate-600">{!visible?'Browser viewer paused while this page is hidden.':relay.status||'Connecting privately to your helper…'}{waiting?' · Waiting for input acknowledgement':''}</p>}
      {frame?<label className="grid gap-2 text-sm font-semibold text-slate-800">Browser tab<select value={frame.tabId} disabled={!canChoose} onChange={event=>{preferred.current=undefined;void input({type:'select-tab',targetId:event.target.value});}} className="min-h-12 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base font-normal">{frame.tabs.map(tab=><option key={tab.id} value={tab.id}>{tab.title||'Untitled tab'}</option>)}</select></label>:null}
    </header>
    <div className="min-h-40 bg-slate-950">
      {/* The image uses its intrinsic aspect ratio; taps map to existing CSS pixels, never device emulation. */}
      {frame?<img src={`data:image/jpeg;base64,${frame.jpeg}`} alt="Live view of the selected desktop course browser tab" draggable={false}
        onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();void input({type:'tap',x:(event.clientX-rect.left)*frame.geometry.width/rect.width,y:(event.clientY-rect.top)*frame.geometry.height/rect.height});}}
        className={`block h-auto w-full ${canInput?'cursor-crosshair':'cursor-default'}`}/>:<p className="p-6 text-sm text-slate-200">Waiting for a live browser image. Keep Vitriol Helper connected.</p>}
    </div>
    <div className="space-y-4 p-4 sm:p-6">
      <div aria-label="Browser navigation" className="flex flex-wrap gap-2"><button type="button" disabled={!canInput} onClick={()=>void input({type:'back'})} className={button}><ArrowLeft className="size-4" aria-hidden="true"/>Back</button><button type="button" disabled={!canInput} onClick={()=>void input({type:'forward'})} className={button}><ArrowRight className="size-4" aria-hidden="true"/>Forward</button><button type="button" disabled={!canInput} onClick={()=>void input({type:'reload'})} className={button}><RefreshCw className="size-4" aria-hidden="true"/>Refresh</button></div>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={!canInput} onClick={()=>void input({type:'scroll',x:0,y:-500})} className={button}><ArrowUp className="size-4" aria-hidden="true"/>Scroll up</button><button type="button" disabled={!canInput} onClick={()=>void input({type:'scroll',x:0,y:500})} className={button}><ArrowDown className="size-4" aria-hidden="true"/>Scroll down</button><label className="sr-only" htmlFor="remote-key">Send a key</label><select id="remote-key" aria-label="Send a key" disabled={!canInput} value="" onChange={event=>void input({type:'key',key:event.target.value})} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-base"><option value="" disabled>Send a key…</option>{REMOTE_KEYS.map(key=><option key={key}>{key}</option>)}</select></div>
      <form onSubmit={event=>{event.preventDefault();void input({type:'type',text});}} className="space-y-2">
        <label className="grid gap-2 text-sm font-semibold text-slate-800">Type or paste into the focused browser field<textarea value={text} onChange={event=>setText(event.target.value)} disabled={!relay.manual} maxLength={4000} rows={2} autoComplete="off" spellCheck={false} className="w-full rounded-md border border-slate-300 bg-white p-3 text-base font-normal"/></label>
        <button type="submit" disabled={!canInput||!text} className={button}><Send className="size-4" aria-hidden="true"/>Send text</button>
        <p className="text-xs leading-5 text-slate-600">Frames and input are encrypted between this device and the helper. Text is not saved in the Operations draft. Release control when finished; automation stays paused until you resume it.</p>
      </form>
    </div>
    </>}
    {frame?<BrowserPictureInPicture jpeg={frame.jpeg} controlsHidden={props.floating} disabled={Boolean(relay.reserved||relay.manual)||!fresh} onOpen={props.onFloat}/>:null}
  </section>;
}
