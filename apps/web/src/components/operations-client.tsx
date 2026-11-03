'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Download, LoaderCircle, Play, X } from 'lucide-react';
import { Panel } from '@/components/page-frame';
import { GuidedRunner } from '@/components/guided-runner';
import { connectionState, isWebUrl, operationNeedsBrowser, readJsonResponse } from '@/lib/operations-readiness';
import { useOperatorActivity } from '@/components/use-operator-activity';
import { BROWSER_REFRESH_MS, operationsPollDelay, SNAPSHOT_STALE_MS } from '@/lib/operations-policy';
import { describeTaskJob, isRunningJob, isTaskJob, retainTaskJob } from '@/lib/operations-client-state';
import type { OperatorActivity } from '@/lib/operator-activity';
import { formatDisplayDate } from '@/lib/display-date';
import { CourseCoverage } from '@/components/course-coverage';
import {HelperWelcome,rememberHelperConnection} from '@/components/helper-welcome';

interface TabRow {
  targetId: string;
  index: number;
  title: string;
  url: string;
  fingerprint: string;
  hasFocus?: boolean;
}

interface CourseRow {
  title: string;
  status?: string;
  action?: string;
  isBlocked?: boolean;
  blockedReason?: string;
}

interface DetectionSnapshot {
  detected?: string;
  detail?: string;
  fingerprint?: string;
  confidence?: number;
  evidence?: string[];
  action?: { capabilityId?: string; label?: string; steps?: string[] } | null;
  selection?: { kind?: string; title?: string; items?: CourseRow[] };
}

interface ContextResponse {
  courseCoverage?: import('@/lib/course-coverage').CourseCoverage[];
  operatorActivity?: OperatorActivity | null;
  helper: {
    id: string;
    device_name: string;
    version: string;
    is_online: boolean;
    protocol_version?: number;
    status?: string;
  } | null;
  session?: {
    id: string;
    revision: number;
    cdp_connected: boolean;
    updated_at?: string;
    tabs: TabRow[];
    roster: { certTitle?: string; courses?: CourseRow[]; activities?: CourseRow[] } | null;
    detection: DetectionSnapshot | null;
  } | null;
  recentUrls?: Array<{ url: string; title: string; seen_count: number }>;
  captures?: Array<{ id: string; title: string; fingerprint: string | null }>;
  activeJob?: { id: string; status: string; stopping?: boolean; capability_id?: string; input?: { target?: { targetId?: string; browserSessionId?: string; fingerprint?: string } }; outcome?: { status?: string; operatorResolution?: {result: 'completed' | 'failed'; requestedAt: string; resolvedAt?: string} }; diagnosis?: Diagnosis | null; output_url?: string; result?: unknown } | null;
  latestTask?: ContextResponse['activeJob'];
  parityEnabled?: boolean;
  learnerEnabled?: boolean;
  helperUpdate?: {
    needed: boolean;
    protocolBlocked: boolean;
    currentVersion: string;
    latestVersion: string | null;
    installerAvailable: boolean;
    canSelfUpdate: boolean;
    mode: 'none' | 'download' | 'queue';
    requestedVersion: string | null;
    error: string | null;
    phase?: string | null;
    phaseVersion?: string | null;
    phaseUpdatedAt?: string | null;
    inProgress?: boolean;
    progressLabel?: string | null;
  };
}

interface Diagnosis {
  title?: string;
  likelyCause?: { label?: string; explanation?: string; recommendation?: string; confidence?: number };
  affectedTargets?: Array<{ title?: string; diagnosis?: string }>;
}

interface PlanResponse {
  capabilityId?: string;
  requiresBrowser?: boolean;
  planId: string;
  label: string;
  risk: string;
  verifier: string;
  steps: string[];
  evidence: string[];
  targets: Array<{ title: string }>;
  constraints?: {
    maxSteps?: number;
    submissionAuthorized?: boolean;
  } | null;
}

export function OperationsClient(props: { helperId: string }) {
  const [view, setView] = useState<'normal' | 'advanced'>('normal');
  const viewId = useId();
  const activity = useOperatorActivity(props.helperId);
  const [visible,setVisible] = useState(true);
  const [refreshError,setRefreshError] = useState('');
  const [lastChecked,setLastChecked] = useState<number|null>(null);
  const [contextError, setContextError] = useState('');
  const [pollError, setPollError] = useState('');
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string>('');
  const [selectedTitles, setSelectedTitles] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [pendingPlan, setPendingPlan] = useState<PlanResponse | null>(null);
  const [output, setOutput] = useState('');
  const [outputJobId, setOutputJobId] = useState('');
  const [job, setJob] = useState<ContextResponse['activeJob']>(null);
  const [operationBusy, setBusy] = useState(false);
  const [contextBusy, setContextBusy] = useState(true);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshJobId, setRefreshJobId] = useState<string | null>(null);
  const [actionLabel, setActionLabel] = useState('Sending request…');
  const [guidedBusy, setGuidedBusy] = useState(false);
  const [finishedTask, setFinishedTask] = useState<{jobId: string; result: 'completed' | 'failed'; stopping: boolean} | null>(null);
  const [taskRecordedHere, setTaskRecordedHere] = useState(false);
  const [taskReset, setTaskReset] = useState(0);
  const actionLock = useRef(false);
  const guidedLock = useRef(false);
  const stopGuided = useRef<(() => void) | null>(null);
  const registerGuidedStop = useCallback((stop: (() => void) | null) => {stopGuided.current=stop;}, []);
  const refreshLock = useRef(false);
  const finalizedJobs = useRef(new Set<string>());
  const dismissedTask = useRef<string | null>(null);
  const [awaitingQuestion, setAwaitingQuestion] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const replacingHelper = context?.helperUpdate?.inProgress === true;
  const busy = operationBusy || guidedBusy || activity.paused || !activity.ready || replacingHelper || updateBusy;
  const [forceCloseOffer, setForceCloseOffer] = useState(false);
  const [updateNote, setUpdateNote] = useState('');
  const [showManualDownload, setShowManualDownload] = useState(false);
  const contextRequest = useRef(0);
  const loadingContext = useRef(false);
  const browserProbe = useRef(0);
  const observedJob = context?.activeJob;
  const active = Boolean(finishedTask?.stopping) || isRunningJob(observedJob) || (!finishedTask && isRunningJob(job));
  const backgroundRefresh = Boolean(isRunningJob(observedJob) && observedJob?.capability_id === 'list-tabs' && (!isRunningJob(job) || job?.capability_id === 'list-tabs') && !finishedTask?.stopping && !guidedBusy && !operationBusy);
  const foregroundActive = Boolean(active && !backgroundRefresh);
  const onGuidedBusy = useCallback((value: boolean) => { guidedLock.current = value; setGuidedBusy(value); }, []);

  const load = useCallback(async () => {
    if (loadingContext.current) return;
    loadingContext.current=true; setContextBusy(true);
    const requestId = ++contextRequest.current;
    try {
      const response = await fetch('/api/operations/context', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const value = await readJsonResponse<ContextResponse>(response, 'Could not check the connection.');
      if (!('helper' in value)) throw new Error('Connection status is unavailable. Retry in a moment.');
      if (requestId !== contextRequest.current) return;
      setContext(value);
      activity.sync(value.operatorActivity);
      setLastChecked(Date.now());
      setContextError('');
      const task = value.latestTask;
      const resolution = task?.outcome?.operatorResolution;
      if (task && resolution && task.id !== dismissedTask.current && !guidedLock.current && !actionLock.current) {
        finalizedJobs.current.add(task.id);
        setFinishedTask(current => current?.jobId === task.id && current.stopping === Boolean(task.stopping) ? current : {jobId:task.id,result:resolution.result,stopping:Boolean(task.stopping)});
        if (!guidedLock.current) setJob(task);
      } else if (!guidedLock.current && !actionLock.current && task?.id !== dismissedTask.current && !finalizedJobs.current.has((task ?? value.activeJob)?.id ?? '')) {
        setJob(current => retainTaskJob(current, task ?? value.activeJob));
      }
    } catch (cause) {
      if (requestId !== contextRequest.current) return;
      setContextError(errorMessage(cause, 'Could not check the connection. Check your network and retry.'));
    } finally { loadingContext.current=false; setContextBusy(false); }
  }, [activity.sync]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), operationsPollDelay({active:Boolean(active)||guidedBusy,visible,paused:activity.paused,failed:Boolean(contextError)}));
    return () => {
      window.clearInterval(timer);
    };
  }, [load,active,guidedBusy,visible,activity.paused,Boolean(contextError)]);

  useEffect(()=>{
    const changed=()=>{setVisible(document.visibilityState==='visible');if(document.visibilityState==='visible') void load();};
    changed();document.addEventListener('visibilitychange',changed);window.addEventListener('focus',changed);
    return()=>{document.removeEventListener('visibilitychange',changed);window.removeEventListener('focus',changed);};
  },[load]);

  const refreshBrowser = useCallback(async(force=false)=>{
    if ((!force && (!context?.session?.cdp_connected || awaitingQuestion)) || refreshLock.current || refreshPending || actionLock.current || guidedLock.current || updateBusy || !activity.ready || activity.paused || !visible || operationBusy || guidedBusy || active || replacingHelper || !context?.helper?.is_online) return;
    if(!force && Date.now()-browserProbe.current<BROWSER_REFRESH_MS)return;
    browserProbe.current=Date.now();
    refreshLock.current=true; setRefreshPending(true);
    try {
      const response=await fetch('/api/operations/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({helperId:props.helperId,action:'refresh',force}),signal:AbortSignal.timeout(15_000)});
      const value=await readJsonResponse<{status?:string;jobId?:string}>(response,'Could not refresh browser tabs.');
      setRefreshJobId(value.jobId ?? null); if (!value.jobId) setRefreshPending(false);
      setRefreshError('');await load();
    } catch(cause){setRefreshPending(false);setRefreshError(errorMessage(cause,'Could not refresh browser tabs. Check the helper and retry.'));}
    finally { refreshLock.current=false; }
  },[refreshPending,awaitingQuestion,activity.ready,activity.paused,visible,operationBusy,guidedBusy,active,replacingHelper,updateBusy,finishedTask,context?.helper?.is_online,context?.session?.cdp_connected,props.helperId,load]);

  useEffect(()=>{
    void refreshBrowser();
    const timer=window.setInterval(()=>void refreshBrowser(),BROWSER_REFRESH_MS);
    return()=>window.clearInterval(timer);
  },[refreshBrowser]);

  useEffect(() => {
    if (!refreshJobId) return;
    let disposed=false, inFlight=false;
    const check=async()=>{if(disposed||inFlight)return;inFlight=true;try {
      const response=await fetch(`/api/jobs/${refreshJobId}`,{cache:'no-store',signal:AbortSignal.timeout(15_000)});
      if(response.status===404||response.status===410){if(!disposed){setRefreshPending(false);setRefreshJobId(null);setRefreshError('The browser check is no longer available. Check the browser again.');}return;}
      const value=await readJsonResponse<{job: {status:string}}>(response,'Could not check browser refresh.');
      if (!disposed && !isRunningJob(value.job)) {setRefreshPending(false);setRefreshJobId(null);void load();}
    } catch(cause) {if(!disposed){setRefreshError(errorMessage(cause,'Could not check browser refresh.'));}}finally{inFlight=false;}};
    void check(); const timer=window.setInterval(()=>void check(),2000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[refreshJobId,load]);

  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || guidedBusy || activity.paused || replacingHelper || updateBusy || finalizedJobs.current.has(jobId)) return;
    let disposed = false;
    let refreshing = false;
    const isActive = ['queued', 'dispatched', 'running'].includes(jobStatus ?? '');
    async function refreshJob() {
      if (refreshing) return;
      refreshing = true;
      try {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const value = await readJsonResponse<{
        job: NonNullable<ContextResponse['activeJob']>;
        events: Array<{ data: { text?: string } }>;
      }>(response, 'Could not refresh job status.');
      if (!value.job || !Array.isArray(value.events)) throw new Error('Job status response is incomplete. Retry in a moment.');
      if (disposed || actionLock.current || guidedLock.current || finalizedJobs.current.has(value.job.id)) return;
      setPollError('');
      setJob(value.job);
      setOutputJobId(value.job.id);
      setOutput(value.events.map((event) => event.data?.text ?? '').join('')
        || (value.job.result ? JSON.stringify(value.job.result, null, 2) : ''));
      if (isActive && !['queued', 'dispatched', 'running'].includes(value.job.status)) void load();
      } catch (cause) {
        if (!disposed) setPollError(errorMessage(cause, 'Could not refresh job status. Check your network and retry.'));
      } finally { refreshing = false; }
    }
    void refreshJob();
    const timer = isActive ? window.setInterval(() => void refreshJob(), 2000) : null;
    return () => { disposed = true; if (timer) window.clearInterval(timer); };
  }, [jobId, jobStatus, load, guidedBusy, activity.paused, replacingHelper, updateBusy]);

  const readiness = connectionState(context, Boolean(contextError));
  useEffect(()=>{if(context?.helper?.is_online)rememberHelperConnection();},[context?.helper?.is_online]);
  const helperReady = !contextError && context?.helper?.is_online === true;
  const snapshotStale = readiness === 'connected' && (!context?.session?.updated_at || !Number.isFinite(Date.parse(context.session.updated_at)) || Date.now()-Date.parse(context.session.updated_at)>SNAPSHOT_STALE_MS) && !foregroundActive && !guidedBusy;
  const normalCourseVisible = readiness === 'connected' && !snapshotStale && !replacingHelper;
  const hasCourseTab = Boolean(context?.session?.tabs?.some(tab=>/^https?:\/\//.test(tab.url)));
  const canEndBrowser = helperReady && readiness === 'connected' && !replacingHelper;
  const browserReady = readiness === 'connected' && !snapshotStale;
  const session = context?.session;
  const selected = session?.tabs?.find((tab) => tab.targetId === selectedTarget) ?? null;
  const update = context?.helperUpdate;
  const protocolReady = Number(context?.helper?.protocol_version ?? 1) >= 2;
  const courseItems = session?.roster?.courses ?? [];
  const activityItems = session?.roster?.activities
    ?? (session?.detection?.selection?.kind === 'class-activities' ? session.detection.selection.items ?? [] : []);
  const rosterItems = courseItems.length ? courseItems : activityItems;
  const runnable = rosterItems.filter((item) => !item.isBlocked);

  const targetInput = useMemo(() => {
    if (!session || !selected) return undefined;
    return {
      browserSessionId: session.id,
      revision: session.revision,
      targetId: selected.targetId,
      fingerprint: selected.fingerprint,
    };
  }, [selected, session]);

  async function run(capabilityId: string, capabilityInput: Record<string, unknown>, confirm: boolean) {
    if (actionLock.current || guidedLock.current || busy || active) return;
    if (!helperReady) return setError('Connect the helper before sending an operation.');
    if (operationNeedsBrowser(capabilityId) && !browserReady) return setError('Connect the browser before sending this operation.');
    if (capabilityId === 'open-url' && !isWebUrl(String(capabilityInput.url ?? ''))) return setError('Enter a valid http:// or https:// URL.');
    actionLock.current = true; contextRequest.current += 1;
    setBusy(true); setActionLabel(capabilityId === 'start-browser' ? 'Starting browser…' : 'Sending request…');
    setError('');
    try {
      const response = await fetch('/api/operations/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'plan',
          helperId: props.helperId,
          capabilityId,
          capabilityInput,
          confirm,
          fingerprint: session?.detection?.fingerprint ?? selected?.fingerprint ?? null,
          evidence: session?.detection?.evidence ?? [],
          confidence: session?.detection?.confidence,
          steps: session?.detection?.action?.steps,
          source: session?.detection ? 'auto-detect' : 'manual-capability',
          targets: [
            ...(selected ? [{ id: selected.targetId, title: selected.title || selected.url }] : []),
            ...selectedTitles.map((title) => ({ title })),
          ],
        }),
      });
      const value = await readJsonResponse<{ error?: string; plan?: PlanResponse; jobId?: string }>(response, 'Could not queue the action.');
      if (value.jobId) {
        contextRequest.current += 1;
        setPendingPlan(null);
        setJob({ id: value.jobId, status: 'queued', capability_id: capabilityId });
        setOutput('');
        return;
      }
      if (value.plan) setPendingPlan({ ...value.plan, capabilityId, requiresBrowser: operationNeedsBrowser(capabilityId) });
      else setError('The server did not return a plan or job. Retry the action.');
    } catch (cause) {
      setError(errorMessage(cause, 'The request failed. Check your network and retry.'));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  async function confirmPlan() {
    if (!pendingPlan || actionLock.current || guidedLock.current || busy || active || !helperReady || (pendingPlan.requiresBrowser !== false && !browserReady)) return;
    actionLock.current = true; contextRequest.current += 1;
    setBusy(true);
    try {
      const confirmation = await fetch(`/api/plans/${pendingPlan.planId}/confirm`, { method: 'POST' });
      if (!confirmation.ok) return setError('The plan could not be confirmed.');
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: pendingPlan.planId }),
      });
      const value = await readJsonResponse<{ jobId?: string; error?: string }>(response, 'The job could not be queued.');
      if (!value.jobId) return setError(value.error || 'The job could not be queued.');
      contextRequest.current += 1;
      setPendingPlan(null);
      setJob({ id: value.jobId, status: 'queued', capability_id: pendingPlan.capabilityId });
      setOutput('');
    } catch (cause) {
      setError(errorMessage(cause, 'The request failed. Check your network and retry.'));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  async function dismissPlan() {
    if (actionLock.current) return;
    actionLock.current=true;setBusy(true);setActionLabel('Cancelling plan…');
    try {
      if (pendingPlan) {
        const response = await fetch(`/api/plans/${pendingPlan.planId}/cancel`, { method: 'POST' });
        if (!response.ok) throw new Error('Could not cancel the plan. Retry.');
      }
      setPendingPlan(null);
    } catch (cause) { setError(errorMessage(cause, 'Could not cancel the plan. Check your network and retry.')); }
    finally {actionLock.current=false;setBusy(false);}
  }

  function openHelperDownload(installerAvailable: boolean) {
    const link = document.createElement('a');
    link.href = `/helper/download?asset=${installerAvailable ? 'installer' : 'archive'}`;
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function requestHelperUpdate() {
    const update = context?.helperUpdate;
    if (!update?.needed || actionLock.current || guidedLock.current || operationBusy || updateBusy || replacingHelper || active) return;
    setError('');
    if (update.mode === 'download') {
      openHelperDownload(update.installerAvailable);
      const jobActive = Boolean(job && ['queued', 'dispatched', 'running'].includes(job.status));
      setUpdateNote(downloadNote(update.latestVersion, update.installerAvailable, jobActive));
      return;
    }
    actionLock.current = true;
    setUpdateBusy(true);
    try {
      const response = await fetch('/api/operations/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request-helper-update', helperId: props.helperId }),
      });
      const value = await readJsonResponse<{ error?: string; status?: string; version?: string; installerAvailable?: boolean }>(response, 'Could not start the helper update.');
      if (value.status === 'download') {
        setShowManualDownload(true);
        setUpdateNote(`The helper could not install v${value.version} itself. Use the download link, close Vitriol Helper, run the installer, then start it again.`);
        return;
      }
      if (value.status === 'queued') {
        setUpdateNote(`Update v${value.version} is queued. Waiting for the helper to report progress.`);
        await load();
        return;
      }
      setUpdateNote('This helper is already on the latest release.');
    } catch (cause) {
      setError(errorMessage(cause, 'The request failed. Check your network and retry.'));
    } finally {
      actionLock.current = false;
      setUpdateBusy(false);
    }
  }

  async function endSession(forceClose: boolean) {
    if (actionLock.current) return;
    actionLock.current = true; contextRequest.current += 1;
    stopGuided.current?.();
    setBusy(true); setActionLabel('Ending browser session…');
    setError('');
    try {
    const response = await fetch('/api/operations/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'end-session', helperId: props.helperId, idempotencyKey: crypto.randomUUID(), forceClose }),
    });
    const value = await readJsonResponse<{ error?: string; status?: string }>(response, 'Could not end the session.');
    setForceCloseOffer(false);
    setError(value.status === 'close_failed' ? 'The session was recorded, but the browser close did not queue.' : value.status === 'ending' ? 'Browser close is queued. The session ends when that job finishes.' : '');
    await load();
    } catch (cause) {
      const message = errorMessage(cause, 'Could not end the session. Check your network and retry.');
      setForceCloseOffer(/course run is still active/i.test(message));
      setError(message);
    } finally { actionLock.current = false; setBusy(false); }
  }

  async function finishTask(result: 'completed' | 'failed') {
    if (!job || !isTaskJob(job) || actionLock.current) return;
    const jobId = job.id;
    actionLock.current = true;
    stopGuided.current?.();
    setBusy(true); setActionLabel('Recording task result…'); setError('');
    try {
      const response = await fetch('/api/operations/tasks/finish', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({helperId:props.helperId,jobId,result}),signal:AbortSignal.timeout(20_000)});
      const value = await readJsonResponse<{status: 'completed' | 'failed' | 'stopping'}>(response,'Could not record the task result. Retry when connected.');
      finalizedJobs.current.add(jobId); contextRequest.current += 1;
      setFinishedTask({jobId,result,stopping:value.status==='stopping'});
      setTaskRecordedHere(true);
      setTaskReset(current=>current+1); setPendingPlan(null); setOutput(''); setOutputJobId('');
      setJob(current=>current?.id===jobId ? {...current,status:value.status==='stopping'?'running':result} : current);
      await load();
    } catch(cause) {setError(errorMessage(cause,'Could not record the task result. Your task is still available.'));}
    finally {actionLock.current=false;setBusy(false);}
  }

  async function request(url: string, options: RequestInit, recovery = false) {
    if (actionLock.current || (!recovery && busy)) return;
    actionLock.current = true; contextRequest.current += 1;
    if(options.method==='DELETE')stopGuided.current?.();
    setBusy(true); setActionLabel('Sending request…');
    setError('');
    try {
      const response = await fetch(url, options);
      if (!response.ok) await readJsonResponse(response, 'The request failed.');
      await load();
    } catch (cause) { setError(errorMessage(cause, 'The request failed. Check your network and retry.')); }
    finally { actionLock.current = false; setBusy(false); }
  }

  if(readiness==='helper-offline' && view==='normal' && !foregroundActive && !awaitingQuestion && !replacingHelper && !taskRecordedHere) {
    return <HelperWelcome helper={context?.helper??null} onCheck={load} onAdvanced={()=>setView('advanced')}/>;
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 border-b border-slate-300">
        <div role="tablist" aria-label="Operations mode" className="flex gap-5" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'normal' : event.key === 'End' ? 'advanced' : view === 'normal' ? 'advanced' : 'normal';
          setView(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[id="${viewId}-${next}-tab"]`)?.focus();
        }}>
          {(['normal', 'advanced'] as const).map(mode => <button key={mode} type="button" role="tab" id={`${viewId}-${mode}-tab`} aria-controls={`${viewId}-${mode}-panel`} aria-selected={view === mode} tabIndex={view === mode ? 0 : -1} onClick={() => setView(mode)} className={`min-h-11 border-b-2 px-1 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 ${view === mode ? 'border-cyan-700 text-cyan-900' : 'border-transparent text-slate-600 hover:text-slate-950'}`}>{mode === 'normal' ? 'Normal' : 'Advanced'}</button>)}
        </div>
        {activity.ready && !activity.paused ? <button type="button" disabled={activity.pending} aria-busy={activity.pending} onClick={() => void activity.pause()} className="min-h-11 rounded-md px-3 text-sm font-medium text-slate-700 hover:bg-white focus-visible:outline-2 focus-visible:outline-cyan-700">{activity.pending ? 'Pausing…' : 'Pause session'}</button> : null}
      </div>
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-5" aria-labelledby="connection-title">
        <div className="min-w-0 flex-1" aria-live="polite">
          <h2 id="connection-title" className="text-lg font-semibold text-slate-950">{replacingHelper ? 'Helper update in progress' : snapshotStale ? (refreshPending || backgroundRefresh ? 'Checking the browser again' : 'Browser check needed') : connectionCopy[readiness].title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{replacingHelper ? 'The helper may disconnect while the installer replaces it. Wait for it to reconnect; your browser and course stay open.' : snapshotStale ? (refreshPending || backgroundRefresh ? 'Waiting for the helper to report current browser tabs.' : 'The previous tab snapshot is old. Check the browser before allowing another run.') : connectionCopy[readiness].detail}</p>
          <p className="mt-2 text-xs text-slate-500">{lastChecked ? 'Connection updates automatically' : 'Checking connection'}{activity.paused ? ' · session paused' : backgroundRefresh ? ' · updating course tabs' : active ? ' · following the current run' : ' · tabs update while the browser is free'}</p>
          {session?.updated_at?<p className="mt-1 text-xs text-slate-500">Browser last checked {formatDisplayDate(session.updated_at)}</p>:null}
          {contextError ? <p className="mt-2 text-sm text-rose-800">{contextError}</p> : null}
          {active&&!backgroundRefresh ? <p className="mt-2 text-sm font-medium text-slate-700">Wait for the current job to finish before sending another operation.</p> : null}
        </div>
        {replacingHelper ? null : readiness === 'unavailable' ? <Action primary disabled={contextBusy} onClick={() => void load()}>{contextBusy ? 'Checking connection…' : 'Retry connection'}</Action>
          : readiness === 'helper-offline' ? <a href="/helper" className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800">Set up helper</a>
          : readiness === 'browser-offline' ? <Action primary disabled={!helperReady || busy || Boolean(active)} onClick={() => run('start-browser', { capabilityId: 'start-browser' }, true)}>Start browser</Action>
          : readiness === 'browser-unknown' ? <Action primary disabled={!helperReady || busy || Boolean(active)} onClick={() => run('start-browser', { capabilityId: 'start-browser' }, true)}>Start browser</Action>
          : snapshotStale ? <Action primary disabled={busy || active || refreshPending} onClick={()=>void refreshBrowser(true)}>{refreshPending ? 'Checking browser…' : 'Check browser now'}</Action> : null}
      </section>
      {activity.pending ? <p role="status" aria-busy="true" className="text-sm text-slate-700">Updating session protection…</p> : null}
      {activity.paused ? <section role="status" className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 p-5 text-amber-950"><div><h2 className="font-semibold">Your session is paused</h2><p className="mt-1 max-w-2xl text-sm leading-6">Vitriol stops queuing steps and asks the helper to stop any current run. Your browser tabs, goal and conversation are kept. Resume when you are ready, then inspect the current page again.</p></div><button type="button" disabled={activity.pending} aria-busy={activity.pending} onClick={()=>void activity.resume()} className="min-h-11 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-cyan-800">{activity.pending ? 'Resuming…' : 'Resume session'}</button></section>
        : activity.warning ? <section role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950"><p className="text-sm">Still there? Your session pauses in {Math.max(1,Math.ceil(activity.remainingMs/1000))} seconds without activity on this page.</p><button type="button" disabled={activity.pending} aria-busy={activity.pending} onClick={()=>void activity.resume()} className="min-h-11 rounded-md border border-amber-400 px-4 text-sm font-semibold">{activity.pending ? 'Resuming…' : 'Keep working'}</button></section> : null}
      {refreshError && !normalCourseVisible ? <p role="alert" className="text-sm text-rose-800">{refreshError}</p> : null}
      {taskRecordedHere && finishedTask && !normalCourseVisible && !foregroundActive && !awaitingQuestion && view === 'normal' ? <p role="status" className="text-sm text-slate-700">Marked {finishedTask.result} by you. Reconnect when you are ready for another task.</p> : null}
      {activity.error ? <p role="alert" className="text-sm text-rose-800">{activity.error} <button type="button" disabled={activity.pending} aria-busy={activity.pending} onClick={()=>void activity.resume()} className="underline underline-offset-4">{activity.pending ? 'Reconnecting…' : 'Retry session connection'}</button></p> : null}
      {update?.needed || update?.progressLabel ? <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-950"><div><p>{update.progressLabel || `A helper update is available${update.latestVersion ? `: v${update.latestVersion}` : ''}.`}{update.phaseVersion ? ` · v${update.phaseVersion}` : ''}</p>{update.phaseUpdatedAt ? <p className="mt-1 text-xs">Last reported {formatDisplayDate(update.phaseUpdatedAt)}{replacingHelper && Date.now()-Date.parse(update.phaseUpdatedAt)>10*60_000 ? ' · Still waiting for a new report. Check that the helper is running; no completion has been confirmed.' : ''}</p> : null}{replacingHelper ? <p className="mt-1 text-xs">Course starts are paused while the helper is replaced. Your browser, goal and conversation are kept.</p> : null}{update.error ? <p className="mt-2">{update.error}</p> : null}</div>{update.needed ? <button type="button" disabled={operationBusy || guidedBusy || Boolean(active) || updateBusy || replacingHelper} onClick={() => void requestHelperUpdate()} className="min-h-11 rounded-md bg-amber-900 px-4 py-2 font-semibold text-white disabled:opacity-40">{updateBusy ? 'Requesting update…' : replacingHelper ? 'Updating helper…' : 'Update helper'}</button> : null}{updateNote ? <p className="w-full">{updateNote}</p> : null}{showManualDownload || (update.error && update.mode === "queue") ? <a className="font-semibold underline" href={`/helper/download?asset=${update.installerAvailable ? "installer" : "archive"}`}>Download the installer</a> : null}</div> : null}
      {((foregroundActive && isTaskJob(job) && (!finishedTask || finishedTask.stopping)) || awaitingQuestion || (normalCourseVisible && ((isTaskJob(job) && !finishedTask) || taskRecordedHere)) || view === 'advanced') ? <section aria-labelledby="current-task-title" className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="current-task-title" className="font-semibold text-slate-950">Current task</h2><p role="status" className="mt-1 text-sm leading-6 text-slate-600">{finishedTask ? `Marked ${finishedTask.result} by you.${finishedTask.stopping ? ' Waiting for the current helper job to stop.' : ' You can choose a page and set a new goal.'}` : isTaskJob(job) ? describeTaskJob(job) : 'Choose a course and goal to begin.'}</p></div><button type="button" disabled={operationBusy || !canEndBrowser} onClick={()=>void endSession(false)} className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 disabled:opacity-40">End browser session</button>{forceCloseOffer ? <button type="button" disabled={operationBusy} onClick={()=>void endSession(true)} className="min-h-11 rounded-md bg-rose-700 px-4 text-sm font-semibold text-white disabled:opacity-40">Force close browser</button> : null}</div>
        {isTaskJob(job) && !finishedTask ? <><p className="text-xs leading-5 text-slate-600">Record your assessment of this task. This does not change or verify the course result in the learning portal.</p><div className="flex flex-wrap gap-3"><button type="button" disabled={operationBusy} onClick={()=>void finishTask('completed')} className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 disabled:opacity-40">Mark complete</button><button type="button" disabled={operationBusy} onClick={()=>void finishTask('failed')} className="min-h-11 rounded-md border border-rose-300 px-4 text-sm font-semibold text-rose-800 disabled:opacity-40">Mark failed</button></div></> : null}
      </section> : canEndBrowser ? <div className="flex justify-end"><button type="button" disabled={operationBusy || !canEndBrowser} onClick={()=>void endSession(false)} className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 disabled:opacity-40">End browser session</button></div> : null}
      {(operationBusy || refreshPending || (active && !guidedBusy)) ? <p role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-slate-700"><LoaderCircle className="size-4 animate-spin"/>{operationBusy ? actionLabel : refreshPending ? 'Waiting for the helper to check browser tabs…' : job?.status === 'queued' ? 'Queued — waiting for the helper…' : 'Waiting for the current helper job…'}</p> : null}
      <div role="tabpanel" id={`${viewId}-normal-panel`} aria-labelledby={`${viewId}-normal-tab`} hidden={view !== 'normal'}>
      <div hidden={!normalCourseVisible}><GuidedRunner helperId={props.helperId} session={session} selectedTarget={selectedTarget} onSelect={setSelectedTarget}
        ready={browserReady && protocolReady && !operationBusy && activity.ready && !activity.paused && !replacingHelper && !updateBusy} active={foregroundActive} refreshing={backgroundRefresh || refreshPending} onBusy={onGuidedBusy} onRefresh={load}
        suspended={replacingHelper || updateBusy || operationBusy} paused={activity.paused||!activity.ready} connection={readiness} onConnect={()=>void run('start-browser',{capabilityId:'start-browser'},true)} onRefreshTabs={()=>void refreshBrowser(true)} refreshError={refreshError} snapshotStale={snapshotStale}
        lastJob={job} lastOutput={output} outputJobId={outputJobId} taskReset={taskReset} finalized={Boolean(finishedTask)} onStopControl={registerGuidedStop} onAwaitingQuestion={setAwaitingQuestion} onTaskStart={()=>{setTaskRecordedHere(false);dismissedTask.current=finishedTask?.jobId ?? null;setFinishedTask(null);contextRequest.current+=1;}} onJob={(next)=>{contextRequest.current+=1;setJob(current=>({...next,capability_id:next.capability_id ?? (current?.id===next.id ? current.capability_id : undefined)}));}} />
      {hasCourseTab ? <CourseCoverage courses={context?.courseCoverage || []} /> : null}</div>
      </div>
      {error ? <div role="alert" className="flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><AlertTriangle className="size-4" />{error}</div> : null}
      <div role="tabpanel" id={`${viewId}-advanced-panel`} aria-labelledby={`${viewId}-advanced-tab`} hidden={view !== 'advanced'}>
      <div className="space-y-6">
      {job ? (
        <section className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-slate-200">
          <header className="flex items-center justify-between px-5 py-3">
            <span className="text-sm font-semibold">Job {job.id.slice(0, 8)} · {job.status}</span>
            {isRunningJob(job) && !finishedTask ? <button type="button" disabled={operationBusy} className="text-xs font-semibold" onClick={() => void request(`/api/jobs/${job.id}`, { method: 'DELETE' }, true)}>Cancel</button> : null}
          </header>
          <details className="border-t border-white/10"><summary className="cursor-pointer px-5 py-3 text-sm font-medium">Output and diagnostics</summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-5 font-mono text-xs text-slate-400">{output || (active ? 'Waiting for helper output…' : 'No text output was recorded for this job.')}</pre>
          {job.diagnosis ? <DiagnosisPanel diagnosis={job.diagnosis} /> : null}
          </details>
        </section>
      ) : null}
      {pollError ? <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{pollError} Status refresh will retry automatically.</p> : null}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Panel className="min-w-0" title="Open tabs" meta={<button className="text-xs font-semibold text-cyan-800" disabled={!helperReady || busy || Boolean(active)} onClick={() => run('list-tabs', { capabilityId: 'list-tabs' }, true)}>Refresh</button>}>
          <div className="max-h-80 space-y-2 overflow-auto p-4">
            <p className="text-xs text-slate-500">Browser connection {session?.cdp_connected === true ? 'connected' : session?.cdp_connected === false ? 'offline' : 'not checked'} · revision {session?.revision ?? 'none'}</p>
            {(session?.tabs ?? []).map((tab) => (
              <button key={tab.targetId} type="button" disabled={busy || Boolean(active)} onClick={() => setSelectedTarget(tab.targetId)} className={`block w-full min-w-0 rounded-md border px-3 py-2 text-left ${selectedTarget === tab.targetId ? 'border-cyan-600 bg-cyan-50' : 'border-slate-200'}`}>
                <span className="block font-medium text-slate-950">{tab.title || 'Untitled tab'}</span>
                <span className="block truncate text-xs text-slate-500">{tab.url}</span>
              </button>
            ))}
            {!session?.tabs?.length ? <p className="text-sm text-slate-500">No tab snapshot yet. Refresh after the helper and Chrome are running.</p> : null}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-slate-200 p-4">
            <Action disabled={!browserReady || !protocolReady || !targetInput || busy || Boolean(active)} onClick={() => targetInput && run('fit-tab', { capabilityId: 'fit-tab', target: targetInput }, false)}>Fit tab</Action>
            <Action disabled={!browserReady || !protocolReady || !targetInput || busy || Boolean(active)} onClick={() => targetInput && run('tab-inspect', { capabilityId: 'tab-inspect', target: targetInput }, true)}>Inspect</Action>
            <Action disabled={!browserReady || !targetInput || busy || Boolean(active)} onClick={() => targetInput && run('learn-capture', { capabilityId: 'learn-capture', target: targetInput }, true)}>Capture</Action>
          </div>
          <details className="border-t border-slate-200 p-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Browser connection tools</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <Action disabled={!helperReady || !protocolReady || busy || Boolean(active)} onClick={() => run('cdp-check', { capabilityId: 'cdp-check' }, true)}>Check browser connection</Action>
              {browserReady ? <Action disabled={!helperReady || busy || Boolean(active)} onClick={() => run('start-browser', { capabilityId: 'start-browser' }, true)}>Reconnect browser</Action> : null}
            </div>
          </details>
        </Panel>
        <Panel className="min-w-0" title="Launch URL">
          <form className="min-w-0 space-y-3 p-4" onSubmit={(event) => {
            event.preventDefault();
            if (!browserReady || !protocolReady || busy || active) return;
            if (!isWebUrl(url)) { setError('Enter a valid http:// or https:// URL.'); return; }
            void run('open-url', { capabilityId: 'open-url', url: url.trim() }, false);
          }}>
            <label htmlFor="launch-url" className="block text-sm font-medium text-slate-700">Website URL</label>
            <input id="launch-url" type="url" required disabled={!helperReady || !protocolReady || busy || Boolean(active)} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" className="h-11 w-full rounded-md border border-slate-300 px-3" />
            <Action type="submit" primary disabled={!browserReady || !protocolReady || !isWebUrl(url) || busy || Boolean(active)}>Open URL</Action>
            {!browserReady ? <p className="text-sm text-slate-600">Connect the browser before opening a URL.</p> : !protocolReady ? <p className="text-sm text-slate-600">Update the helper to enable URL controls.</p> : null}
            <div className="max-h-48 space-y-2 overflow-auto">
              {(context?.recentUrls ?? []).map((item) => (
                <div key={item.url} className="flex items-center justify-between gap-3 text-sm">
                  <button type="button" disabled={!browserReady || !protocolReady || busy || Boolean(active) || !isWebUrl(item.url)} className="min-w-0 flex-1 truncate text-left text-cyan-800 disabled:text-slate-500 disabled:opacity-60" onClick={() => { setUrl(item.url); void run('open-url', { capabilityId: 'open-url', url: item.url }, false); }}>{item.title || item.url}</button>
                  <button type="button" className="text-xs text-slate-500" disabled={busy || Boolean(active) || Boolean(contextError)} onClick={() => void request('/api/operations/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'forget-url', helperId: props.helperId, url: item.url }) })}>Forget</button>
                </div>
              ))}
            </div>
          </form>
        </Panel>
      </div>

      <Panel title={session?.roster?.certTitle || 'Current certification'} meta={<button className="text-xs font-semibold text-cyan-800" disabled={!browserReady || busy || Boolean(active)} onClick={() => run('cert-status', { capabilityId: 'cert-status', ...(targetInput ? { target: targetInput } : {}) }, true)}>Read roster</button>}>
        <div className="space-y-2 p-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedTitles.length === runnable.length && runnable.length > 0} onChange={(event) => setSelectedTitles(event.target.checked ? runnable.map((item) => item.title) : [])} /> Select all runnable</label>
          {rosterItems.map((item) => (
            <label key={item.title} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm">
              <span className="flex items-center gap-2"><input type="checkbox" disabled={item.isBlocked} checked={selectedTitles.includes(item.title)} onChange={(event) => setSelectedTitles((current) => event.target.checked ? [...current, item.title] : current.filter((title) => title !== item.title))} />{item.title}</span>
              <span className="text-xs text-slate-500">{item.isBlocked ? item.blockedReason || 'Blocked' : item.status}</span>
            </label>
          ))}
          {!rosterItems.length ? <p className="text-sm text-slate-500">No roster snapshot yet.</p> : null}
          {activityItems.filter((item) => !rosterItems.some((row) => row.title === item.title)).map((item) => (
            <label key={`activity-${item.title}`} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm">
              <span className="flex items-center gap-2"><input type="checkbox" disabled={item.isBlocked} checked={selectedTitles.includes(item.title)} onChange={(event) => setSelectedTitles((current) => event.target.checked ? [...current, item.title] : current.filter((title) => title !== item.title))} />{item.title}</span>
              <span className="text-xs text-slate-500">Activity · {item.isBlocked ? item.blockedReason || 'Blocked' : item.status}</span>
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <Action disabled={!browserReady || !selectedTitles.length || busy || Boolean(active)} onClick={() => run('cert-batch', { capabilityId: 'cert-batch', titles: selectedTitles }, false)}>Complete selected</Action>
            <Action disabled={!browserReady || busy || Boolean(active)} onClick={() => run('cert-dry-run', { capabilityId: 'cert-dry-run' }, true)}>Dry-run</Action>
            <Action disabled={!browserReady || !protocolReady || !selected || !activityItems.some((item) => selectedTitles.includes(item.title) && !item.isBlocked) || busy || Boolean(active)} onClick={() => targetInput && run('class-batch', { capabilityId: 'class-batch', target: targetInput, titles: selectedTitles.filter((title) => activityItems.some((item) => item.title === title && !item.isBlocked)) }, false)}>Complete class activities</Action>
          </div>
        </div>
      </Panel>

      <Panel title="Auto-detect" meta={<button className="text-xs font-semibold text-cyan-800" disabled={!helperReady || !protocolReady || busy || Boolean(active)} onClick={() => run('detect', { capabilityId: 'detect', ...(targetInput ? { target: targetInput } : {}) }, true)}>Detect</button>}>
        <DetectionPanel
          detection={session?.detection}
          targetInput={targetInput}
          learnerEnabled={context?.learnerEnabled === true}
          disabled={!helperReady || !protocolReady || busy || Boolean(active)}
          onRun={run}
        />
      </Panel>
      {(context?.captures ?? []).length ? (
        <details className="rounded-lg border border-slate-200 bg-white"><summary className="cursor-pointer p-4 text-sm font-semibold text-slate-700">Recent captures</summary>
          <div className="space-y-2 p-4 text-sm">
            {context?.captures?.map((capture) => <p key={capture.id}>{capture.title} · {capture.fingerprint || 'no fingerprint'}</p>)}
          </div>
        </details>
      ) : null}

      <div className="flex flex-wrap justify-end gap-3 border-t border-slate-200 pt-5">
        <button type="button" disabled={!helperReady || !protocolReady || busy || Boolean(active)} onClick={() => run('close-browser', { capabilityId: 'close-browser' }, false)} className="rounded-md border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 disabled:opacity-40">Close browser</button>
      </div>


      </div></div>
      {pendingPlan ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4">
          <div className="w-full max-w-xl rounded-lg bg-white p-6">
            <div className="flex items-start justify-between">
              <h2 className="text-xl font-semibold">{pendingPlan.label}</h2>
              <button type="button" aria-label="Cancel plan" disabled={operationBusy} onClick={() => void dismissPlan()}><X className="size-4" /></button>
            </div>
            {error ? <p role="alert" className="mt-3 text-sm text-rose-800">{error}</p> : null}
            <p className="mt-3 text-sm text-slate-600">Risk {pendingPlan.risk} · {pendingPlan.verifier}</p>
            <p className="mt-2 text-sm">{pendingPlan.steps.join(' → ') || 'execute'}</p>
            {pendingPlan.constraints ? (
              <p className="mt-2 text-sm text-slate-700">
                At most {pendingPlan.constraints.maxSteps ?? 20} steps.
                {pendingPlan.constraints.submissionAuthorized === false ? ' This run will not submit the quiz.' : ''}
              </p>
            ) : null}
            <ul className="mt-3 list-disc pl-5 text-sm text-slate-600">{(pendingPlan.targets.length ? pendingPlan.targets : [{ title: 'Current browser context' }]).map((target) => <li key={target.title}>{target.title}</li>)}</ul>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={operationBusy} className="rounded-md border px-4 py-2 text-sm" onClick={() => void dismissPlan()}>Cancel</button>
              <button type="button" disabled={busy || Boolean(active) || !helperReady || (pendingPlan.requiresBrowser !== false && !browserReady)} className="rounded-md bg-amber-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" onClick={() => void confirmPlan()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : 'Confirm and queue'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function downloadNote(version: string | null, installerAvailable: boolean, jobActive: boolean): string {
  const label = version ? `v${version}` : 'the latest helper';
  const wait = jobActive ? ' Wait until the current job finishes before closing the helper.' : '';
  if (installerAvailable) {
    return `${label} is downloading. Close the Vitriol Helper window, run the installer, then start Vitriol Helper again. Pairing stays on this PC. If SmartScreen appears, choose More info, then Run anyway.${wait}`;
  }
  return `${label} is downloading. Close the Vitriol Helper window, extract the ZIP, run the MSI, then start Vitriol Helper again. Pairing stays on this PC.${wait}`;
}

function DetectionPanel(props: {
  detection?: DetectionSnapshot | null;
  targetInput?: Record<string, unknown>;
  learnerEnabled: boolean;
  disabled: boolean;
  onRun: (capabilityId: string, input: Record<string, unknown>, confirm: boolean) => Promise<void>;
}) {
  const detected = props.detection?.detected;
  const manualOnly = detected === 'server-assessment';
  const learnOffered = ['unknown', 'document-wbt', 'none', 'csod-curriculum', 'csod-learning'].includes(detected || '');
  const actionFor: Record<string, string> = {
    'scorm-player': 'scorm-complete',
    container: 'container-batch',
    'slickquiz-exam': 'slickquiz-solve',
    'csod-curriculum': 'learn-capture',
    'csod-learning': 'learn-capture',
  };
  const recommended = manualOnly ? 'learn-capture' : actionFor[detected || ''];
  return (
    <div className="space-y-3 p-4 text-sm text-slate-700">
      <p>{props.detection?.detail || detected || 'No detection snapshot yet.'}</p>
      {manualOnly ? <p className="text-amber-800">This is a timed server assessment. Capture it for review; do not submit an attempt automatically.</p> : null}
      {(props.detection?.evidence ?? []).slice(0, 6).map((item) => <p key={item} className="text-slate-500">{item}</p>)}
      {props.detection?.action?.label ? <p className="font-medium text-slate-950">Recommended: {props.detection.action.label}</p> : null}
      {recommended && props.targetInput ? (
        <Action disabled={props.disabled} onClick={() => props.onRun(recommended, { capabilityId: recommended, target: props.targetInput }, recommended === 'learn-capture')}>
          {manualOnly ? 'Capture assessment' : props.detection?.action?.label || 'Run detected action'}
        </Action>
      ) : null}
      <Action
        disabled={props.disabled || !props.learnerEnabled || !learnOffered || !props.targetInput}
        onClick={() => props.targetInput && props.onRun('quiz-learn', { capabilityId: 'quiz-learn', target: props.targetInput }, false)}
      >
        Learn quiz
      </Action>
      {!props.learnerEnabled ? <p><a href="/settings" className="font-semibold text-cyan-800 underline">Connect your AI provider in Settings</a> to enable guided learning.</p> : null}
      {manualOnly ? <p>Learn quiz does not run on a server-scored assessment.</p> : null}
    </div>
  );
}

function Action(props: { children: ReactNode; disabled?: boolean; onClick?: () => void; type?: 'button' | 'submit'; primary?: boolean }) {
  return (
    <button type={props.type ?? "button"} disabled={props.disabled} onClick={props.onClick} className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-not-allowed disabled:opacity-40 ${props.primary ? "bg-slate-950 text-white hover:bg-cyan-800" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`}>
      <Play className="size-3.5" />{props.children}
    </button>
  );
}

function DiagnosisPanel(props: { diagnosis: Diagnosis }) {
  return (
    <div className="border-t border-white/10 p-5 text-sm">
      <p className="font-semibold text-amber-200">{props.diagnosis.likelyCause?.label || props.diagnosis.title}</p>
      <p className="mt-2 text-slate-400">{props.diagnosis.likelyCause?.explanation}</p>
      <p className="mt-2 text-slate-300">{props.diagnosis.likelyCause?.recommendation}</p>
      <p className="mt-2 flex items-center gap-2 text-emerald-300"><Check className="size-4" />{Math.round((props.diagnosis.likelyCause?.confidence || 0) * 100)}% confidence</p>
    </div>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.name !== 'TypeError' ? cause.message : fallback;
}

const connectionCopy = {
  loading: { title: 'Checking connection…', detail: 'Checking the paired helper and its latest browser snapshot. Browser controls will be available once the connection is confirmed.' },
  unavailable: { title: 'Connection status unavailable', detail: 'The latest status could not be loaded. Retry the connection check before sending browser operations.' },
  'helper-offline': { title: 'Helper offline', detail: 'Start Vitriol Helper on your Windows PC and keep it running. Open helper setup if you need to install or pair it.' },
  'browser-unknown': { title: 'Helper online · browser not checked', detail: 'Start the browser to connect it, then refresh the tabs. If the browser is already running, refresh the tabs now.' },
  'browser-offline': { title: 'Helper online · browser disconnected', detail: 'The latest snapshot reports no browser connection. Start the browser, then refresh the tabs once the job finishes.' },
  connected: { title: 'Browser connected', detail: 'The helper and browser are connected. Choose a tab or open a website to continue.' },
};
