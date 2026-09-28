'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, LoaderCircle, Play, X } from 'lucide-react';
import { Panel } from '@/components/page-frame';

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
    tabs: TabRow[];
    roster: { certTitle?: string; courses?: CourseRow[]; activities?: CourseRow[] } | null;
    detection: DetectionSnapshot | null;
  } | null;
  recentUrls?: Array<{ url: string; title: string; seen_count: number }>;
  captures?: Array<{ id: string; title: string; fingerprint: string | null }>;
  activeJob?: { id: string; status: string; capability_id?: string; outcome?: { status?: string }; diagnosis?: Diagnosis | null; output_url?: string } | null;
  parityEnabled?: boolean;
}

interface Diagnosis {
  title?: string;
  likelyCause?: { label?: string; explanation?: string; recommendation?: string; confidence?: number };
  affectedTargets?: Array<{ title?: string; diagnosis?: string }>;
}

interface PlanResponse {
  planId: string;
  label: string;
  risk: string;
  verifier: string;
  steps: string[];
  evidence: string[];
  targets: Array<{ title: string }>;
}

export function OperationsClient(props: { helperId: string }) {
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string>('');
  const [selectedTitles, setSelectedTitles] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [pendingPlan, setPendingPlan] = useState<PlanResponse | null>(null);
  const [output, setOutput] = useState('');
  const [job, setJob] = useState<ContextResponse['activeJob']>(null);
  const [busy, setBusy] = useState(false);
  const [forceCloseOffer, setForceCloseOffer] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/operations/context', { cache: 'no-store' });
    if (!response.ok) return;
    const value = await response.json() as ContextResponse;
    setContext(value);
    setJob(value.activeJob && ['queued', 'dispatched', 'running'].includes(value.activeJob.status) ? value.activeJob : value.activeJob ?? null);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void load().catch(() => undefined), 3000);
    const kick = window.setTimeout(() => void load().catch(() => undefined), 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(kick);
    };
  }, [load]);

  useEffect(() => {
    if (!job || !['queued', 'dispatched', 'running'].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/jobs/${job.id}`, { cache: 'no-store' });
      if (!response.ok) return;
      const value = await response.json() as {
        job: NonNullable<ContextResponse['activeJob']>;
        events: Array<{ data: { text?: string } }>;
      };
      setJob(value.job);
      setOutput(value.events.map((event) => event.data?.text ?? '').join(''));
      if (!['queued', 'dispatched', 'running'].includes(value.job.status)) void load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job, load]);

  const session = context?.session;
  const selected = session?.tabs?.find((tab) => tab.targetId === selectedTarget) ?? null;
  const protocolReady = (context?.helper?.protocol_version ?? 1) >= 2;
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
    setBusy(true);
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
      const value = await response.json() as { error?: string; plan?: PlanResponse; jobId?: string };
      if (!response.ok) return setError(value.error || 'Could not queue the action');
      if (value.jobId) {
        setPendingPlan(null);
        setJob({ id: value.jobId, status: 'queued' });
        setOutput('');
        return;
      }
      if (value.plan) setPendingPlan(value.plan);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPlan() {
    if (!pendingPlan) return;
    setBusy(true);
    try {
      const confirmation = await fetch(`/api/plans/${pendingPlan.planId}/confirm`, { method: 'POST' });
      if (!confirmation.ok) return setError('The plan could not be confirmed.');
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: pendingPlan.planId }),
      });
      const value = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !value.jobId) return setError(value.error || 'The job could not be queued.');
      setPendingPlan(null);
      setJob({ id: value.jobId, status: 'queued' });
      setOutput('');
    } finally {
      setBusy(false);
    }
  }

  async function dismissPlan() {
    if (pendingPlan) await fetch(`/api/plans/${pendingPlan.planId}/cancel`, { method: 'POST' });
    setPendingPlan(null);
  }

  async function endSession(forceClose: boolean) {
    setBusy(true);
    const response = await fetch('/api/operations/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'end-session', helperId: props.helperId, idempotencyKey: crypto.randomUUID(), forceClose }),
    });
    const value = await response.json() as { error?: string; status?: string };
    if (!response.ok) {
      setForceCloseOffer(/course run is still active/i.test(value.error || ''));
      setError(value.error || 'Could not end the session');
    } else {
      setForceCloseOffer(false);
      setError(value.status === 'close_failed' ? 'The session was recorded, but the browser close did not queue.' : value.status === 'ending' ? 'Browser close is queued. The session ends when that job finishes.' : '');
    }
    setBusy(false);
    await load();
  }

  const active = job && ['queued', 'dispatched', 'running'].includes(job.status);

  return (
    <div className="space-y-6">
      {error ? <div className="flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><AlertTriangle className="size-4" />{error}</div> : null}
      {!protocolReady ? <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">The paired helper needs the parity update before detection, tab targeting, class runs, SlickQuiz, and URL controls can run. Existing course cards still queue.</p> : null}
      <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
        <Panel title="Open tabs" meta={<button className="text-xs font-semibold text-cyan-800" disabled={busy || Boolean(active)} onClick={() => run('list-tabs', { capabilityId: 'list-tabs' }, true)}>Refresh</button>}>
          <div className="max-h-80 space-y-2 overflow-auto p-4">
            <p className="text-xs text-slate-500">CDP {session?.cdp_connected ? 'connected' : 'offline'} · revision {session?.revision ?? 'none'}</p>
            {(session?.tabs ?? []).map((tab) => (
              <button key={tab.targetId} type="button" onClick={() => setSelectedTarget(tab.targetId)} className={`block w-full rounded-md border px-3 py-2 text-left ${selectedTarget === tab.targetId ? 'border-cyan-600 bg-cyan-50' : 'border-slate-200'}`}>
                <span className="block font-medium text-slate-950">{tab.title || 'Untitled tab'}</span>
                <span className="block truncate text-xs text-slate-500">{tab.url}</span>
              </button>
            ))}
            {!session?.tabs?.length ? <p className="text-sm text-slate-500">No tab snapshot yet. Refresh after the helper and Chrome are running.</p> : null}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-slate-200 p-4">
            <Action disabled={!protocolReady || !targetInput || busy || Boolean(active)} onClick={() => targetInput && run('fit-tab', { capabilityId: 'fit-tab', target: targetInput }, false)}>Fit tab</Action>
            <Action disabled={!protocolReady || !targetInput || busy || Boolean(active)} onClick={() => targetInput && run('tab-inspect', { capabilityId: 'tab-inspect', target: targetInput }, true)}>Inspect</Action>
            <Action disabled={!targetInput || busy || Boolean(active)} onClick={() => targetInput && run('learn-capture', { capabilityId: 'learn-capture', target: targetInput }, true)}>Capture</Action>
            <Action disabled={busy || Boolean(active)} onClick={() => run('cdp-check', { capabilityId: 'cdp-check' }, true)}>Check CDP</Action>
            <Action disabled={busy || Boolean(active)} onClick={() => run('start-browser', { capabilityId: 'start-browser' }, false)}>Start browser</Action>
            <Action disabled={!protocolReady || busy || Boolean(active)} onClick={() => run('close-browser', { capabilityId: 'close-browser' }, false)}>Close browser</Action>
          </div>
        </Panel>
        <Panel title="Launch URL">
          <form className="space-y-3 p-4" onSubmit={(event) => {
            event.preventDefault();
            void run('open-url', { capabilityId: 'open-url', url }, false);
          }}>
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" className="h-11 w-full rounded-md border border-slate-300 px-3" />
            <Action disabled={!protocolReady || busy || Boolean(active)}>Open URL</Action>
            <div className="max-h-48 space-y-2 overflow-auto">
              {(context?.recentUrls ?? []).map((item) => (
                <div key={item.url} className="flex items-center justify-between gap-3 text-sm">
                  <button type="button" className="truncate text-left text-cyan-800" onClick={() => { setUrl(item.url); void run('open-url', { capabilityId: 'open-url', url: item.url }, false); }}>{item.title || item.url}</button>
                  <button type="button" className="text-xs text-slate-500" onClick={() => fetch('/api/operations/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'forget-url', helperId: props.helperId, url: item.url }) }).then(() => load())}>Forget</button>
                </div>
              ))}
            </div>
          </form>
        </Panel>
      </div>

      <Panel title={session?.roster?.certTitle || 'Current certification'} meta={<button className="text-xs font-semibold text-cyan-800" disabled={busy || Boolean(active)} onClick={() => run('cert-status', { capabilityId: 'cert-status', ...(targetInput ? { target: targetInput } : {}) }, true)}>Read roster</button>}>
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
            <Action disabled={!selectedTitles.length || busy || Boolean(active)} onClick={() => run('cert-batch', { capabilityId: 'cert-batch', titles: selectedTitles }, false)}>Complete selected</Action>
            <Action disabled={busy || Boolean(active)} onClick={() => run('cert-dry-run', { capabilityId: 'cert-dry-run' }, true)}>Dry-run</Action>
            <Action disabled={!protocolReady || !selected || !activityItems.some((item) => selectedTitles.includes(item.title) && !item.isBlocked) || busy || Boolean(active)} onClick={() => targetInput && run('class-batch', { capabilityId: 'class-batch', target: targetInput, titles: selectedTitles.filter((title) => activityItems.some((item) => item.title === title && !item.isBlocked)) }, false)}>Complete class activities</Action>
          </div>
        </div>
      </Panel>

      <Panel title="Auto-detect" meta={<button className="text-xs font-semibold text-cyan-800" disabled={!protocolReady || busy || Boolean(active)} onClick={() => run('detect', { capabilityId: 'detect', ...(targetInput ? { target: targetInput } : {}) }, true)}>Detect</button>}>
        <DetectionPanel detection={session?.detection} targetInput={targetInput} disabled={!protocolReady || busy || Boolean(active)} onRun={run} />
      </Panel>
      {(context?.captures ?? []).length ? (
        <Panel title="Recent captures">
          <div className="space-y-2 p-4 text-sm">
            {context?.captures?.map((capture) => <p key={capture.id}>{capture.title} · {capture.fingerprint || 'no fingerprint'}</p>)}
          </div>
        </Panel>
      ) : null}

      <div className="flex justify-end">
        <button className="rounded-md border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700" disabled={busy} onClick={() => endSession(false)}>End session</button>
        {forceCloseOffer ? <button className="rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white" disabled={busy} onClick={() => endSession(true)}>Force close</button> : null}
      </div>

      {job ? (
        <section className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-slate-200">
          <header className="flex items-center justify-between px-5 py-3">
            <span className="text-sm font-semibold">Job {job.id.slice(0, 8)} · {job.status}</span>
            {active ? <button className="text-xs font-semibold" onClick={() => fetch(`/api/jobs/${job.id}`, { method: 'DELETE' })}>Cancel</button> : null}
          </header>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-5 font-mono text-xs text-slate-400">{output || 'Waiting for helper output…'}</pre>
          {job.diagnosis ? <DiagnosisPanel diagnosis={job.diagnosis} /> : null}
        </section>
      ) : null}

      {pendingPlan ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4">
          <div className="w-full max-w-xl rounded-lg bg-white p-6">
            <div className="flex items-start justify-between">
              <h2 className="text-xl font-semibold">{pendingPlan.label}</h2>
              <button onClick={() => void dismissPlan()}><X className="size-4" /></button>
            </div>
            <p className="mt-3 text-sm text-slate-600">Risk {pendingPlan.risk} · {pendingPlan.verifier}</p>
            <p className="mt-2 text-sm">{pendingPlan.steps.join(' → ') || 'execute'}</p>
            <ul className="mt-3 list-disc pl-5 text-sm text-slate-600">{(pendingPlan.targets.length ? pendingPlan.targets : [{ title: 'Current browser context' }]).map((target) => <li key={target.title}>{target.title}</li>)}</ul>
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-md border px-4 py-2 text-sm" onClick={() => void dismissPlan()}>Cancel</button>
              <button className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white" onClick={() => void confirmPlan()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : 'Confirm and queue'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DetectionPanel(props: {
  detection?: DetectionSnapshot | null;
  targetInput?: Record<string, unknown>;
  disabled: boolean;
  onRun: (capabilityId: string, input: Record<string, unknown>, confirm: boolean) => Promise<void>;
}) {
  const detected = props.detection?.detected;
  const manualOnly = detected === 'server-assessment';
  const actionFor: Record<string, string> = {
    scorm: 'scorm-complete',
    container: 'container-batch',
    slickquiz: 'slickquiz-solve',
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
    </div>
  );
}

function Action(props: { children: ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button type="submit" disabled={props.disabled} onClick={props.onClick} className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
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
