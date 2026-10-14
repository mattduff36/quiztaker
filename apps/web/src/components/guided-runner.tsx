'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, Square } from 'lucide-react';
import { decideGuidedFlow, learnerQuestion, sameDetectedTarget, supportsGuidedLearning, uniqueQuestionTab, type GuidedDetection } from '@/lib/guided-flow';
import { readJsonResponse } from '@/lib/operations-readiness';

type Tab = { targetId: string; index: number; title: string; url: string; fingerprint: string };
type Session = { id: string; revision: number; tabs: Tab[]; cdp_connected: boolean };
type Context = { helper: { id: string; is_online: boolean; version: string } | null; session?: Session | null; learnerEnabled?: boolean; activeJob?: { id: string; status: string } | null };
type Job = { id: string; status: string; outcome?: { verified?: boolean; status?: string }; result?: { ok?: boolean; result?: { detection?: GuidedDetection } } };
type Question = { question: string; options?: string[]; next?: string; model?: boolean; targetId?: string; sessionId?: string; url?: string };
const running = (status: string) => ['queued', 'dispatched', 'running'].includes(status);

export function GuidedRunner(props: {
  helperId: string;
  session?: Session | null;
  selectedTarget: string;
  onSelect: (id: string) => void;
  ready: boolean;
  active: boolean;
  onBusy: (value: boolean) => void;
  onRefresh: () => Promise<void>;
  lastJob?: { id: string; status: string; capability_id?: string; input?: { target?: { targetId?: string; browserSessionId?: string; fingerprint?: string } } } | null;
  outputJobId?: string;
  lastOutput: string;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('Ready when you are');
  const [message, setMessage] = useState('Choose the course tab. Vitriol will inspect it and decide how to proceed.');
  const [currentQuestion, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState('');
  const [customReply, setCustomReply] = useState(false);
  const [settingsNeeded, setSettingsNeeded] = useState(false);
  const locked = useRef(false);
  const stopped = useRef(false);
  const mounted = useRef(true);
  const ownedJob = useRef<string | null>(null);
  const session = props.session;
  const selected = session?.tabs.find((tab) => tab.targetId === props.selectedTarget);
  const savedTarget = props.lastJob?.input?.target;
  const restoredQuestion = !busy && props.lastJob?.id === props.outputJobId && props.lastJob?.capability_id === 'quiz-learn' && !running(props.lastJob.status)
    && savedTarget?.browserSessionId === session?.id ? learnerQuestion(props.lastOutput) : null;
  const currentPauseTab = uniqueQuestionTab(currentQuestion?.url, session?.tabs || []);
  const restoredPauseTab = uniqueQuestionTab(restoredQuestion?.url, session?.tabs || []);
  const question: Question | null = (currentQuestion && currentPauseTab && currentQuestion.sessionId === session?.id
    && (currentQuestion.targetId === props.selectedTarget || currentPauseTab.targetId === props.selectedTarget) ? currentQuestion : null)
    || (restoredQuestion && restoredPauseTab && (savedTarget?.targetId === props.selectedTarget || restoredPauseTab.targetId === props.selectedTarget)
      ? { ...restoredQuestion, model: true, targetId: restoredPauseTab.targetId, sessionId: session?.id } : null);
  const openModuleRequest = question?.question === 'Open the intended question or module, then resume.';
  const replies = openModuleRequest ? ['Done, resume now'] : [...new Set(question?.options || [])].filter((option) => option.trim());
  const showReplyField = Boolean(question?.model && (customReply || replies.length === 0));
  const pauseTab = uniqueQuestionTab(question?.url, session?.tabs || []);
  const pauseTargetId = pauseTab?.targetId;
  const { selectedTarget, onSelect } = props;
  useEffect(() => {
    if (!busy && pauseTargetId && pauseTargetId !== selectedTarget) onSelect(pauseTargetId);
  }, [busy, pauseTargetId, selectedTarget, onSelect]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopped.current = true; }; }, []);

  async function api<T>(url: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(url, { method: method || (body ? 'POST' : 'GET'), cache: 'no-store', signal: AbortSignal.timeout(20_000), ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return readJsonResponse<T>(response, 'The request did not complete. Check the connection and try again.');
  }

  function checkStopped() { if (stopped.current || !mounted.current) throw new Error('Stopped. Inspect again when you are ready.'); }

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
    const planned = await api<{ plan?: { planId: string }; jobId?: string }>('/api/operations/actions', {
      action: 'plan', helperId: props.helperId, capabilityId,
      capabilityInput: { capabilityId, ...(target ? { target } : {}), ...(guidance ? { guidance } : {}) },
      confirm: true, source: 'auto-detect',
    });
    let jobId = planned.jobId;
    if (!jobId) {
      checkStopped();
      if (!planned.plan) throw new Error('No plan was returned. Inspect the page again.');
      await api(`/api/plans/${planned.plan.planId}/confirm`, {}, 'POST');
      checkStopped();
      jobId = (await api<{ jobId: string }>('/api/jobs', { planId: planned.plan.planId })).jobId;
    }
    ownedJob.current = jobId;
    // A stop can arrive while the queue request is in flight. Cancel that exact job.
    if (stopped.current || !mounted.current) { await api(`/api/jobs/${jobId}`, undefined, 'DELETE'); checkStopped(); }
    return jobId;
  }

  async function waitForJob(id: string): Promise<{ job: Job; output: string }> {
    for (let count = 0; count < 450; count += 1) {
      checkStopped();
      const value = await api<{ job: Job; events: Array<{ data?: { text?: string } }> }>(`/api/jobs/${id}`);
      checkStopped();
      if (!running(value.job.status)) { ownedJob.current = null; return { job: value.job, output: value.events.map((event) => event.data?.text || '').join('') }; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('This run is taking longer than expected. Check its status in Advanced tools before starting another.');
  }

  async function start(quickReply?: string) {
    if (locked.current || !(pauseTab || selected) || !props.ready || props.active) return;
    locked.current = true; stopped.current = false;
    setBusy(true); props.onBusy(true); setSettingsNeeded(false);
    const reply = quickReply ?? answer.trim();
    const guidance = question?.model && !(openModuleRequest && quickReply === 'Done, resume now') && reply ? `Previous question: ${question.question}\nUser answer: ${reply}`.slice(0, 2000) : undefined;
    setQuestion(null); setAnswer(''); setCustomReply(false);
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
      const decision = decideGuidedFlow(detection);
      if (decision.kind === 'question') { setStage('Your input is needed'); setMessage(detection.detail || 'I need your help before continuing.'); setQuestion({ ...decision, targetId, sessionId: fresh.context.session!.id, url: fresh.tab.url }); return; }
      setMessage(decision.message);
      const capability = decision.kind === 'run' ? decision.capability : 'quiz-learn';
      if (decision.kind === 'learn') {
        if (!supportsGuidedLearning(fresh.context.helper!.version)) throw new Error('Update the helper to v1.0.8 or later below, then inspect again. This update fixes page capture and enables learning questions.');
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
        setStage('Completion verified'); setMessage('The run reported verified completion. Its evidence is available in History and Advanced tools.');
      } else {
        setStage('The run needs attention');
        const providerProblem = /provider|learner.*(?:request|key|connection)|api key|quota|rate limit/i.test(result.output);
        setSettingsNeeded(providerProblem);
        setMessage(providerProblem ? 'The AI connection did not complete a request. Test your provider in Settings, then try again.' : 'The run stopped without verified completion. You can inspect again after opening the intended question or resolving the issue shown in Advanced tools.');
      }
    } catch (error) {
      if (mounted.current) { setStage(stopped.current ? 'Stopped' : 'Your input is needed'); setMessage(error instanceof Error ? error.message : 'The run could not continue. Inspect again.'); }
    } finally {
      locked.current = false;
      if (mounted.current) { setBusy(false); props.onBusy(false); void props.onRefresh(); }
    }
  }

  async function stop() {
    stopped.current = true;
    setStage('Stopping'); setMessage('No further steps will be queued. Waiting for the helper to stop the current job.');
    if (ownedJob.current) {
      try { await api(`/api/jobs/${ownedJob.current}`, undefined, 'DELETE'); }
      catch { setMessage('The stop request could not be confirmed. Use Cancel in Advanced tools or stop the helper.'); }
    }
  }

  return <section className="space-y-5 rounded-lg border border-slate-300 bg-white p-5 sm:p-6" aria-labelledby="guided-title">
    <div><h2 id="guided-title" className="text-xl font-semibold text-slate-950">Work on a course</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">One action: inspect the page, use a recognised strategy, or start learning its controls with your AI provider.</p></div>
    <label className="grid gap-2 text-sm font-semibold text-slate-800">Course tab
      <select value={props.selectedTarget} disabled={busy || props.active} onChange={(event) => { props.onSelect(event.target.value); setQuestion(null); setAnswer(''); setCustomReply(false); setStage('Ready when you are'); setMessage('Inspect this tab to choose the next step.'); }} className="min-h-11 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 font-normal">
        <option value="">Choose the tab to inspect</option>{(session?.tabs || []).map((tab) => <option key={tab.targetId} value={tab.targetId}>{tab.title || tab.url}</option>)}
      </select>
    </label>
    {!question ? <div role="status" aria-live="polite"><p className="font-semibold text-slate-950">{stage}</p><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{message}</p></div> : null}
    {question ? <section className="space-y-4 border-y border-cyan-200 bg-cyan-50 px-4 py-5 sm:px-5" aria-labelledby="assistant-request-title">
      <h3 id="assistant-request-title" className="text-lg font-semibold text-cyan-950">{openModuleRequest || !question.model ? 'Action needed in the helper browser' : 'Your AI assistant has a question'}</h3>
      <p className="max-w-2xl text-base font-medium leading-7 text-slate-950">{openModuleRequest ? 'Open the quiz question or module you want to work on in the helper browser. Then return here and resume.' : question.question}</p>
      <p className="text-sm leading-6 text-cyan-900">{openModuleRequest ? 'Vitriol could not find quiz controls on this page. Learning is paused until you are ready.' : 'Learning is paused. Choose a reply below or write your own to continue.'}</p>
      {question.model ? <>
        {replies.length ? <div className="space-y-2"><p className="text-sm font-semibold text-cyan-950">{openModuleRequest ? 'When you are ready' : 'Suggested replies — click to send and continue'}</p><div className="flex flex-wrap gap-3">{replies.map((option) => <button key={option} type="button" disabled={!props.ready || busy || props.active} onClick={() => void start(option)} className="min-h-11 rounded-md bg-slate-950 px-4 py-3 text-left text-sm font-semibold text-white hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:opacity-40">{option}</button>)}</div></div> : null}
        {!showReplyField ? <button type="button" onClick={() => setCustomReply(true)} className="min-h-11 text-sm font-semibold text-cyan-900 underline underline-offset-4">Write a different reply</button> : null}
        {showReplyField ? <><label className="grid gap-2 text-sm font-medium text-slate-950">Your reply<textarea autoFocus={customReply} value={answer} maxLength={1400} onChange={(event) => setAnswer(event.target.value)} className="min-h-24 rounded-md border border-slate-400 bg-white p-3" /></label><p className="text-xs text-cyan-900">Replies may be shared with your AI provider. Do not include passwords or API keys.</p></> : null}
      </> : null}
    </section> : null}
    <div className="flex flex-wrap items-center gap-3">
      {(!question?.model || showReplyField || busy) ? <button type="button" onClick={() => void start()} disabled={!props.ready || !(pauseTab || selected) || busy || props.active || Boolean(question?.model && !answer.trim())} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}{busy ? 'Working…' : question?.model ? 'Send answer and continue' : question?.next || 'Inspect and start'}</button> : null}
      {busy ? <button type="button" onClick={() => void stop()} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-semibold"><Square className="size-4" />Stop</button> : null}
      {settingsNeeded ? <a href="/settings" className="font-semibold text-cyan-800 underline">Connect or test AI in Settings</a> : null}
    </div>
    <p className="max-w-2xl text-xs leading-5 text-slate-600">Starting authorises the supported strategy for this tab. Learning can read page text, select answers and navigate, but will not submit a final assessment. Keep this page open; leaving it stops automatic follow-up steps. Any current helper job remains visible in Advanced tools.</p>
  </section>;
}
