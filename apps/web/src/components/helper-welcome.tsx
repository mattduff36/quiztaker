'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowRight,Download,LoaderCircle,Monitor,Play} from 'lucide-react';

export const HELPER_OPEN_VERSION = '1.0.24';
const REMEMBERED = 'vitriol-helper-seen-v1';
type Helper = {device_name?:string;version?:string} | null;

/** A stopped Win32 app cannot be enumerated by a website. Remember evidence, never claim detection. */
export function HelperWelcome({helper,onCheck,onAdvanced}:{helper:Helper;onCheck?:()=>Promise<void>;onAdvanced?:()=>void}) {
  const router=useRouter();
  const [opening,setOpening]=useState(false),[attempted,setAttempted]=useState(false),[checking,setChecking]=useState(false);
  const [remembered,setRemembered]=useState(false),[windows,setWindows]=useState<boolean|null>(null),[checkError,setCheckError]=useState('');
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null),checkLock=useRef(false);
  useEffect(()=>{setWindows(/Windows/i.test(navigator.userAgent));try{setRemembered(localStorage.getItem(REMEMBERED)==='yes');}catch{}return()=>{if(timer.current)clearTimeout(timer.current);};},[]);
  const check=useCallback(async(manual=false)=>{
    if(checkLock.current||document.hidden)return;checkLock.current=true;if(manual)setChecking(true);
    try {
      if(onCheck)await onCheck();
      else {const response=await fetch('/api/services/status',{cache:'no-store',signal:AbortSignal.timeout(10_000)});if(!response.ok)throw new Error();const value=await response.json();if(value.helper)router.refresh();}
      setCheckError('');
    }catch{setCheckError('We could not check the connection. Keep the helper open and try again.');}
    finally{checkLock.current=false;setChecking(false);}
  },[onCheck,router]);
  useEffect(()=>{
    if(onCheck&&!opening)return;
    const poll=setInterval(()=>void check(),opening?2000:10_000);
    const focus=()=>void check();window.addEventListener('focus',focus);
    return()=>{clearInterval(poll);window.removeEventListener('focus',focus);};
  },[opening,onCheck,check]);
  const older=Boolean(helper?.version&&compareVersion(helper.version,HELPER_OPEN_VERSION)<0);
  const returning=Boolean(helper||remembered);
  function launch(){if(opening)return;setAttempted(true);setOpening(true);timer.current=setTimeout(()=>{setOpening(false);void check();},12_000);}
  return <section aria-labelledby="helper-welcome-title" className="overflow-hidden rounded-xl border border-slate-300 bg-white">
    <div className="grid gap-8 p-6 sm:p-9 lg:grid-cols-[minmax(0,1.4fr)_minmax(220px,1fr)] lg:gap-12">
      <div>
        <span className="inline-flex size-12 items-center justify-center rounded-xl bg-cyan-100 text-cyan-900"><Monitor aria-hidden="true" className="size-6"/></span>
        <h2 id="helper-welcome-title" className="mt-6 text-3xl font-semibold tracking-[-0.025em] text-slate-950">{returning?'Welcome back. Let’s get connected.':'Welcome. Let’s get your course ready.'}</h2>
        <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">Vitriol helps you read course material and work through quizzes. First, connect the Windows helper on this PC. It opens your course browser and keeps you in control.</p>
        {helper?.device_name?<p className="mt-3 text-sm text-slate-600">Your paired PC: <span className="font-semibold text-slate-800">{helper.device_name}</span>. It is not connected right now.</p>:null}
        <div className="mt-7 flex flex-wrap items-center gap-4">
          {returning&&!older&&windows!==false?<a href="vitriol-helper://open" onClick={event=>{if(opening){event.preventDefault();return;}launch();}} aria-disabled={opening} aria-busy={opening} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-700">{opening?<LoaderCircle aria-hidden="true" className="size-4 animate-spin"/>:<Play aria-hidden="true" className="size-4"/>}{opening?'Waiting for helper…':'Open Vitriol Helper'}</a>:<a href="/helper/download?asset=installer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-cyan-800"><Download aria-hidden="true" className="size-4"/>{older?'Update Vitriol Helper':'Download Windows helper'}</a>}
          <a href="/helper" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-cyan-800 underline underline-offset-4">{returning?'Connection help':'Install and pair'}<ArrowRight aria-hidden="true" className="size-4"/></a>
        </div>
        {older?<p className="mt-4 text-sm leading-6 text-slate-600">Your previous helper needs a one-time update for opening from this page. You can also open <strong>Vitriol Helper</strong> from the Windows Start menu now.</p>:null}
        {windows===false?<p className="mt-4 text-sm leading-6 text-slate-600">The helper runs on Windows 10 or 11. Open Vitriol on your Windows PC to install or start it.</p>:null}
        <p role="status" aria-live="polite" className="mt-5 text-sm leading-6 text-slate-600">{opening?'If your browser asks, allow it to open the helper. We’re waiting for it to connect.':attempted?'No connection yet. The app may be missing, blocked by the browser, or waiting for pairing. Try the options below.':'This page will continue automatically when your helper connects.'}</p>
        {checkError?<p role="alert" className="mt-3 text-sm text-rose-800">{checkError}</p>:null}
      </div>
      <aside className="border-t border-slate-200 pt-6 lg:border-t-0 lg:border-l lg:pl-9 lg:pt-0" aria-label="Getting started">
        <h3 className="text-sm font-semibold text-slate-900">A little setup, then your course</h3>
        <ol className="mt-5 space-y-5 text-sm leading-6 text-slate-600">
          <li><strong className="block font-semibold text-slate-900">1. Open the helper</strong>Install it once, then open it whenever you want to work on a course.</li>
          <li><strong className="block font-semibold text-slate-900">2. Connect your course browser</strong>Sign in to your course in the browser Vitriol opens.</li>
          <li><strong className="block font-semibold text-slate-900">3. Tell Vitriol your goal</strong>Choose reading or quiz mode and follow its progress here.</li>
        </ol>
      </aside>
    </div>
    <details open={attempted||undefined} className="border-t border-slate-200 px-6 py-5 sm:px-9">
      <summary className="min-h-6 cursor-pointer text-sm font-semibold text-slate-800">{returning?'Helper not opening?':'Already installed, or can’t find it?'}</summary>
      <div className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
        <p>We can confirm a helper when it connects, but your browser cannot reliably find an installed app while it is stopped. A paired PC may also be a different computer.</p>
        <p>Search the Windows Start menu for <strong>Vitriol Helper</strong>. Keep its window open. If it asks for a pairing code, <a href="/helper" className="font-semibold text-cyan-800 underline">open helper setup</a>.</p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {windows!==false?<a href="vitriol-helper://open" onClick={event=>{if(opening){event.preventDefault();return;}launch();}} aria-disabled={opening} className="min-h-11 py-2 font-semibold text-cyan-800 underline underline-offset-4">{opening?'Waiting for helper…':older?'Installed the update? Open helper':'Try opening the installed helper'}</a>:null}
          <a href="/helper/download?asset=installer" className="min-h-11 py-2 font-semibold text-cyan-800 underline underline-offset-4">Download or reinstall</a>
          <button type="button" disabled={checking||opening} onClick={()=>void check(true)} className="min-h-11 font-semibold text-cyan-800 underline underline-offset-4 disabled:opacity-50">{checking?'Checking connection…':'Check connection again'}</button>
        </div>
        <p>Reinstalling the official helper repairs the opening link and keeps your saved pairing.</p>
      </div>
    </details>
    {onAdvanced?<div className="border-t border-slate-200 px-6 py-4 sm:px-9"><button type="button" onClick={onAdvanced} className="min-h-11 text-sm font-medium text-slate-600 underline underline-offset-4">Advanced tools</button></div>:null}
  </section>;
}
function compareVersion(a:string,b:string){const left=a.split('.').map(Number),right=b.split('.').map(Number);for(let i=0;i<3;i++){if(!Number.isFinite(left[i]))return -1;if(left[i]!==right[i])return left[i]-right[i];}return 0;}

export function rememberHelperConnection(){try{localStorage.setItem(REMEMBERED,'yes');}catch{}}
