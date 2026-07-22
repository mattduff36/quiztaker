'use client';

import { useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';

export function SignInForm() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setMessage('');
    const response = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const value = await response.json() as { error?: string };
    setMessage(response.ok ? 'Check your inbox for the secure sign-in link.' : value.error || 'Could not send sign-in link.');
    setIsLoading(false);
  }

  return (
    <form className="mt-10 space-y-4" onSubmit={handleSubmit}>
      <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="email">
        Authorized email
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-12 flex-1 rounded-md border border-slate-300 bg-white px-4 text-slate-950 outline-none transition focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100"
          placeholder="you@example.com"
        />
        <button
          type="submit"
          disabled={isLoading}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-slate-950 px-5 font-semibold text-white transition hover:bg-cyan-700 disabled:opacity-60"
        >
          {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
          Send link
        </button>
      </div>
      {message ? <p className="text-sm text-slate-600" role="status">{message}</p> : null}
    </form>
  );
}
