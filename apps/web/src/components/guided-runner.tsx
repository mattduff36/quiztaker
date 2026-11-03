'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Play, Square, RefreshCw, Pause } from 'lucide-react';
import { decideGuidedFlow, learnerQuestion, sameDetectedTarget, supportsGuidedLearning, uniqueQuestionTab, type GuidedDetection } from '@/lib/guided-flow';
import { learnerActivityUpdates } from '@/lib/learner-activity';
import { OBJECTIVE_LIMIT } from '@/lib/operations-client-state';
import { readJsonResponse } from '@/lib/operations-readiness';
import type { ConnectionState } from '@/lib/operations-readiness';

type Tab = { targetId: string; index: number; title: string; url: string; fingerprint: string };
type Session = { id: string; revision: number; tabs: Tab[]; cdp_connected: boolean };
type Context = { helper: { id: string; is_online: boolean; version: string } | null; session?: Session | null; learnerEnabled?: boolean; activeJob?: { id: string; status: string; capability_id?: string } | null };
type Job = { id: string; status: string; outcome?: { verified?: boolean; status?: string }; result?: { ok?: boolean; result?: { detection?: GuidedDetection } } };
type Question = { question: string; options?: string[]; next?: string; model?: boolean; targetId?: string; sessionId?: string; url?: string };
type RememberedTurn = { role: 'user' | 'assistant'; text: string; url?: string; guidance?: boolean };
type CourseMemory = { browserSessionId?: string; id: string | null; objective: string | null; history: RememberedTurn[] };
function rememberedQuestion(memory: CourseMemory | null) {
  const last = memory?.history.findLast((turn) => !turn.guidance);
  if (last?.role !== 'assistant' || !last.url) return null;
  try { const decision = JSON.parse(last.text); return decision.action?.action === 'ask-user' ? learnerQuestion(`LEARNER_QUESTION ${JSON.stringify({ ...decision.action, url: last.url })}`) : null; } catch { return null; }
}
function conversationText(turn: RememberedTurn): string | null {
  if (turn.role === 'user') return turn.text.replace(/^Previous question:[\s\S]*?\nUser answer: /, '');
  try { const value = JSON.parse(turn.text); return value.action?.action === 'ask-user' ? value.action.question : null; } catch { return null; }
}
const running = (status: string) => ['queued', 'dispatched', 'running'].includes(status);

export function GuidedRunner(props: {
  helperId: string;
  session?: Session | null;
  selectedTarget: string;
  onSelect: (id: string) => void;
  ready: boolean;
  active: boolean;
  refreshing?: boolean;
  onBusy: (value: boolean) => void;
  onRefresh: () => Promise<void>;
  lastJob?: { id: string; status: string; capability_id?: string; input?: { target?: { targetId?: string; browserSessionId?: string; fingerprint?: string } } } | null;
  outputJobId?: string;
  lastOutput: string;
  paused?: boolean;
  suspended?: boolean;
  connection?: ConnectionState;
  snapshotStale?: boolean;
  refreshError?: string;
  onConnect?: () => void;
  onRefreshTabs?: () => void;
  onPause?: () => void;
  taskReset?: number;
  finalized?: boolean;
  onTaskStart?: () => void;
  onStopControl?: (stop: (() => void) | null) => void;
  onAwaitingQuestion?: (value: boolean) => void;
  onJob?: (job: {id: string;status: string;capability_id?: string}) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stopPending,setStopPending]=useState(false);
  const stopLock=useRef(false);
  const [stage, setStage] = useState('Ready when you are');
  const [message, setMessage] = useState('Choose the course tab. Vitriol will inspect it and decide how to proceed.');
  const [currentQuestion, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState('');
  const [customReply, setCustomReply] = useState(false);
  const [settingsNeeded, setSettingsNeeded] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [mode, setMode] = useState<'read' | 'quiz'>('read');
  const [suppressRestoredQuestion, setSuppressRestoredQuestion] = useState(false);
  const [objective, setObjective] = useState('Read all relevant material in the selected course and retain it for later questions.');
  const [memory, setMemory] = useState<CourseMemory | null>(null);
  const [runOutput, setRunOutput] = useState('');
  const [guidance, setGuidance] = useState('');
  const [guidanceSending, setGuidanceSending] = useState(false);
  const [guidanceNotice, setGuidanceNotice] = useState<string | null>(null);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const objectiveEdited = useRef(false);
  const priorPage = useRef(props.selectedTarget);
  const locked = useRef(false);
  const stopped = useRef(false);
  const cancellationRequested = useRef(false);
  const mounted = useRef(true);
  const runGeneration = useRef(0);
  const finalized = useRef(props.finalized);
  finalized.current = props.finalized;
  const ownedJob = useRef<string | null>(null);
  const memoryRequest = useRef(0);
  const guidanceAttempt = useRef<{ text: string; requestId: string } | null>(null);
  const guidanceLock = useRef(false);
  const session = props.session;
  const scopeRef = useRef('');
  scopeRef.current = `${props.helperId}:${session?.id || ""}`;
  const currentMemory = memory?.browserSessionId === session?.id ? memory : null;
  const jobRunning = Boolean(props.lastJob && running(props.lastJob.status) && props.lastJob.id === props.outputJobId);
  const activityOutput = (busy && runOutput) || (jobRunning ? props.lastOutput : '');
  const progress = learnerActivityUpdates(activityOutput);
  const currentProgress = progress.at(-1) ?? '';
  const selected = session?.tabs.find((tab) => tab.targetId === props.selectedTarget);
  const savedTarget = props.lastJob?.input?.target;
  const outputQuestion = !props.finalized && !busy && props.lastJob?.id === props.outputJobId && props.lastJob?.capability_id === 'quiz-learn' && !running(props.lastJob.status)
    && savedTarget?.browserSessionId === session?.id ? learnerQuestion(props.lastOutput) : null;
  const restoredQuestion = props.finalized || suppressRestoredQuestion ? null : outputQuestion || (!busy ? rememberedQuestion(currentMemory) : null);
  const currentPauseTab = uniqueQuestionTab(currentQuestion?.url, session?.tabs || []);
  const restoredPauseTab = uniqueQuestionTab(restoredQuestion?.url, session?.tabs || []);
  const question: Question | null = props.finalized ? null : (currentQuestion && currentPauseTab && currentQuestion.sessionId === session?.id
    && (currentQuestion.targetId === props.selectedTarget || currentPauseTab.targetId === props.selectedTarget) ? currentQuestion : null)
    || (restoredQuestion && restoredPauseTab && (savedTarget?.targetId === props.selectedTarget || restoredPauseTab.targetId === props.selectedTarget)
      ? { ...restoredQuestion, model: true, targetId: restoredPauseTab.targetId, sessionId: session?.id } : null);
  const openModuleRequest = question?.question === 'Open the intended question or module, then resume.';
  const detachedQuestion = !props.finalized && !question ? currentQuestion || restoredQuestion : null;
  const replies = openModuleRequest ? ['Done, resume now'] : [...new Set(question?.options || [])].filter((option) => option.trim());
  const showReplyField = Boolean(question?.model && (customReply || replies.length === 0));
  const pauseTab = uniqueQuestionTab(question?.url, session?.tabs || []);
  const pauseTargetId = pauseTab?.targetId || (!props.selectedTarget ? restoredPauseTab?.targetId : undefined);
  const { selectedTarget, onSelect } = props;
  useEffect(() => {
    if (!busy && pauseTargetId && pauseTargetId !== selectedTarget) onSelect(pauseTargetId);
  }, [busy, pauseTargetId, selectedTarget, onSelect]);

  useEffect(() => {
    props.onStopControl?.(() => {cancellationRequested.current=true;stopped.current=true;runGeneration.current+=1;setStage('Stopping');setMessage('No further steps will be queued. Recording your task result.');});
    return () => props.onStopControl?.(null);
  }, [props.onStopControl]);

  useEffect(() => { props.onAwaitingQuestion?.(Boolean(question || detachedQuestion)); }, [Boolean(question || detachedQuestion), props.onAwaitingQuestion]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopped.current = true; }; }, []);

  useEffect(() => {
    setGuidance('');
    setGuidanceNotice(null);
    setGuidanceError(null);
    guidanceAttempt.current = null;
  }, [props.helperId, session?.id]);

  useEffect(() => {
    if (!session?.id || props.paused || props.suspended || props.finalized) return;
    const sessionId = session.id;
    let ignore = false;
    let loading = false;
    async function loadMemory() {
      if (loading) return;
      loading = true;
      const token = ++memoryRequest.current;
      try {
        const response = await fetch(`/api/operations/learning?helperId=${encodeURIComponent(props.helperId)}&sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
        const value = await readJsonResponse<CourseMemory>(response, 'Could not load course memory');
        if (ignore || token !== memoryRequest.current) return;
        setMemory({ ...value, browserSessionId: sessionId });
        // A previous quiz goal must not replace the selected page and intent.
      } catch {
        if (ignore || token !== memoryRequest.current) return;
        setMemory((current) => current?.browserSessionId === sessionId ? current : null);
      } finally { loading = false; }
    }
    void loadMemory();
    const timer = busy || props.active ? window.setInterval(() => void loadMemory(), 3000) : undefined;
    return () => { ignore = true; if (timer) window.clearInterval(timer); };
  }, [props.helperId, session?.id, props.lastJob?.id, props.lastJob?.status, busy, props.active, props.paused, props.suspended, props.finalized]);

  useEffect(() => {
    if (props.lastJob?.capability_id === 'quiz-learn' && !props.finalized) setSuppressRestoredQuestion(false);
  }, [props.lastJob?.id]);

  function clearPageQuestion() {
    setQuestion(null); setAnswer(''); setCustomReply(false); setReplyError(null); setSuppressRestoredQuestion(true);
  }
  useEffect(() => {
    if (!props.finalized) return;
    cancellationRequested.current = true; stopped.current = true; runGeneration.current += 1; memoryRequest.current += 1;
    clearPageQuestion(); setGuidance(''); setRunOutput(''); setSettingsNeeded(false);
    objectiveEdited.current = false; setObjective('');
    setStage(props.taskReset ? 'Task recorded' : 'Ready'); setMessage('Choose your next page and set a goal when you are ready.');
  }, [props.taskReset, props.finalized]);

  useEffect(() => {
    const changedPage = priorPage.current !== props.selectedTarget;
    priorPage.current = props.selectedTarget;
    if (busy) return;
    if (changedPage) clearPageQuestion();
    if (!objectiveEdited.current) setObjective((mode === 'quiz'
      ? `Use retained course material to answer and submit the quiz on ${selected?.title || 'the selected page'}, then inspect the result.`
      : `Read all relevant material on ${selected?.title || 'the selected course page'}, follow its topics and panels, and retain it for later questions.`).slice(0, OBJECTIVE_LIMIT));
  }, [mode, props.selectedTarget, selected?.url, selected?.title, busy]);

  async function api<T>(url: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(url, { method: method || (body ? 'POST' : 'GET'), cache: 'no-store', signal: AbortSignal.timeout(20_000), ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return readJsonResponse<T>(response, 'The request did not complete. Check the connection and try again.');
  }

  function checkStopped() { if (stopped.current || !mounted.current || finalized.current) throw new Error('Stopped. Inspect again when you are ready.'); }

  async function freshContext(targetId: string): Promise<{ context: Context; tab: Tab; target: Record<string, unknown> }> {
    checkStopped();
    const context = await api<Context>('/api/operations/context');
    checkStopped();
    if (context.helper?.id !== props.helperId || !context.helper.is_online || !context.session?.cdp_connected) throw new Error('The helper or browser is disconnected. Reconnect it, then inspect again.');
    const tab = context.session.tabs.find((item) => item.targetId === targetId);
    if (!tab) throw new Error('The selected tab has closed or changed. Refresh the tab list and choose the course again.');
    return { context, tab, target: { browserSessionId: context.session.id, revision: context.session.revision, targetId, fingerprint: tab.fingerprint } };
  }

  async function queue(capabilityId: string, target?: Record<string, unknown>, guidance?: string) {
    checkStopped();
    const planned = await api<{ plan?: { planId: string }; jobId?: string; waitingForJob?: boolean }>('/api/operations/actions', {
      action: 'plan', helperId: props.helperId, capabilityId,
      capabilityInput: { capabilityId, ...(target ? { target } : {}), ...(guidance ? { guidance } : {}), ...(capabilityId === 'quiz-learn' ? { mode, objective, ...(currentMemory?.id ? { conversationId: currentMemory.id } : {}) } : {}) },
      confirm: true, source: 'auto-detect',
    });
    let jobId = planned.jobId;
    if (!jobId) {
      checkStopped();
      if (!planned.plan) throw new Error('No plan was returned. Inspect the page again.');
      if (!planned.waitingForJob) await api(`/api/plans/${planned.plan.planId}/confirm`, {}, 'POST');
      checkStopped();
      for (let attempt=0; attempt<15; attempt+=1) {
        checkStopped();
        try {
          jobId = (await api<{ jobId: string }>('/api/jobs', { planId: planned.plan.planId })).jobId;
          break;
        } catch (error) {
          if (!(error instanceof Error) || !/A job is already active/.test(error.message) || attempt===14) throw error;
          const context=await api<Context>('/api/operations/context');
          if (context.activeJob && running(context.activeJob.status) && context.activeJob.capability_id!=='list-tabs') throw error;
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }
      if (!jobId) throw new Error('The browser refresh is still finishing. Try starting again.');
    }
    ownedJob.current = jobId;
    // Navigation stops this page's orchestration, not an acknowledged helper job.
    if (cancellationRequested.current) { await api(`/api/jobs/${jobId}`, undefined, 'DELETE'); checkStopped(); }
    if (!mounted.current) checkStopped();
    // An explicit stop can arrive while the queue request is in flight.
    if (stopped.current) { await api(`/api/jobs/${jobId}`, undefined, 'DELETE'); checkStopped(); }
    props.onJob?.({id:jobId,status:'queued',capability_id:capabilityId});
    return jobId;
  }

  async function waitForJob(id: string): Promise<{ job: Job; output: string }> {
    for (let count = 0; count < 450; count += 1) {
      checkStopped();
      const value = await api<{ job: Job; events: Array<{ data?: { text?: string } }> }>(`/api/jobs/${id}`);
      checkStopped();
      const output = value.events.map((event) => event.data?.text || '').join('');
      if (mounted.current) setRunOutput(output);
      if (!running(value.job.status)) { ownedJob.current = null; props.onJob?.(value.job); return { job: value.job, output }; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('This run is taking longer than expected. Check its status in Advanced tools before starting another.');
  }

  async function start(quickReply?: string) {
    if (locked.current || !(pauseTab || selected) || !props.ready || props.active || props.paused || props.suspended || !objective.trim()) return;
    locked.current = true; stopped.current = false; cancellationRequested.current = false;
    props.onTaskStart?.();
    finalized.current = false;
    const generation = ++runGeneration.current;
    setBusy(true); props.onBusy(true); setSettingsNeeded(false); setReplyError(null); setRunOutput('');
    const reply = quickReply ?? answer.trim();
    const guidance = question?.model && !(openModuleRequest && quickReply === 'Done, resume now') && reply ? `Previous question: ${question.question}\nUser answer: ${reply}`.slice(0, 2000) : undefined;
    setQuestion(null);
    let targetId = (pauseTab || selected)!.targetId;
    try {
      setStage('Inspecting the page'); setMessage(`Reading ${(pauseTab || selected)!.title || 'the selected course tab'}…`);
      const tabsRun = await waitForJob(await queue('list-tabs'));
      if (tabsRun.job.status !== 'completed') throw new Error('Could not refresh the browser tabs. Check the helper connection.');
      await props.onRefresh();
      if (guidance) {
        const refreshed = await api<Context>('/api/operations/context');
        checkStopped();
        const resumedTab = uniqueQuestionTab(question?.url, refreshed.session?.tabs || []);
        if (question?.sessionId !== refreshed.session?.id || !resumedTab) throw new Error('The paused page changed or is ambiguous. Inspect the intended page without the old answer.');
        targetId = resumedTab.targetId;
        props.onSelect(targetId);
      }
      const before = await freshContext(targetId);
      if (guidance && (question?.sessionId !== before.context.session?.id || question?.url !== before.tab.url || !uniqueQuestionTab(question?.url, before.context.session?.tabs || []))) throw new Error('The paused page changed or is ambiguous. Inspect the intended page without the old answer.');
      const detectionRun = await waitForJob(await queue('detect', before.target));
      if (detectionRun.job.status !== 'completed' || detectionRun.job.result?.ok !== true) throw new Error('The page could not be inspected. Check Output and diagnostics in Advanced tools, then try again.');
      const detection = detectionRun.job.result.result?.detection;
      const fresh = await freshContext(targetId);
      if (!detection || !sameDetectedTarget(detection, fresh.tab) || before.tab.fingerprint !== fresh.tab.fingerprint) throw new Error('The selected page changed during inspection. Inspect it again before continuing.');
      const decision = decideGuidedFlow(detection, mode);
      if (decision.kind === 'question') { setStage('Your input is needed'); setMessage(detection.detail || 'I need your help before continuing.'); setQuestion({ ...decision, targetId, sessionId: fresh.context.session!.id, url: fresh.tab.url }); return; }
      setMessage(decision.message);
      const capability = decision.kind === 'run' ? decision.capability : 'quiz-learn';
      if (decision.kind === 'learn') {
        if (!supportsGuidedLearning(fresh.context.helper!.version)) throw new Error('Update the helper to v1.0.15 or later below, then inspect again. This update fixes page capture and enables learning questions.');
        setStage('Learning the page format');
        const capture = await waitForJob(await queue('learn-capture', fresh.target));
        if (capture.job.status !== 'completed') throw new Error('The page capture failed. Check Output and diagnostics in Advanced tools.');
        const afterCapture = await freshContext(targetId);
        if (!afterCapture.context.learnerEnabled) { setStage('Connect your AI provider'); setMessage('The page is captured. Add and test your AI connection, then return here to continue learning.'); setSettingsNeeded(true); return; }
      } else { setStage('Running the recognised format'); }
      const launch = await freshContext(targetId);
      if (launch.tab.fingerprint !== fresh.tab.fingerprint) throw new Error('The page changed before the run started. Inspect it again.');
      const result = await waitForJob(await queue(capability, launch.target, guidance));
      const asked = learnerQuestion(result.output);
      if (asked) {
        setAnswer(''); setCustomReply(false);
        const paused = await api<Context>('/api/operations/context');
        checkStopped();
        const pausedTab = uniqueQuestionTab(asked.url, paused.session?.tabs || []);
        if (paused.helper?.id !== props.helperId || paused.session?.id !== launch.context.session!.id || !pausedTab) throw new Error('The paused page is missing or ambiguous. Refresh the tab list and inspect the intended page.');
        await props.onRefresh();
        checkStopped();
        props.onSelect(pausedTab.targetId);
        setStage('Your input is needed'); setMessage('Learning is paused. Your answer will be used when you continue.');
        setQuestion({ ...asked, model: true, targetId: pausedTab.targetId, sessionId: paused.session.id });
        return;
      }
      if (result.job.status === 'completed' && result.job.outcome?.verified === true) {
        setAnswer(''); setCustomReply(false);
        setStage('Completion verified'); setMessage('The run reported verified completion. Its evidence is available in History and Advanced tools.');
      } else {
        if (question) { setQuestion(question); setReplyError('The run could not continue. Your reply is still here; check the message below before trying again.'); }
        setStage('The run needs attention');
        const providerProblem = /provider|learner.*(?:request|key|connection)|api key|quota|rate limit/i.test(result.output);
        setSettingsNeeded(providerProblem);
        setMessage(providerProblem ? 'The AI connection did not complete a request. Test your provider in Settings, then try again.' : 'The run stopped without verified completion. You can inspect again after opening the intended question or resolving the issue shown in Advanced tools.');
      }
    } catch (error) {
      if (mounted.current && generation === runGeneration.current) { if (question) { setQuestion(question); setReplyError(error instanceof Error ? error.message : 'Could not continue. Your reply has been kept.'); } setStage(stopped.current ? 'Stopped' : 'Your input is needed'); setMessage(error instanceof Error ? error.message : 'The run could not continue. Inspect again.'); }
    } finally {
      locked.current = false;
      if (mounted.current) { setBusy(false); props.onBusy(false); void props.onRefresh(); }
    }
  }

  async function sendGuidance() {
    if (guidanceLock.current || !session?.id || !currentMemory?.id) return;
    const text = guidance.trim();
    if (!text) return;
    if (!guidanceAttempt.current || guidanceAttempt.current.text !== text) {
      guidanceAttempt.current = { text, requestId: crypto.randomUUID() };
    }
    const requestId = guidanceAttempt.current.requestId;
    const requestScope = scopeRef.current;
    guidanceLock.current = true;
    setGuidanceSending(true);
    setGuidanceError(null);
    try {
      const saved = await api<CourseMemory>('/api/operations/learning', {
        helperId: props.helperId,
        sessionId: session.id,
        conversationId: currentMemory.id,
        requestId,
        text,
      });
      if (!mounted.current || requestScope !== scopeRef.current) return;
      memoryRequest.current += 1;
      setMemory({ ...saved, browserSessionId: session.id });
      setGuidance((current) => {
        if (current.trim() === text) {
          guidanceAttempt.current = null;
          return '';
        }
        guidanceAttempt.current = null;
        return current;
      });
      setGuidanceNotice(question ? 'Saved — applies at the next step. Resume when you are ready.' : 'Saved — applies at the next step.');
    } catch (error) {
      if (mounted.current) setGuidanceError(error instanceof Error ? error.message : 'The hint could not be saved. Your text is still here.');
    } finally {
      guidanceLock.current = false;
      if (mounted.current) setGuidanceSending(false);
    }
  }

  async function stop() {
    if(stopLock.current)return; stopLock.current=true;setStopPending(true);
    cancellationRequested.current = true; stopped.current = true;
    setStage('Stopping'); setMessage('No further steps will be queued. Waiting for the helper to stop the current job.');
    if (ownedJob.current) {
      try { await api(`/api/jobs/${ownedJob.current}`, undefined, 'DELETE'); }
      catch { setMessage('The stop request could not be confirmed. Use Cancel in Advanced tools or stop the helper.'); }
      finally {stopLock.current=false;setStopPending(false);}
    } else {stopLock.current=false;setStopPending(false);}
  }

  useEffect(()=>{if((props.paused || props.suspended)&&busy)void stop();},[props.paused,props.suspended]);
  const connected = props.connection ? props.connection==='connected' && !props.snapshotStale : props.ready;
  const courseTabs = (session?.tabs||[]).filter(tab=>/^https?:\/\//.test(tab.url));
  const currentStep = !connected ? 0 : !selected ? 1 : !objective.trim() ? 2 : 3;

  return <section className="overflow-hidden rounded-xl border border-slate-300 bg-white" aria-labelledby="guided-title">
    <div className="space-y-6 p-5 sm:p-7">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h2 id="guided-title" className="text-2xl font-semibold text-slate-950">Work on a course</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Open your course, tell Vitriol what you want to achieve, and follow the next step here.</p></div>{props.onPause&&!props.paused&&!props.suspended&&!busy ? <button type="button" onClick={props.onPause} className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-cyan-700"><Pause className="size-4"/>Pause session</button>:null}</header>
    <ol aria-label="Course setup progress" className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-slate-200 py-4 sm:grid-cols-4">{['Connect browser','Choose course','Set a goal','Start and follow'].map((step,index)=><li key={step} aria-current={index===currentStep?'step':undefined} className={`flex items-center gap-2 text-sm ${index===currentStep?'font-semibold text-cyan-800':index<currentStep?'text-slate-700':'text-slate-500'}`}><span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${index<currentStep?'bg-emerald-100 text-emerald-800':index===currentStep?'bg-cyan-100 text-cyan-900':'bg-slate-100 text-slate-500'}`}>{index<currentStep?<Check className="size-3.5"/>:index+1}</span>{step}</li>)}</ol>
    {!connected ? <div className="space-y-3" role="status"><h3 className="font-semibold text-slate-950">{props.connection==='helper-offline'?'Connect your Windows helper first':props.snapshotStale?'Let’s check your browser again':'Start your course browser'}</h3><p className="max-w-2xl text-sm leading-6 text-slate-600">{props.connection==='helper-offline'?'Open Vitriol Helper on this PC. Once it is online, the course controls will become available.':'Use the browser window opened by Vitriol for your course. Sign in there if asked, then come back and choose the course tab below.'}</p>{props.connection==='helper-offline'?<a href="/helper" className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white">Open helper setup</a>:<button type="button" disabled={busy||props.active||props.paused||props.suspended} onClick={props.snapshotStale?props.onRefreshTabs:props.onConnect} className="min-h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-40">{props.snapshotStale?'Check browser now':'Connect browser'}</button>}</div>:null}
    <div className="grid gap-6 lg:grid-cols-2">
    <div className="space-y-2"><div className="flex items-center justify-between gap-3"><label htmlFor="guided-course-tab" className="text-sm font-semibold text-slate-800">Choose your course tab</label><button type="button" onClick={props.onRefreshTabs} disabled={!connected||busy||props.active||props.paused||props.suspended||props.refreshing} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-cyan-800 hover:bg-cyan-50 disabled:opacity-40"><RefreshCw className={`size-3.5 ${props.refreshing ? 'animate-spin' : ''}`}/>{props.refreshing ? 'Refreshing tabs…' : 'Refresh tabs'}</button></div>
      <select id="guided-course-tab" aria-label="Course tab" value={props.selectedTarget} disabled={!connected || busy || props.active || props.paused || props.suspended} onChange={(event) => { props.onSelect(event.target.value); clearPageQuestion(); setStage('Ready when you are'); setMessage('Your course is selected. Check the goal, then start.'); }} className="min-h-12 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 text-sm font-normal focus-visible:outline-2 focus-visible:outline-cyan-700">
        <option value="">Choose the course you opened</option>{courseTabs.map((tab) => <option key={tab.targetId} value={tab.targetId}>{tab.title || 'Untitled page'} · tab {tab.index+1}</option>)}
      </select>
      {selected?<p className="break-all text-xs leading-5 text-slate-500">{new URL(selected.url).origin}</p>:<p className="text-xs leading-5 text-slate-600">{connected&&courseTabs.length===0?'No course page is open yet. Open it in the Vitriol browser, then refresh these tabs.':'Only website tabs are shown. If your course is missing, open it in the Vitriol browser and refresh.'}</p>}
      {props.refreshError?<p role="alert" className="text-sm text-rose-800">{props.refreshError}</p>:null}
    </div>
    <div hidden={!selected || courseTabs.length===0} className="space-y-3"><label className="grid gap-2 text-sm font-semibold text-slate-800">What should Vitriol do?<select aria-label="Course activity" value={mode} disabled={busy || props.active || props.paused || props.suspended} onChange={event => { setMode(event.target.value as 'read' | 'quiz'); clearPageQuestion(); }} className="min-h-12 rounded-md border border-slate-300 bg-white px-3 font-normal"><option value="read">Read course material</option><option value="quiz">Take the quiz</option></select></label>
    <label className="grid gap-2 text-sm font-semibold text-slate-800">What would you like to achieve?<textarea value={objective} onChange={(event) => { objectiveEdited.current = true; setObjective(event.target.value.slice(0, OBJECTIVE_LIMIT)); }} disabled={busy || props.active || props.paused || props.suspended} maxLength={OBJECTIVE_LIMIT} rows={3} placeholder="For example: read this module, then help me with its quiz." className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-normal leading-6 focus-visible:outline-2 focus-visible:outline-cyan-700" /><span className="text-xs font-normal text-slate-600">Collected course material stays available across pages. Check your goal when changing pages.</span></label></div>
    </div>
    {!question ? <div role="status" aria-live="polite" className="border-t border-slate-200 pt-5"><p className="font-semibold text-slate-950">{props.paused?'Waiting for your session to resume':props.refreshing?'Updating your course tabs':stage}</p><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{props.paused?'Use Resume session above. Your goal, replies and browser tabs are kept.':!connected?'Connect the helper and browser to continue.':!selected?'Choose your course tab above. Vitriol will read the page and explain the next step.':message}</p></div> : null}
    {progress.length > 0 && (busy || jobRunning) ? <section className="rounded-md border border-slate-200 bg-slate-50 p-4" aria-labelledby="live-activity-title">
      <h3 id="live-activity-title" className="text-sm font-semibold text-slate-950">Live activity</h3>
      {progress.length > 1 ? <ol className="mt-3 space-y-1 text-sm leading-6 text-slate-600">{progress.slice(0, -1).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol> : null}
      <p role="status" aria-live="polite" className="mt-2 text-sm font-medium leading-6 text-slate-800">{currentProgress}</p>
    </section> : null}
    {replyError ? <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{replyError}</p> : null}
    {detachedQuestion ? <section className="space-y-2 border-t border-slate-200 pt-5" aria-live="polite"><h3 className="font-semibold text-slate-950">Earlier assistant question</h3><p className="text-slate-800">{detachedQuestion.question}</p><p className="text-sm text-slate-600">The page has changed. Inspect the intended course page to continue with fresh information.</p></section> : null}
    {question ? <section className="space-y-4 border-t border-slate-200 pt-5" aria-labelledby="assistant-request-title">
      <h3 id="assistant-request-title" className="text-base font-semibold text-slate-950">{openModuleRequest || !question.model ? 'Action needed in the helper browser' : 'Your AI assistant has a question'}</h3>
      <p className="text-sm leading-6 text-slate-600">{openModuleRequest ? 'Vitriol could not find quiz controls on this page. Learning is paused until you are ready.' : 'Learning is paused. Choose a reply below or write your own to continue.'}</p>
      <div className="rounded-md border border-cyan-200 bg-cyan-50 px-5 py-4 sm:px-6"><p className="text-base font-semibold leading-7 text-slate-950 sm:text-lg sm:leading-8">{openModuleRequest ? 'Open the quiz question or module you want to work on in the helper browser. Then return here and resume.' : question.question}</p></div>
      {question.model ? <>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
          {replies.map((option) => <button key={option} type="button" disabled={!props.ready || busy || props.active || props.paused || props.suspended} onClick={() => void start(option)} className="min-h-11 rounded-md bg-slate-950 px-4 py-3 text-left text-sm font-semibold text-white hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:opacity-40">{option}</button>)}
          {!showReplyField ? <button type="button" onClick={() => setCustomReply(true)} className="min-h-11 rounded-md px-1 text-sm font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 transition-colors hover:text-cyan-800 hover:decoration-cyan-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700">Write a different reply</button> : null}
        </div>
        {showReplyField ? <><label className="grid gap-2 text-sm font-medium text-slate-950">Your reply<textarea autoFocus={customReply} value={answer} maxLength={1400} onChange={(event) => setAnswer(event.target.value)} className="min-h-24 rounded-md border border-slate-400 bg-white p-3" /></label><p className="text-xs text-cyan-900">Replies may be shared with your AI provider. Do not include passwords or API keys.</p></> : null}
      </> : null}
    </section> : null}
    <div className="flex flex-wrap items-center gap-3">
      {(selected || busy || question) && (!question?.model || showReplyField || busy) ? <button type="button" onClick={() => void start()} disabled={!props.ready || !(pauseTab || selected) || !objective.trim() || busy || props.active || props.paused || props.suspended || Boolean(question?.model && !answer.trim())} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}{busy ? 'Working…' : question?.model ? 'Send answer and continue' : question?.next || 'Inspect and start'}</button> : null}
      {busy ? <button type="button" disabled={stopPending} aria-busy={stopPending} onClick={() => void stop()} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-semibold"><Square className="size-4" />{stopPending ? 'Requesting stop…' : 'Stop'}</button> : null}
      {settingsNeeded ? <a href="/settings" className="font-semibold text-cyan-800 underline">Connect or test AI in Settings</a> : null}
    </div>
    {currentMemory?.id ? <div className="space-y-3 border-t border-slate-200 pt-5">
      <label className="grid gap-2 text-sm font-semibold text-slate-800">Hint or change of direction
        <textarea value={guidance} onChange={(event) => { setGuidance(event.target.value); setGuidanceNotice(null); setGuidanceError(null); }} disabled={guidanceSending} maxLength={2000} rows={2} placeholder="Give the assistant a hint or change direction." className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-normal leading-6" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void sendGuidance()} disabled={guidanceSending || !guidance.trim()} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-900 hover:border-cyan-700 hover:text-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-not-allowed disabled:opacity-40">{guidanceSending ? 'Saving…' : 'Send guidance'}</button>
        {guidanceNotice ? <p role="status" className="text-sm text-slate-700">{guidanceNotice}</p> : null}
      </div>
      {guidanceError ? <p role="alert" className="text-sm text-amber-950">{guidanceError}</p> : null}
    </div> : null}
    {currentMemory?.history.some((turn) => conversationText(turn)) ? <details className="rounded-md border border-slate-200 bg-slate-50 p-4"><summary className="cursor-pointer text-sm font-semibold text-slate-700">Conversation remembered for this course</summary><ol className="mt-4 space-y-3">{currentMemory.history.map((turn, index) => { const text = conversationText(turn); return text ? <li key={index} className="text-sm leading-6 text-slate-700"><span className="font-semibold">{turn.role === 'user' ? 'You' : 'AI assistant'}: </span>{text}</li> : null; })}</ol></details> : null}
    <p className="max-w-2xl text-xs leading-5 text-slate-600">Vitriol reads and navigates the selected course and asks when it needs your help. Read course material collects information. Take the quiz can answer and submit the selected quiz, then checks the visible result. Keep this page open for automatic follow-up steps.</p>
    </div><footer className="border-t border-slate-200 bg-slate-50 px-5 py-4 text-xs leading-5 text-slate-600 sm:px-7">Tabs update automatically when the browser is free. After 30 minutes without input on this page, Vitriol pauses the session and keeps your place. You will get a warning before it pauses.</footer>
  </section>;
}
