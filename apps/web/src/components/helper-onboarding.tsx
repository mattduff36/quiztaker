'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Clipboard, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { productName } from '@/lib/brand';

interface PairingDetails {
  code: string;
  expiresAt: string;
  controlPlaneUrl: string;
}

interface HelperConnection {
  state: 'not-paired' | 'online' | 'offline';
  helperName?: string;
  lastSeenAt?: string;
  activity?: string;
}

interface HelperOnboardingProps {
  connection: HelperConnection;
}

const connectionStyles = {
  'not-paired': {
    shell: 'border-slate-300 bg-white',
    dot: 'bg-slate-400',
    badge: 'bg-slate-100 text-slate-600',
  },
  online: {
    shell: 'border-emerald-300 bg-emerald-950 text-white',
    dot: 'bg-emerald-400',
    badge: 'bg-emerald-400/15 text-emerald-200',
  },
  offline: {
    shell: 'border-amber-300 bg-amber-50',
    dot: 'bg-amber-500',
    badge: 'bg-amber-100 text-amber-800',
  },
} as const;

export function HelperOnboarding({ connection }: HelperOnboardingProps) {
  const router = useRouter();
  const [pairing, setPairing] = useState<PairingDetails | null>(null);
  const [copiedItem, setCopiedItem] = useState<'code' | 'command' | null>(null);
  const [isCreatingCode, startCreatingCode] = useTransition();
  const [, startStatusRefresh] = useTransition();
  const copyTimer = useRef<number | null>(null);
  const isPaired = connection.state !== 'not-paired';
  const shouldRefresh = pairing !== null || isPaired;
  const startCommand = pairing
    ? `& "$env:LOCALAPPDATA\\Programs\\Vitriol Helper\\Start Vitriol Helper.cmd" --pair --control-plane-url="${pairing.controlPlaneUrl}"`
    : '';

  useEffect(() => {
    if (!shouldRefresh) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      startStatusRefresh(() => router.refresh());
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [router, shouldRefresh]);

  function createCode() {
    startCreatingCode(async () => {
      const response = await fetch('/api/helper/pair', { method: 'POST' });
      const value = await response.json() as Partial<PairingDetails>;
      if (response.ok && value.code && value.expiresAt && value.controlPlaneUrl) {
        setPairing({
          code: value.code,
          expiresAt: value.expiresAt,
          controlPlaneUrl: value.controlPlaneUrl,
        });
      }
    });
  }

  async function copyText(value: string, item: 'code' | 'command') {
    await navigator.clipboard.writeText(value);
    setCopiedItem(item);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedItem(null), 1_600);
  }

  return (
    <>
      <ConnectionStatus connection={connection} />
      <div className="grid gap-5 lg:grid-cols-3">
        <Step number="01" title="Download">
          <p className="text-sm leading-6 text-slate-600">Download the browser-friendly ZIP, extract it, and run the MSI inside.</p>
          <div className="mt-auto pt-5">
            <Link href="/download" className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700">
              <Download className="size-4" />
              Get Windows helper
            </Link>
          </div>
        </Step>
        <Step number="02" title="Create pairing code">
          {isPaired ? (
            <div className="mt-1 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4">
              <Check className="mt-0.5 size-4 text-emerald-700" />
              <div>
                <p className="text-sm font-semibold text-emerald-900">{connection.helperName} paired</p>
                <p className="mt-1 text-xs text-emerald-700">Last heartbeat {formatDate(connection.lastSeenAt)}</p>
              </div>
            </div>
          ) : pairing ? (
            <div className="mt-1">
              <p className="text-xs text-slate-500">Enter this one-time code in the helper:</p>
              <button
                type="button"
                onClick={() => void copyText(pairing.code, 'code')}
                className={`mt-3 flex w-full items-center justify-between rounded-md border px-4 py-4 text-cyan-950 transition duration-200 ${
                  copiedItem === 'code'
                    ? 'scale-[1.01] border-emerald-400 bg-emerald-50 shadow-[0_0_0_3px_rgba(52,211,153,.12)]'
                    : 'border-cyan-300 bg-cyan-50'
                }`}
              >
                <span className="font-mono text-xl font-bold tracking-[0.2em]">{pairing.code}</span>
                <CopyIndicator isCopied={copiedItem === 'code'} />
              </button>
              <p className="mt-2 text-xs text-slate-500">Expires {formatDate(pairing.expiresAt)}</p>
            </div>
          ) : (
            <>
              <p className="text-sm leading-6 text-slate-600">Generate a short-lived code before starting the helper.</p>
              <div className="mt-auto pt-5">
                <button
                  type="button"
                  onClick={createCode}
                  disabled={isCreatingCode}
                  className="inline-flex items-center gap-2 rounded-md bg-cyan-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-800 disabled:opacity-60"
                >
                  {isCreatingCode ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  Generate code
                </button>
              </div>
            </>
          )}
        </Step>
        <Step number="03" title={isPaired ? 'Ready' : 'Start and pair'}>
          {connection.state === 'online' ? (
            <>
              <p className="text-sm leading-6 text-slate-600">
                The helper is online and polling securely. Its window can stay minimized while you work.
              </p>
              <Link href="/" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-cyan-800 hover:text-cyan-950">
                Continue to Operations
                <ArrowRight className="size-4" />
              </Link>
            </>
          ) : connection.state === 'offline' ? (
            <p className="text-sm leading-6 text-slate-600">
              The helper is paired but offline. Start Vitriol Helper again; it will reuse the saved pairing automatically.
            </p>
          ) : pairing ? (
            <>
              <p className="text-sm leading-6 text-slate-600">
                Run this exact PowerShell command, then enter the pairing code. It targets <span className="font-semibold text-slate-950">{pairing.controlPlaneUrl}</span>.
              </p>
              <button
                type="button"
                onClick={() => void copyText(startCommand, 'command')}
                className={`mt-5 flex w-full items-start justify-between gap-3 rounded-md border p-3 text-left font-mono text-[11px] leading-5 transition duration-200 ${
                  copiedItem === 'command'
                    ? 'scale-[1.01] border-emerald-300 bg-emerald-50 text-emerald-950'
                    : 'border-transparent bg-slate-100 text-slate-700 hover:bg-cyan-50'
                }`}
              >
                <span className="break-all">{startCommand}</span>
                <CopyIndicator isCopied={copiedItem === 'command'} />
              </button>
            </>
          ) : (
            <p className="text-sm leading-6 text-slate-600">
              Generate a code first. The launch command will automatically target this {productName} control plane.
            </p>
          )}
        </Step>
      </div>
    </>
  );
}

function ConnectionStatus({ connection }: { connection: HelperConnection }) {
  const styles = connectionStyles[connection.state];
  const isOnline = connection.state === 'online';
  const label = isOnline ? 'Online' : connection.state === 'offline' ? 'Offline' : 'Not paired';
  const title = isOnline
    ? `${connection.helperName} is connected`
    : connection.state === 'offline'
      ? `${connection.helperName} is paired but not responding`
      : 'No helper connected';
  const detail = isOnline
    ? connection.activity === 'busy'
      ? 'The helper is running a job and reporting live progress.'
      : 'Ready for jobs. Heartbeats are arriving normally.'
    : connection.state === 'offline'
      ? `Last heartbeat ${formatDate(connection.lastSeenAt)}. Start the helper to reconnect.`
      : 'Download and pair the Windows helper to enable local automation.';

  return (
    <section
      aria-live="polite"
      className={`mb-5 flex items-center justify-between gap-5 rounded-lg border px-5 py-4 shadow-[0_10px_30px_rgba(15,23,42,.05)] ${styles.shell}`}
    >
      <div className="flex min-w-0 items-center gap-4">
        <span className="relative flex size-3 shrink-0">
          {isOnline ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" /> : null}
          <span className={`relative inline-flex size-3 rounded-full ${styles.dot}`} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className={`mt-0.5 text-xs ${isOnline ? 'text-emerald-100' : 'text-slate-600'}`}>{detail}</p>
        </div>
      </div>
      <span className={`shrink-0 rounded-full px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${styles.badge}`}>
        {label}
      </span>
    </section>
  );
}

function CopyIndicator({ isCopied }: { isCopied: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider" aria-live="polite">
      {isCopied ? (
        <>
          <Check className="size-4 motion-safe:animate-pulse text-emerald-600" />
          <span className="text-emerald-700">Copied</span>
        </>
      ) : (
        <Clipboard className="size-4" />
      )}
    </span>
  );
}

function Step(props: { number: string; title: string; children: React.ReactNode }) {
  return (
    <section className="flex h-full flex-col rounded-lg border border-slate-300 bg-white p-6 shadow-[0_12px_35px_rgba(15,23,42,.05)]">
      <span className="font-mono text-xs font-bold tracking-wider text-cyan-700">{props.number}</span>
      <h2 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">{props.title}</h2>
      <div className="mt-4 flex flex-1 flex-col">{props.children}</div>
    </section>
  );
}

function formatDate(value?: string): string {
  if (!value) return 'never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
