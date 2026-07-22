'use client';

import { useState } from 'react';
import { ArrowRight, LoaderCircle, UserPlus } from 'lucide-react';
import { authClient } from '@/lib/neon-auth/client';

export function SignInForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setMessage('');
    const result = isCreating
      ? await authClient.signUp.email({ email, password, name: 'QuizTaker Operator' })
      : await authClient.signIn.email({ email, password });
    if (result.error) {
      setMessage(result.error.message || 'Authentication failed.');
      setIsLoading(false);
      return;
    }
    window.location.assign('/');
  }

  return (
    <form className="mt-10 space-y-4" onSubmit={handleSubmit}>
      <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="email">
        Authorized email
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="h-12 w-full rounded-md border border-slate-300 bg-white px-4 text-slate-950 outline-none transition focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100"
        placeholder="you@example.com"
      />
      <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500" htmlFor="password">
        Password
      </label>
      <input
        id="password"
        type="password"
        required
        minLength={12}
        autoComplete={isCreating ? 'new-password' : 'current-password'}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="h-12 w-full rounded-md border border-slate-300 bg-white px-4 text-slate-950 outline-none transition focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100"
      />
      <button
        type="submit"
        disabled={isLoading}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-5 font-semibold text-white transition hover:bg-cyan-700 disabled:opacity-60"
      >
        {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : isCreating ? <UserPlus className="size-4" /> : <ArrowRight className="size-4" />}
        {isCreating ? 'Create operator account' : 'Sign in'}
      </button>
      <button
        type="button"
        onClick={() => {
          setIsCreating((value) => !value);
          setMessage('');
        }}
        className="w-full text-center text-sm font-semibold text-cyan-800 hover:text-cyan-950"
      >
        {isCreating ? 'Already created the operator account? Sign in' : 'First run? Create the operator account'}
      </button>
      {message ? <p className="text-sm text-slate-600" role="status">{message}</p> : null}
    </form>
  );
}
