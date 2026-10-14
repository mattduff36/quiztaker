'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const MAX_INSTRUCTIONS = 2000;

type LearnerInstructions = {
  instructions: string;
  updatedAt: string | null;
  isDefault: boolean;
};

export function LearnerPreferences(props: { initial: LearnerInstructions }) {
  const router = useRouter();
  const [instructions, setInstructions] = useState(props.initial.instructions);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'reset' | null>(null);

  async function submit(action: 'save' | 'reset') {
    setPending(action);
    setMessage('');
    setError('');
    try {
      const response = await fetch('/api/settings/learner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'reset' ? { action } : { instructions }),
      });
      const body = await response.json().catch(() => null) as { error?: string; instructions?: string } | null;
      if (!response.ok) {
        setError(body?.error || 'Could not update learner instructions');
        return;
      }
      if (typeof body?.instructions === 'string') setInstructions(body.instructions);
      setMessage(action === 'reset' ? 'Restored the default learner instructions.' : 'Saved learner instructions.');
      router.refresh();
    } catch {
      setError('Could not update learner instructions');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="rounded-lg border border-slate-300 bg-white shadow-[0_14px_40px_rgba(15,23,42,0.06)]">
      <header className="flex min-h-14 items-center border-b border-slate-200 px-5">
        <h2 className="font-semibold tracking-tight text-slate-900">Learner instructions</h2>
      </header>
      <form
        className="grid gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit('save');
        }}
      >
        <p className="text-sm leading-6 text-slate-600">
          These are ongoing preferences for this account. The course goal, later guidance, and built-in execution limits still apply.
        </p>
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Instructions
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={MAX_INSTRUCTIONS}
            rows={8}
            disabled={pending !== null}
            className="rounded-md border border-slate-300 px-3 py-2 font-normal leading-6 disabled:opacity-50"
          />
        </label>
        <p className="text-xs text-slate-500">{instructions.trim().length}/{MAX_INSTRUCTIONS}</p>
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={pending !== null}
            className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
          >
            {pending === 'save' ? 'Saving…' : 'Save learner instructions'}
          </button>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void submit('reset')}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {pending === 'reset' ? 'Restoring…' : 'Reset to default'}
          </button>
        </div>
        {message ? <p role="status" className="text-sm text-slate-700">{message}</p> : null}
        {error ? <p role="alert" className="text-sm text-rose-700">{error}</p> : null}
      </form>
    </section>
  );
}
