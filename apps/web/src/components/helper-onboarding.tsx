'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Check, Clipboard, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { productName } from '@/lib/brand';

export function HelperOnboarding(props: {
  isPaired: boolean;
  helperName?: string;
  lastSeenAt?: string;
}) {
  const [code, setCode] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [isPending, startTransition] = useTransition();

  function createCode() {
    startTransition(async () => {
      const response = await fetch('/api/helper/pair', { method: 'POST' });
      const value = await response.json() as { code?: string; expiresAt?: string };
      if (response.ok) {
        setCode(value.code || '');
        setExpiresAt(value.expiresAt || '');
      }
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Step number="01" title="Download">
        <p className="text-sm leading-6 text-slate-600">Download the browser-friendly ZIP, extract it, and run the MSI inside.</p>
        <Link href="/download" className="mt-5 inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700">
          <Download className="size-4" />
          Get Windows helper
        </Link>
      </Step>
      <Step number="02" title="Start helper">
        <p className="text-sm leading-6 text-slate-600">Open {productName} Helper from the Start menu. Chrome remains local and interactive.</p>
        <div className="mt-5 rounded-md bg-slate-100 p-3 font-mono text-xs text-slate-700">Start QuizTaker Helper.cmd</div>
      </Step>
      <Step number="03" title="Pair this device">
        {props.isPaired ? (
          <div className="mt-1 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4">
            <Check className="mt-0.5 size-4 text-emerald-700" />
            <div>
              <p className="text-sm font-semibold text-emerald-900">{props.helperName} paired</p>
              <p className="mt-1 text-xs text-emerald-700">Last seen {formatDate(props.lastSeenAt)}</p>
            </div>
          </div>
        ) : code ? (
          <div className="mt-1">
            <p className="text-xs text-slate-500">Enter this one-time code in the helper:</p>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(code)}
              className="mt-3 flex w-full items-center justify-between rounded-md border border-cyan-300 bg-cyan-50 px-4 py-4 font-mono text-xl font-bold tracking-[0.2em] text-cyan-950"
            >
              {code}
              <Clipboard className="size-4" />
            </button>
            <p className="mt-2 text-xs text-slate-500">Expires {formatDate(expiresAt)}</p>
          </div>
        ) : (
          <>
            <p className="text-sm leading-6 text-slate-600">Generate a short-lived code after the helper is running.</p>
            <button
              type="button"
              onClick={createCode}
              disabled={isPending}
              className="mt-5 inline-flex items-center gap-2 rounded-md bg-cyan-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-800"
            >
              {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Generate code
            </button>
          </>
        )}
      </Step>
    </div>
  );
}

function Step(props: { number: string; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-300 bg-white p-6 shadow-[0_12px_35px_rgba(15,23,42,.05)]">
      <span className="font-mono text-xs font-bold tracking-wider text-cyan-700">{props.number}</span>
      <h2 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">{props.title}</h2>
      <div className="mt-4">{props.children}</div>
    </section>
  );
}

function formatDate(value?: string): string {
  if (!value) return 'never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
