'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, useTransition } from 'react';
import { AlertTriangle, Check, LoaderCircle, Play, Terminal, X } from 'lucide-react';
import type { Capability, PlanProposal } from '@quiztaker/core';

interface JobState {
  id: string;
  status: string;
  outcome?: { status?: string; verified?: boolean };
}

export function OperationsClient(props: {
  helperId: string;
  capabilities: Capability[];
  initialJob: JobState | null;
}) {
  const [pendingPlan, setPendingPlan] = useState<PlanProposal | null>(null);
  const [activeJob, setActiveJob] = useState<JobState | null>(props.initialJob);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!activeJob || !['queued', 'dispatched', 'running'].includes(activeJob.status)) return;
    let isCancelled = false;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/jobs/${activeJob.id}`, { cache: 'no-store' });
      if (!response.ok || isCancelled) return;
      const value = await response.json() as {
        job: JobState;
        events: Array<{ event: string; data: { text?: string } }>;
      };
      setActiveJob({ ...value.job, id: String((value.job as JobState & { id?: string }).id || activeJob.id) });
      setOutput(value.events.map((event) => event.data?.text ?? '').join(''));
    }, 2_000);
    return () => {
      isCancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJob]);

  function requestPlan(capability: Capability) {
    startTransition(async () => {
      setError('');
      const response = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          helperId: props.helperId,
          capabilityId: capability.id,
          steps: capability.mutatesCourse ? ['probe', 'launch', 'verify'] : ['probe'],
          evidence: ['Requested from the authenticated control plane.'],
        }),
      });
      const value = await response.json();
      if (!response.ok) return setError(value.error || 'Could not create plan');
      if (capability.mutatesCourse) setPendingPlan(value as PlanProposal);
      else await launchJob(value as PlanProposal, false);
    });
  }

  async function launchJob(plan: PlanProposal, shouldConfirm: boolean) {
    setError('');
    if (shouldConfirm) {
      const confirmation = await fetch(`/api/plans/${plan.planId}/confirm`, { method: 'POST' });
      if (!confirmation.ok) return setError('The plan could not be confirmed.');
    }
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: plan.planId }),
    });
    const value = await response.json() as { jobId?: string; error?: string };
    if (!response.ok || !value.jobId) return setError(value.error || 'The job could not be queued.');
    setPendingPlan(null);
    setOutput('');
    setActiveJob({ id: value.jobId, status: 'queued' });
  }

  async function cancelJob() {
    if (!activeJob) return;
    await fetch(`/api/jobs/${activeJob.id}`, { method: 'DELETE' });
  }

  const isActive = activeJob && ['queued', 'dispatched', 'running'].includes(activeJob.status);
  return (
    <>
      {error ? (
        <div className="mb-5 flex items-center gap-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <AlertTriangle className="size-4" />
          {error}
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {props.capabilities.filter((item) => item.card).map((capability) => (
          <button
            key={capability.id}
            type="button"
            disabled={isPending || Boolean(isActive)}
            onClick={() => requestPlan(capability)}
            className="group min-h-40 rounded-lg border border-slate-300 bg-white p-5 text-left shadow-[0_10px_30px_rgba(15,23,42,.04)] transition hover:-translate-y-0.5 hover:border-cyan-500 hover:shadow-[0_18px_45px_rgba(8,145,178,.12)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="flex items-start justify-between">
              <span className="grid size-9 place-items-center rounded-md bg-slate-950 text-cyan-300">
                {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
              </span>
              <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
                capability.risk === 'none' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
              }`}>{capability.risk} risk</span>
            </div>
            <h3 className="mt-5 font-semibold tracking-tight text-slate-950">{capability.label}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{capability.description}</p>
          </button>
        ))}
      </div>

      {activeJob ? (
        <section className="mt-6 overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-slate-200">
          <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="size-4 text-cyan-400" />
              Job {activeJob.id.slice(0, 8)}
              <span className="font-mono text-[10px] uppercase tracking-wider text-cyan-300">{activeJob.status}</span>
            </div>
            {isActive ? (
              <button onClick={cancelJob} className="text-xs font-semibold text-slate-400 hover:text-white">Cancel</button>
            ) : activeJob.outcome?.verified ? <Check className="size-4 text-emerald-400" /> : null}
          </header>
          <pre className="max-h-80 min-h-32 overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-6 text-slate-400">
            {output || (isActive ? 'Waiting for helper output…' : activeJob.outcome?.status || 'Job finished.')}
          </pre>
        </section>
      ) : null}

      <Dialog.Root open={Boolean(pendingPlan)} onOpenChange={(open) => !open && setPendingPlan(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-slate-300 bg-white shadow-2xl">
            <div className="border-b border-slate-200 p-6">
              <div className="flex items-start justify-between gap-6">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-700">Explicit confirmation required</p>
                  <Dialog.Title className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{pendingPlan?.label}</Dialog.Title>
                </div>
                <Dialog.Close className="rounded-md p-2 hover:bg-slate-100"><X className="size-4" /></Dialog.Close>
              </div>
            </div>
            <div className="space-y-5 p-6 text-sm">
              <PlanRow label="Risk" value={pendingPlan?.risk || ''} />
              <PlanRow label="Confidence" value={`${Math.round((pendingPlan?.confidence || 0) * 100)}%`} />
              <PlanRow label="Verifier" value={pendingPlan?.verifier || ''} />
              <PlanRow label="Steps" value={pendingPlan?.steps.join(' → ') || 'execute → verify'} />
              <div>
                <p className="font-semibold text-slate-950">Evidence</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
                  {(pendingPlan?.evidence.length ? pendingPlan.evidence : ['Current authenticated helper context.']).map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 p-5">
              <Dialog.Close className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold">Cancel</Dialog.Close>
              <button
                onClick={() => pendingPlan && launchJob(pendingPlan, true)}
                className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
              >
                Confirm and queue
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function PlanRow(props: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-4 border-b border-slate-100 pb-3">
      <span className="text-slate-500">{props.label}</span>
      <span className="font-mono text-xs text-slate-900">{props.value}</span>
    </div>
  );
}
