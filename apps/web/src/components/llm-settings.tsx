'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type ProviderId = 'openai' | 'gemini' | 'openrouter';

type LlmStatus = {
  source: 'personal' | 'inherited' | 'disabled' | 'none';
  ready: boolean;
  provider: ProviderId | null;
  model: string | null;
  hasKey: boolean;
  testedAt?: string | null;
};

type ProviderOption = {
  id: ProviderId;
  label: string;
  setupUrl: string;
};

export function LlmSettings(props: { status: LlmStatus; providers: readonly ProviderOption[] }) {
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId>(props.status.provider ?? 'openai');
  const [model, setModel] = useState(props.status.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<'save' | 'disconnect' | null>(null);
  const keepKey = props.status.hasKey && props.status.provider === provider;
  const canDisconnect = props.status.source === 'personal' || props.status.source === 'inherited' || props.status.source === 'disabled';

  async function submit(action: 'save' | 'disconnect') {
    setPending(action);
    setMessage('');
    try {
      const response = await fetch('/api/settings/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'disconnect' ? { action } : { action, provider, model, apiKey }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        setMessage(body?.error || 'Could not update the connection');
        return;
      }
      setApiKey('');
      setMessage(action === 'disconnect' ? 'Hosted AI is disconnected for this account.' : 'Saved after a successful connection test.');
      router.refresh();
    } catch {
      setMessage('Could not update the connection');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="rounded-lg border border-slate-300 bg-white shadow-[0_14px_40px_rgba(15,23,42,0.06)]">
      <header className="flex min-h-14 items-center border-b border-slate-200 px-5">
        <h2 className="font-semibold tracking-tight text-slate-900">Hosted AI</h2>
      </header>
      <form
        className="grid gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit('save');
        }}
      >
        <p className="text-sm leading-6 text-slate-600">{statusCopy(props.status)}</p>
        <p className="text-sm leading-6 text-slate-600">
          Choose your provider, enter a model and API key, then test the connection. API access may require separate billing from a chat subscription.
        </p>
        <p className="text-sm leading-6 text-slate-600">The test sends a small example, not your course. During learning, page text and answer controls are sent to your selected provider. Your saved key is encrypted and is never shown again.</p>
        <details className="text-sm leading-6 text-slate-600"><summary className="cursor-pointer font-semibold">Using a local AI app or MCP?</summary>Local Cursor CLI, MCP clients and custom endpoints are not connected in this release. A chat subscription alone does not connect Vitriol; use one of the supported API connections below. Existing course detection and captures work without an AI connection.</details>
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Provider
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId)}
            className="h-11 rounded-md border border-slate-300 bg-white px-3 font-normal"
          >
            {props.providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Model
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            maxLength={80}
            placeholder="gpt-4o-mini"
            className="h-11 rounded-md border border-slate-300 px-3 font-normal"
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            maxLength={512}
            autoComplete="off"
            placeholder={keepKey ? 'Leave blank to keep the saved key' : 'API key'}
            className="h-11 rounded-md border border-slate-300 px-3 font-normal"
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={pending !== null}
            className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
          >
            {pending === 'save' ? 'Testing…' : 'Test and save'}
          </button>
          {canDisconnect ? (
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void submit('disconnect')}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : null}
        </div>
        {message ? <p role="status" className="text-sm text-slate-700">{message}</p> : null}
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {props.providers.map((item) => (
            <li key={item.id}>
              <a className="font-semibold text-cyan-800 underline" href={item.setupUrl} target="_blank" rel="noreferrer">
                {item.label} setup
              </a>
            </li>
          ))}
        </ul>
      </form>
    </section>
  );
}

function statusCopy(status: LlmStatus): string {
  if (status.source === 'personal' && status.ready) return `Personal connection tested successfully${status.testedAt ? ` at ${new Date(status.testedAt).toLocaleString()}` : ''}. Provider availability and credit can change.`;
  if (status.source === 'personal') return 'A personal connection is saved but is not ready.';
  if (status.source === 'disabled') return 'Hosted AI is disconnected. Deployment credentials stay unused.';
  if (status.source === 'inherited') return 'Using the site’s default AI configuration. It has not been tested by this setup flow. Test and save your own connection to replace it.';
  return 'No hosted AI connection is configured.';
}
