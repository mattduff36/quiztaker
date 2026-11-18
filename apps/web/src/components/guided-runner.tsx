'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LoaderCircle, Play, Square, RefreshCw, Pause } from 'lucide-react';
import { decideGuidedFlow, independentIntent, independentPlans, learnerQuestion, learnerStopMessage, observedQuizResult, sameDetectedTarget, supportsGuidedLearning, questionTargetTab, type GuidedDetection, type GuidedLearningMode, type IndependentIntent } from '@/lib/guided-flow';
import { learnerActivityUpdates } from '@/lib/learner-activity';
import { OBJECTIVE_LIMIT } from '@/lib/operations-client-state';
import { readJsonResponse } from '@/lib/operations-readiness';
import type { ConnectionState } from '@/lib/operations-readiness';
import type { useSharedOperations } from '@/components/use-shared-operations';
import { defaultOperationsObjective } from '@/lib/operations-shared';

type Tab = { targetId: string; cdpTargetId?: string; index: number; title: string; url: string; fingerprint: string };
type Session = { id: string; revision: number; tabs: Tab[]; cdp_connected: boolean };
type Context = { helper: { id: string; is_online: boolean; version: string } | null; session?: Session | null; learnerEnabled?: boolean; activeJob?: { id: string; status: string; capability_id?: string } | null };
type Job = { id: string; status: string; outcome?: { verified?: boolean; status?: string }; result?: { ok?: boolean; result?: { detection?: GuidedDetection } } };
type Question = { question: string; options?: string[]; next?: string; model?: boolean; targetId?: string; cdpTargetId?: string; sessionId?: string; url?: string; intent?: GuidedLearningMode };
type CourseMode = 'independent' | 'coordinate' | 'quick';
type RememberedTurn = { role: 'user' | 'assistant'; text: string; url?: string; guidance?: boolean };
type CourseMemory = { browserSessionId?: string; id: string | null; objective: string | null; history: RememberedTurn[] };
function conversationText(turn: RememberedTurn): string | null {
  if (turn.role === 'user') return turn.text.replace(/^Previous question:[\s\S]*?\nUser answer: /, '');
  try { const value = JSON.parse(turn.text); return value.action?.action === 'ask-user' ? value.action.question : null; } catch { return null; }
}
const running = (status: string) => ['queued', 'dispatched', 'running'].includes(status);

export function GuidedRunner(props: {
  shared?:ReturnType<typeof useSharedOperations>;
  helperId: string;
  session?: Session | null;
  selectedTarget: string;
  onSelect: (id: string) => void;
  ready: boolean;
  active: boolean;
  refreshing?: boolean;
  onBusy: (value: boolean) => void;
  onRefresh: () => Promise<void>;
  lastJob?: { result?: unknown; id: string; status: string; capability_id?: string; input?: { mode?: string; intent?: string; target?: { targetId?: string; browserSessionId?: string; fingerprint?: string } } } | null;
  outputJobId?: string;
  lastOutput: string;
  courseLauncher?: ReactNode;
  sessionActions?: ReactNode;
  courseCoverage?: ReactNode;
  paused?: boolean;
  suspended?: boolean;
  connection?: ConnectionState;
  snapshotStale?: boolean;
  refreshError?: string;
  onConnect?: () => void;
  onRefreshTabs?: () => void;
  onPause?: () => void;
  onViewBrowser?: () => void;
  taskReset?: number;
  freshTask?: boolean;
  preparing?: boolean;
  finalized?: boolean;
  onTaskStart?: () => void;
  onStopControl?: (stop: (() => string | null) | null) => void;
  onAwaitingQuestion?: (value: boolean) => void;
  onJob?: (job: {id: string;status: string;capability_id?: string}) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [finishingRecordingId, setFinishingRecordingId] = useState<string | null>(null);
  const [readyRecordingId, setReadyRecordingId] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState('');
  const [stopPending,setStopPending]=useState(false);
  const stopLock=useRef(false);
  const [stage, setStage] = useState('Ready when you are');
  const [message, setMessage] = useState('Choose the course tab. Vitriol will inspect it and decide how to proceed.');
  const [localQuestion, setLocalQuestion] = useState<Question | null>(null);
  const currentQuestion=props.shared?props.shared.draft.question??null:localQuestion;
  function setQuestion(value:Question|null) {setLocalQuestion(value);setAnswer('');props.shared?.edit({question:value,answer:''});}
  const [localAnswer, setAnswer] = useState('');
  const answer=props.shared?props.shared.draft.answer??'':localAnswer;
  const [customReply, setCustomReply] = useState(false);
  const [settingsNeeded, setSettingsNeeded] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [localMode, setMode] = useState<CourseMode>('independent');
  const mode=props.shared?props.shared.draft.mode??'independent':localMode;
  const [localIntent, setChosenIntent] = useState<IndependentIntent | null>(null);
  const sharedIntent=props.shared?.draft.chosenIntent;
  const chosenIntent=props.shared?sharedIntent??null:localIntent;
  const [suppressRestoredQuestion, setSuppressRestoredQuestion] = useState(Boolean(props.freshTask));
  const [localObjective, setObjective] = useState('Read all relevant material in the selected course and retain it for later questions.');
  const [localObjectiveEdited,setObjectiveEdited]=useState(false);
  const objectiveEdited=props.shared
    ?props.shared.draft.objectiveEdited??(props.shared.draft.objective!==undefined):localObjectiveEdited;
  const selected = props.session?.tabs.find((tab) => tab.targetId === props.selectedTarget);
  const objective=objectiveEdited?(props.shared?props.shared.draft.objective??'':localObjective)
    :props.finalized?'':defaultOperationsObjective(mode,selected?.title||'the selected course page');
  const [memory, setMemory] = useState<CourseMemory | null>(null);
  const [runOutput, setRunOutput] = useState('');
  const [localGuidance, setGuidance] = useState('');
  const guidance=props.shared?props.shared.draft.guidance??'':localGuidance;
  const [guidanceSending, setGuidanceSending] = useState(false);
  const [guidanceNotice, setGuidanceNotice] = useState<string | null>(null);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
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
  const freshConversation = useRef(Boolean(props.freshTask));
  const session = props.session;
  const scopeRef = useRef('');
  scopeRef.current = `${props.helperId}:${session?.id || ""}`;
  const currentMemory = memory?.browserSessionId === session?.id ? memory : null;
  const jobRunning = Boolean(props.lastJob && props.lastJob.capability_id !== 'list-tabs' && running(props.lastJob.status) && props.lastJob.id === props.outputJobId);
  const activityOutput = (busy && runOutput) || (jobRunning ? props.lastOutput : '');
  const progress = learnerActivityUpdates(activityOutput);
  const currentProgress = progress.at(-1) ?? '';
  const savedTarget = props.lastJob?.input?.target;
  const rawSavedIntent = props.lastJob?.input?.intent ?? props.lastJob?.input?.mode;
  const savedIntent = rawSavedIntent === 'read' || rawSavedIntent === 'quiz' || rawSavedIntent === 'read-and-assess' || rawSavedIntent === 'coordinate' ? rawSavedIntent : undefined;
  const outputQuestion = !props.finalized && !busy && props.lastJob?.id === props.outputJobId && props.lastJob?.capability_id === 'quiz-learn' && props.lastJob.status === 'awaiting-input'
    && savedTarget?.browserSessionId === session?.id ? learnerQuestion(props.lastOutput) : null;
  // Only this job's fresh marker can ask for input. Conversation history can
  // contain an answered question from an earlier interrupted job.
  const restoredQuestion = props.finalized || suppressRestoredQuestion ? null : outputQuestion;
  const currentPauseTab = questionTargetTab(currentQuestion, session?.tabs || []);
  const restoredPauseTab = questionTargetTab(restoredQuestion, session?.tabs || [],savedTarget?.targetId);
  const question: Question | null = props.finalized || mode === 'quick' ? null : (currentQuestion && currentPauseTab && currentQuestion.sessionId === session?.id
    && (currentQuestion.targetId === props.selectedTarget || currentPauseTab.targetId === props.selectedTarget) ? currentQuestion : null)
    || (restoredQuestion && restoredPauseTab && (savedTarget?.targetId === props.selectedTarget || restoredPauseTab.targetId === props.selectedTarget)
      ? { ...restoredQuestion, model: true, targetId: restoredPauseTab.targetId, sessionId: session?.id, intent: savedIntent } : null);
  const resolvedIntent = question?.intent ?? (mode === 'coordinate' ? 'coordinate' : mode === 'independent' ? chosenIntent ?? independentIntent(objective) : null);
  const openModuleRequest = question?.question === 'Open the intended question or module, then resume.';
  const detachedQuestion = !props.finalized && !question ? currentQuestion || restoredQuestion : null;
  const replies = openModuleRequest ? ['Done, resume now'] : [...new Set(question?.options || [])].filter((option) => option.trim());
  const showReplyField = Boolean(question?.model && (customReply || answer.length>0 || replies.length === 0));
  const pauseTab = questionTargetTab(question, session?.tabs || []);
  const pauseTargetId = pauseTab?.targetId || (!props.selectedTarget ? restoredPauseTab?.targetId : undefined);
  const { selectedTarget, onSelect } = props;
  useEffect(() => {
    if (!busy && pauseTargetId && !selectedTarget) onSelect(pauseTargetId);
  }, [busy, pauseTargetId, selectedTarget, onSelect]);

  useEffect(() => {
    props.onStopControl?.(() => {
      cancellationRequested.current = true;
      stopped.current = true;
      runGeneration.current += 1;
      setStage('Stopping');
      setMessage('No further steps will be queued.');
      return ownedJob.current;
    });
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
    setStage(props.taskReset ? 'Task recorded' : 'Ready'); setMessage('Choose your next page and set a goal when you are ready.');
  }, [props.taskReset, props.finalized]);

  async function api<T>(url: string, body?: unknown, method?: string): Promise<T> {
    const generation = runGeneration.current, scope = scopeRef.current;
    if(url==='/api/operations/actions'&&body&&typeof body==='object')body={...body,requestId:crypto.randomUUID(),sharedClientId:props.shared?.clientId(),workflowId:props.shared?.workflowId()??undefined};
    if(url==='/api/jobs'&&body&&typeof body==='object')body={...body,sharedClientId:props.shared?.clientId(),workflowId:props.shared?.workflowId()??undefined};
    const response = await fetch(url, { method: method || (body ? 'POST' : 'GET'), cache: 'no-store', signal: AbortSignal.timeout(20_000), ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await readJsonResponse<T>(response, 'The request did not complete. Check the connection and try again.');
    if (!mounted.current || generation !== runGeneration.current || scope !== scopeRef.current) {
      if (cancellationRequested.current && value && typeof value === 'object' && 'jobId' in value && typeof value.jobId === 'string') {
        const cancelled = await fetch(`/api/jobs/${encodeURIComponent(value.jobId)}`, {method:'DELETE',signal:AbortSignal.timeout(20_000)});
        await readJsonResponse(cancelled,'Could not stop the acknowledged job. Check Advanced tools.');
      }
      throw new Error('This task changed. Inspect the current page again.');
    }
    return value;
  }

  function checkStopped() { if (stopped.current || !mounted.current || finalized.current || (props.shared&&locked.current&&!props.shared.workflowId())) throw new Error('Task control stopped or expired. Inspect again when you are ready.'); }

  async function freshContext(targetId: string): Promise<{ context: Context; tab: Tab; target: Record<string, unknown> }> {
    checkStopped();
    const context = await api<Context>('/api/operations/context');
    checkStopped();
    if (context.helper?.id !== props.helperId || !context.helper.is_online || !context.session?.cdp_connected || context.session.id !== session?.id) throw new Error('The helper or browser session changed or disconnected. Reconnect it, then inspect again.');
    const tab = context.session.tabs.find((item) => item.targetId === targetId);
    if (!tab) throw new Error('The selected tab has closed or changed. Refresh the tab list and choose the course again.');
    return { context, tab, target: { browserSessionId: context.session.id, revision: context.session.revision, targetId, fingerprint: tab.fingerprint } };
  }

  async function queue(capabilityId: string, target?: Record<string, unknown>, guidance?: string, intent?: GuidedLearningMode) {
    checkStopped();
    const learnerInput = {
      mode: intent === 'read' ? 'read' : 'quiz',
      ...(intent === 'read-and-assess' || intent === 'coordinate' ? { intent } : {}),
      objective,
      ...(freshConversation.current ? {newConversation:true} : currentMemory?.id ? { conversationId: currentMemory.id } : {}),
    };
    const planned = await api<{ plan?: { planId: string }; jobId?: string; waitingForJob?: boolean }>('/api/operations/actions', {
      action: 'plan', helperId: props.helperId, capabilityId,
      capabilityInput: { capabilityId, ...(target ? { target } : {}), ...(guidance ? { guidance } : {}), ...(capabilityId === 'quiz-learn' ? learnerInput : {}) },
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
    if(capabilityId==='quiz-learn') {
      if(freshConversation.current)setMemory(null);
      freshConversation.current=false;
    }
    // Navigation stops this page's orchestration, not an acknowledged helper job.
    if (cancellationRequested.current) { await api(`/api/jobs/${jobId}`, undefined, 'DELETE'); checkStopped(); }
    if (!mounted.current) checkStopped();
    // An explicit stop can arrive while the queue request is in flight.
    if (stopped.current) { await api(`/api/jobs/${jobId}`, undefined, 'DELETE'); checkStopped(); }
    props.onJob?.({id:jobId,status:'queued',capability_id:capabilityId});
    return jobId;
  }

  async function waitForJob(id: string, recording = false): Promise<{ job: Job; output: string }> {
    let reportedStatus = 'queued';
    for (let count = 0; count < (recording ? 7200 : 900); count += 1) {
      checkStopped();
      const value = await api<{ job: Job; events: Array<{ data?: { text?: string } }> }>(`/api/jobs/${id}`);
      checkStopped();
      const output = value.events.map((event) => event.data?.text || '').join('');
      if (mounted.current) setRunOutput(output);
      if (recording && output.includes('QUICK_SCRAPE_READY ')) {
        setReadyRecordingId(id);
      }
      if (!running(value.job.status)) { ownedJob.current = null; props.onJob?.(value.job); return { job: value.job, output }; }
      if (reportedStatus !== value.job.status) {
        reportedStatus = value.job.status;
        props.onJob?.(value.job);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('This run is taking longer than expected. Check its status in Advanced tools before starting another.');
  }

  async function start(quickReply?: string) {
    const intent = resolvedIntent;
    if (locked.current || !(pauseTab || selected) || !props.ready || props.active || props.paused || props.suspended || (mode !== 'quick' && (!objective.trim() || !intent))) return;
    locked.current = true; stopped.current = false; cancellationRequested.current = false;
    props.onTaskStart?.();
    finalized.current = false;
    const generation = ++runGeneration.current;
    const scope = scopeRef.current;
    setBusy(true); props.onBusy(true); setSettingsNeeded(false); setReplyError(null); setRunOutput('');
    const reply = quickReply ?? answer.trim();
    const guidance = question?.model && reply ? `Previous question: ${question.question}\nUser answer: ${reply}`.slice(0, 2000) : undefined;
    let targetId = (pauseTab || selected)!.targetId;
    try {
      props.shared?.edit({objective,mode,answer:''});
      await props.shared?.begin();
      clearPageQuestion();
      setStage('Inspecting the page'); setMessage(`Reading ${(pauseTab || selected)!.title || 'the selected course tab'}…`);
      const tabsRun = await waitForJob(await queue('list-tabs'));
      if (tabsRun.job.status !== 'completed') throw new Error('Could not refresh the browser tabs. Check the helper connection.');
      await props.onRefresh();
      checkStopped();
      if (generation !== runGeneration.current || scope !== scopeRef.current) return;
      if (guidance) {
        const refreshed = await api<Context>('/api/operations/context');
        checkStopped();
        const resumedTab = questionTargetTab(question, refreshed.session?.tabs || []);
        if (question?.sessionId !== refreshed.session?.id || !resumedTab) throw new Error('The paused page changed or is ambiguous. Inspect the intended page without the old answer.');
        targetId = resumedTab.targetId;
        props.onSelect(targetId);
      }
      const before = await freshContext(targetId);
      if (guidance && (question?.sessionId !== before.context.session?.id || question?.url !== before.tab.url || !questionTargetTab(question, before.context.session?.tabs || []))) throw new Error('The paused page changed or is ambiguous. Inspect the intended page without the old answer.');
      if (mode === 'quick') {
        setStage('Starting Quick scrape');
        setMessage('Wait for Recording before clicking through the course.');
        const recording = await waitForJob(await queue('quick-scrape', before.target), true);
        if (recording.job.status !== 'completed') throw new Error('Recording stopped before it could finish. Previously captured files remain on this PC.');
        setStage('Recording saved');
        setMessage('Your replay and transcript are saved on this PC. Captured text is available for later questions.');
        return;
      }
      const detectionRun = await waitForJob(await queue('detect', before.target));
      if (detectionRun.job.status !== 'completed' || detectionRun.job.result?.ok !== true) throw new Error('The page could not be inspected. Check Output and diagnostics in Advanced tools, then try again.');
      const detection = detectionRun.job.result.result?.detection;
      const fresh = await freshContext(targetId);
      if (!detection || !sameDetectedTarget(detection, fresh.tab) || before.tab.fingerprint !== fresh.tab.fingerprint) throw new Error('The selected page changed during inspection. Inspect it again before continuing.');
      if (!intent) return;
      const decision = decideGuidedFlow(detection, intent);
      if (decision.kind === 'question') { setStage('Your input is needed'); setMessage(detection.detail || 'I need your help before continuing.'); setQuestion({ question: decision.question, next: decision.next, targetId, cdpTargetId: fresh.tab.cdpTargetId, sessionId: fresh.context.session!.id, url: fresh.tab.url }); return; }
      setMessage(decision.message);
      const capability = decision.kind === 'run' ? decision.capability : 'quiz-learn';
      if (decision.kind === 'learn') {
        if (!supportsGuidedLearning(fresh.context.helper!.version)) throw new Error('Update the helper to v1.0.15 or later below, then inspect again. This update fixes page capture and enables learning questions.');
        setStage('Learning the page format');
        if (!guidance) {
          const capture = await waitForJob(await queue('learn-capture', fresh.target));
          if (capture.job.status !== 'completed') throw new Error('The page capture failed. Check Output and diagnostics in Advanced tools.');
        }
        const afterCapture = await freshContext(targetId);
        if (!afterCapture.context.learnerEnabled) { setStage('Connect your AI provider'); setMessage('The page is captured. Add and test your AI connection, then return here to continue learning.'); setSettingsNeeded(true); return; }
      } else { setStage('Running the recognised format'); }
      const launch = await freshContext(targetId);
      if (launch.tab.fingerprint !== fresh.tab.fingerprint) throw new Error('The page changed before the run started. Inspect it again.');
      const result = await waitForJob(await queue(capability, launch.target, guidance, intent));
      const asked = result.job.status === 'awaiting-input' ? learnerQuestion(result.output) : null;
      if (asked) {
        setAnswer(''); setCustomReply(false);
        const paused = await api<Context>('/api/operations/context');
        checkStopped();
        const pausedTab = questionTargetTab(asked, paused.session?.tabs || [],launch.tab.targetId);
        if (paused.helper?.id !== props.helperId || paused.session?.id !== launch.context.session!.id || !pausedTab) throw new Error('The paused page is missing or ambiguous. Refresh the tab list and inspect the intended page.');
        await props.onRefresh();
        checkStopped();
        props.onSelect(pausedTab.targetId);
        setStage('Your input is needed'); setMessage('Learning is paused. Your answer will be used when you continue.');
        setQuestion({ ...asked, model: true, targetId: pausedTab.targetId, sessionId: paused.session.id, intent });
        return;
      }
      if (result.job.status === 'completed' && result.job.outcome?.verified === true) {
        setAnswer(''); setCustomReply(false);
        clearPageQuestion(); setStage('Ready'); setMessage('The run finished with verified evidence. Choose your next page and goal when ready.');
      } else {
        clearPageQuestion();
        setStage('Run interrupted');
        const providerProblem = /provider|learner.*(?:request|key|connection)|api key|quota|rate limit/i.test(result.output);
        setSettingsNeeded(providerProblem);
        setMessage(learnerStopMessage(result.output) ?? (providerProblem ? 'The AI connection did not complete a request. Test your provider in Settings, then try again.' : 'The run stopped without verified completion. You can inspect again after opening the intended question or resolving the issue shown in Advanced tools.'));
      }
    } catch (error) {
      if (mounted.current && generation === runGeneration.current && scope === scopeRef.current) { clearPageQuestion(); setStage(stopped.current ? 'Stopped' : 'Run interrupted'); setMessage(error instanceof Error ? error.message : 'The run could not continue. Resume from the current page.'); }
    } finally {
      await props.shared?.end();
      if (generation === runGeneration.current || cancellationRequested.current) {
        locked.current = false;
        if (mounted.current) setBusy(false);
        props.onBusy(false);
        if (mounted.current || cancellationRequested.current) void props.onRefresh();
      }
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
      if(props.shared)await props.shared.clearGuidance(text,session.id);
      else setGuidance(current=>current.trim()===text?'':current);
      guidanceAttempt.current=null;
      setGuidanceNotice(question ? 'Saved — applies at the next step. Resume when you are ready.' : 'Saved — applies at the next step.');
    } catch (error) {
      if (mounted.current) setGuidanceError(error instanceof Error ? error.message : 'The hint could not be saved. Your text is still here.');
    } finally {
      guidanceLock.current = false;
      if (mounted.current) setGuidanceSending(false);
    }
  }

  const savedRecording = props.lastJob?.capability_id === 'quick-scrape' && props.lastJob.status === 'completed'
    ? (props.lastJob.result as {result?: {folder?:string;pages?:number;frames?:number}} | undefined)?.result : null;
  const recordingId = props.lastJob?.capability_id === 'quick-scrape' && running(props.lastJob.status) ? props.lastJob.id : null;
  const finishPending = Boolean(recordingId && finishingRecordingId === recordingId);
  const recordingReady = Boolean(recordingId && !finishPending && (readyRecordingId === recordingId
    || (props.outputJobId === recordingId && props.lastOutput.includes('QUICK_SCRAPE_READY '))));
  async function finishRecording() {
    if (!recordingId || finishPending) return;
    setFinishingRecordingId(recordingId);
    setRecordingError('');
    try {
      await api(`/api/jobs/${recordingId}`, undefined, 'DELETE');
    } catch (error) {
      setFinishingRecordingId(null);
      setRecordingError(error instanceof Error ? error.message : 'Could not finish the recording. Try again.');
    }
  }

  async function stop() {
    if(stopLock.current)return; stopLock.current=true;setStopPending(true);
    cancellationRequested.current = true; stopped.current = true;
    setStage('Stopping'); setMessage('No further steps will be queued. Waiting for the helper to stop the current job.');
    const stopId=ownedJob.current ?? (props.lastJob && running(props.lastJob.status) && props.lastJob.capability_id!=='list-tabs' ? props.lastJob.id : null);
    if (stopId) {
      try { await api(`/api/jobs/${stopId}`, undefined, 'DELETE'); }
      catch { setMessage('The stop request could not be confirmed. Use Cancel in Advanced tools or stop the helper.'); }
      finally {stopLock.current=false;setStopPending(false);}
    } else {stopLock.current=false;setStopPending(false);}
  }

  useEffect(()=>{
    if ((props.paused || props.suspended) && busy && !cancellationRequested.current) void stop();
  },[props.paused,props.suspended,busy]);
  const connected = props.connection ? props.connection==='connected' && !props.snapshotStale : props.ready;
  const courseTabs = (session?.tabs||[]).filter(tab=>/^https?:\/\//.test(tab.url));
  const draftDisabled = busy || (props.active && !props.preparing) || props.paused || props.suspended;
  const recordedStop = !props.finalized && !busy && props.lastJob?.status === 'failed' && props.lastJob.capability_id === 'quiz-learn'
    && props.lastJob.id === props.outputJobId ? learnerStopMessage(props.lastOutput) : null;
  const quizResult = !busy && props.lastJob?.capability_id === 'quiz-learn' && !running(props.lastJob.status)
    && (!savedTarget?.targetId || savedTarget.targetId===props.selectedTarget || props.finalized)
    ? observedQuizResult(props.lastJob.result) : null;

  const taskInProgress=busy||jobRunning;
  const focused=taskInProgress||Boolean(question);
  const guidancePanel=(currentMemory?.id && mode !== 'quick' && !recordingId ? <details open={!taskInProgress} className="space-y-3 border-t border-slate-200 pt-3"><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-cyan-900">Give a hint or steer</summary>
      <label className="grid gap-2 text-sm font-semibold text-slate-800">Hint or change of direction
        <textarea value={guidance} onChange={(event) => { setGuidance(event.target.value);props.shared?.edit({guidance:event.target.value}); setGuidanceNotice(null); setGuidanceError(null); }} disabled={guidanceSending} maxLength={2000} rows={2} placeholder="Give the assistant a hint or change direction." className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-normal leading-6" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void sendGuidance()} disabled={guidanceSending || !guidance.trim()} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-900 hover:border-cyan-700 hover:text-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-not-allowed disabled:opacity-40">{guidanceSending ? 'Saving…' : 'Send guidance'}</button>
        {guidanceNotice ? <p role="status" className="text-sm text-slate-700">{guidanceNotice}</p> : null}
      </div>
      {guidanceError ? <p role="alert" className="text-sm text-amber-950">{guidanceError}</p> : null}
    </details> : null);
  const activityPanel=(
!question || !question.model || showReplyField || taskInProgress || settingsNeeded ? <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {!question ? <div role="status" aria-live="polite" className="min-w-[140px] flex-1">
          <p className={recordingReady ? 'font-semibold text-red-800' : 'font-semibold text-slate-950'}>{finishPending ? 'Saving recording' : recordingReady ? 'Recording' : recordingId ? 'Starting recorder' : props.paused ? 'Waiting for your session to resume' : savedRecording?.folder ? 'Recording saved' : quizResult?.heading || (recordedStop ? (/interrupted/i.test(recordedStop) ? 'Run interrupted' : 'The run needs attention') : props.refreshing ? 'Updating your course tabs' : taskInProgress ? 'Current activity' : stage)}</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">{finishPending ? 'Keep the course window open while the recording saves.' : recordingReady ? 'You can click through the course now.' : recordingId ? 'Wait for the button to turn red before clicking through.' : props.paused ? 'Use Resume session above.' : savedRecording?.folder ? `${savedRecording.pages} page observations · ${savedRecording.frames} frames saved on this PC.` : quizResult?.detail || recordedStop || currentProgress || (!selected ? 'Choose a course tab to start.' : message)}</p>
    </div> : null}
        <div className="flex flex-wrap items-center gap-3">
          {!recordingId && !taskInProgress && (selected || busy || question) && (!question?.model || showReplyField || busy) ? <button type="button" onClick={() => void start()} disabled={!props.ready || !(pauseTab || selected) || (mode !== 'quick' && (!objective.trim() || !resolvedIntent)) || busy || props.active || props.paused || props.suspended || Boolean(question?.model && !answer.trim())} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}{busy ? (mode === 'quick' ? 'Starting recorder…' : 'Working…') : mode === 'quick' ? 'Start recording' : question?.model ? 'Send answer and continue' : question?.next || (recordedStop || stage === 'Run interrupted' ? 'Resume from current page' : 'Inspect and start')}</button> : null}
          {recordingId ? <button type="button" disabled={finishPending} aria-busy={finishPending} onClick={() => void finishRecording()} className={`inline-flex min-h-11 items-center gap-2 rounded-md px-5 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 ${recordingReady ? 'bg-red-700 text-white hover:bg-red-800 focus-visible:outline-red-700' : 'border border-slate-300 bg-white text-slate-800 disabled:opacity-60'}`}><Square aria-hidden="true" className={`size-4 ${recordingReady ? 'fill-current' : ''}`}/>{finishPending ? 'Saving recording…' : recordingReady ? 'Finish recording' : 'Stop recorder'}</button> : taskInProgress ? <button type="button" disabled={stopPending} aria-busy={stopPending} onClick={() => void stop()} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-semibold"><Square className="size-4" />{stopPending ? 'Requesting stop…' : 'Stop'}</button> : null}
          {settingsNeeded ? <a href="/settings" className="font-semibold text-cyan-800 underline">Connect or test AI in Settings</a> : null}
        </div>
      </div>
      {recordingError && recordingId ? <p role="alert" className="text-sm text-rose-800">{recordingError}</p> : null}
      {savedRecording?.folder ? <details className="text-sm text-slate-700"><summary className="w-fit cursor-pointer font-semibold">Recording folder</summary><p className="mt-2 break-all select-all">{savedRecording.folder}</p></details> : null}
      {progress.length > 1 && !recordingId ? <details className="text-sm text-slate-700"><summary className="min-h-11 w-fit cursor-pointer py-3 font-semibold">Recent activity and helper output</summary><ol className="mt-2 space-y-1">{progress.slice(0, -1).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol></details> : null}
      {props.onViewBrowser ? <button type="button" onClick={props.onViewBrowser} className="min-h-11 rounded-md px-1 text-sm font-semibold text-cyan-800 underline underline-offset-4">View course browser</button> : null}
      {taskInProgress ? guidancePanel : null}
    </div> : null
  );
  return <section className="overflow-hidden rounded-xl border border-slate-300 bg-white" aria-labelledby="guided-title">
    <div className="space-y-6 p-5 sm:p-7">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="guided-title" className="text-xl font-semibold text-slate-950">{taskInProgress?'Task in progress':'Work on a course'}</h2>
      {connected ? <p className={`${taskInProgress?'hidden sm:flex':'flex'} items-center gap-2 text-sm font-medium text-emerald-800`}><span className="size-2 rounded-full bg-emerald-600" aria-hidden="true"/>Course browser connected</p> : null}
      {props.onPause&&!props.paused&&!props.suspended&&!busy ? <button type="button" onClick={props.onPause} className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-cyan-700"><Pause className="size-4"/>Pause session</button>:null}
    </header>
    {!connected ? <div className="space-y-3" role="status"><h3 className="font-semibold text-slate-950">{props.connection==='helper-offline'?'Connect your Windows helper first':props.snapshotStale?'Let’s check your browser again':'Start your course browser'}</h3><p className="max-w-2xl text-sm leading-6 text-slate-600">{props.connection==='helper-offline'?'Open Vitriol Helper on this PC. Once it is online, the course controls will become available.':'Use the browser window opened by Vitriol for your course. Sign in there if asked, then come back and choose the course tab below.'}</p>{props.connection==='helper-offline'?<a href="/helper" className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white">Open helper setup</a>:<button type="button" disabled={busy||props.active||props.paused||props.suspended} onClick={props.snapshotStale?props.onRefreshTabs:props.onConnect} className="min-h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-40">{props.snapshotStale?'Check browser now':'Connect browser'}</button>}</div>:null}
    {focused ? activityPanel : null}
    <details open={!focused} className="group/course-setup">
      <summary className={focused ? "min-h-11 cursor-pointer py-3 text-sm font-semibold text-slate-700" : "hidden"}>Course and goal</summary>
    {props.courseLauncher}
    <div className="grid grid-cols-1 gap-5 border-t border-slate-200 pt-4 lg:grid-cols-2">
    <div className="min-w-0 space-y-2"><div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold text-slate-800">Choose your course tab</span><button type="button" onClick={props.onRefreshTabs} disabled={!connected||busy||props.active||props.paused||props.suspended||props.refreshing} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-cyan-800 hover:bg-cyan-50 disabled:opacity-40"><RefreshCw className={`size-3.5 ${props.refreshing ? 'animate-spin' : ''}`}/>{props.refreshing ? 'Refreshing tabs…' : 'Refresh tabs'}</button></div>
      <div id="guided-course-tab" role="group" aria-label="Course tab" className="grid min-w-0 gap-2">
        {courseTabs.map((tab) => <button key={tab.cdpTargetId || tab.targetId} type="button" data-target-id={tab.targetId} data-cdp-target-id={tab.cdpTargetId} aria-pressed={props.selectedTarget === tab.targetId} disabled={!connected || draftDisabled} onClick={() => { if (props.selectedTarget === tab.targetId) return; props.onSelect(tab.targetId); setChosenIntent(null); clearPageQuestion(); setStage('Ready when you are'); setMessage('Your course is selected. Check the goal, then start.'); }} className={`min-h-11 w-full min-w-0 break-words rounded-md border px-3 py-2 text-left text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-not-allowed disabled:opacity-40 ${props.selectedTarget === tab.targetId ? 'border-cyan-700 bg-cyan-50 text-cyan-950' : 'border-slate-300 bg-white text-slate-800 hover:border-cyan-700'}`}>{tab.title || 'Untitled page'} <span className="text-sm text-slate-500">· tab {tab.index+1}</span></button>)}
      </div>
      {selected?<p className="break-all text-xs leading-5 text-slate-500">{new URL(selected.url).origin}</p>:<p className="text-xs leading-5 text-slate-600">{connected&&courseTabs.length===0?'No course page is open yet. Enter its URL above.':'Only website tabs are shown. If your course is missing, open it in the Vitriol browser and refresh.'}</p>}
      {props.refreshError?<p role="alert" className="text-sm text-rose-800">{props.refreshError}</p>:null}
    </div>
    <div hidden={!selected || courseTabs.length===0} className="min-w-0 space-y-3"><fieldset aria-label="Course activity" disabled={draftDisabled} className="grid min-w-0 gap-2"><legend className="mb-2 text-sm font-semibold text-slate-800">What should Vitriol do?</legend>
      {([['independent','Work independently'],['coordinate','Co-ordinate with ChatGPT'],['quick','Scrape info with the user']] as const).map(([value,label])=><button key={value} type="button" data-mode={value} aria-pressed={mode===value} onClick={()=>{if(mode===value)return;setMode(value);props.shared?.edit({mode:value,chosenIntent:null});setChosenIntent(null);clearPageQuestion();}} className={`min-h-11 min-w-0 break-words rounded-md border px-3 py-2 text-left text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-not-allowed disabled:opacity-40 ${mode===value?'border-cyan-700 bg-cyan-50 text-cyan-950':'border-slate-300 bg-white text-slate-800 hover:border-cyan-700'}`}>{label}</button>)}
    </fieldset>
      {mode === 'coordinate' ? <p className="text-sm text-slate-600">Reads material and can submit assessment answers. Vitriol asks the Codex chat connected to your Windows helper when it needs guidance.</p> : null}
      {mode === 'quick' && !recordingId ? <p className="text-sm text-slate-600">Record the course while you click through it. Vitriol saves a replay and transcript on this PC.</p> : null}
    <label hidden={mode === 'quick'} className={mode === 'quick' ? 'hidden' : 'grid gap-2 text-sm font-semibold text-slate-800'}>What would you like to achieve?<textarea value={objective} onChange={(event) => { setObjectiveEdited(true); setChosenIntent(null); if (question) clearPageQuestion(); setObjective(event.target.value.slice(0, OBJECTIVE_LIMIT)); props.shared?.edit({objective:event.target.value.slice(0,OBJECTIVE_LIMIT),objectiveEdited:true,chosenIntent:null}); }} disabled={draftDisabled} maxLength={OBJECTIVE_LIMIT} rows={3} placeholder="For example, read the lessons, then take the quiz." className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base font-normal leading-6 focus-visible:outline-2 focus-visible:outline-cyan-700" /><span className="text-xs font-normal text-slate-600">Collected course material stays available across pages. Check your goal when changing pages.</span></label>
      {mode === 'independent' && !question && !busy && objective.trim() ? (resolvedIntent && resolvedIntent !== 'coordinate'
        ? <p role="status" className="text-sm font-medium text-slate-700">{independentPlans[resolvedIntent]}</p>
        : <fieldset className="space-y-2 text-sm text-slate-700"><legend className="font-semibold">What should I do with the assessment?</legend>
          {([['read', 'Read the material'], ['quiz', 'Take the quiz'], ['read-and-assess', 'Read and take the quiz']] as const).map(([value, label]) =>
            <button key={value} type="button" disabled={draftDisabled} onClick={() => {setChosenIntent(value);props.shared?.edit({chosenIntent:value});}} className="mr-2 min-h-11 rounded-md border border-slate-300 px-3 hover:bg-slate-50 disabled:opacity-50">{label}</button>)}
        </fieldset>) : null}
    </div>
    </div>
    </details>
    {replyError ? <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{replyError}</p> : null}
    {detachedQuestion ? <section className="space-y-2 border-t border-slate-200 pt-5" aria-live="polite"><h3 className="font-semibold text-slate-950">Earlier assistant question</h3><p className="text-slate-800">{detachedQuestion.question}</p><p className="text-sm text-slate-600">The page has changed. Inspect the intended course page to continue with fresh information.</p></section> : null}
    {question ? <section className="space-y-4 border-t border-slate-200 pt-5" aria-labelledby="assistant-request-title" aria-live="polite">
      <h3 id="assistant-request-title" className="text-base font-semibold text-slate-950">{openModuleRequest || !question.model ? 'Action needed in the helper browser' : 'Vitriol has a question'}</h3>
      <p className="text-sm leading-6 text-slate-600">{openModuleRequest ? 'Vitriol could not find quiz controls on this page. Learning is paused until you are ready.' : 'Learning is paused. Choose a reply below or write your own to continue.'}</p>
      <div className="rounded-md border border-cyan-200 bg-cyan-50 px-5 py-4 sm:px-6"><p className="text-base font-semibold leading-7 text-slate-950 sm:text-lg sm:leading-8">{openModuleRequest ? 'Open the quiz question or module you want to work on in the helper browser. Then return here and resume.' : question.question}</p></div>
      {question.model ? <>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
          {replies.map((option) => <button key={option} type="button" disabled={!props.ready || busy || props.active || props.paused || props.suspended} onClick={() => void start(option)} className="min-h-11 rounded-md bg-slate-950 px-4 py-3 text-left text-sm font-semibold text-white hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:opacity-40">{option}</button>)}
          {!showReplyField ? <button type="button" onClick={() => setCustomReply(true)} className="min-h-11 rounded-md px-1 text-sm font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 transition-colors hover:text-cyan-800 hover:decoration-cyan-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700">Write a different reply</button> : null}
        </div>
        {showReplyField ? <><label className="grid gap-2 text-sm font-medium text-slate-950">Your reply<textarea autoFocus={customReply} value={answer} maxLength={1400} onChange={(event) => {setAnswer(event.target.value);props.shared?.edit({answer:event.target.value});}} className="min-h-24 rounded-md border border-slate-400 bg-white p-3" /></label><p className="text-xs text-cyan-900">Replies may be shared with your AI provider. Do not include passwords or API keys.</p></> : null}
      </> : null}
    </section> : null}
    {!focused ? activityPanel : null}
    {!taskInProgress ? guidancePanel : null}
    {taskInProgress ? <details className="border-t border-slate-200 pt-3"><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-slate-600">Task options</summary>{props.sessionActions}</details> : props.sessionActions}
    {currentMemory?.history.some((turn) => conversationText(turn)) ? <details className="rounded-md border border-slate-200 bg-slate-50 p-4"><summary className="cursor-pointer text-sm font-semibold text-slate-700">Conversation remembered for this course</summary><ol className="mt-4 space-y-3">{currentMemory.history.map((turn, index) => { const text = conversationText(turn); return text ? <li key={index} className="text-sm leading-6 text-slate-700"><span className="font-semibold">{turn.role === 'user' ? 'You' : 'AI assistant'}: </span>{text}</li> : null; })}</ol></details> : null}
    {props.courseCoverage}
    </div><footer className="border-t border-slate-200 bg-slate-50 px-5 py-4 text-xs leading-5 text-slate-600 sm:px-7">Tabs update automatically when the browser is free. After 30 minutes without input on this page, Vitriol pauses the session and keeps your place. You will get a warning before it pauses.</footer>
  </section>;
}
