import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { productName, productSlogan } from '@/lib/brand';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = {
  title: 'Sign in',
  description: `Sign in to ${productName}, the secure control plane for local learning automation.`,
};

export default function SignInPage() {
  return (
    <main className="grid min-h-screen bg-slate-950 lg:grid-cols-[1.1fr_0.9fr]">
      <section className="relative hidden overflow-hidden border-r border-white/10 p-14 lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(34,211,238,.16)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,.16)_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="relative flex items-center gap-3 text-sm font-semibold uppercase tracking-[0.24em] text-cyan-300">
          <span className="size-2 rounded-full bg-cyan-300 shadow-[0_0_18px_#67e8f9]" />
          {productName}
        </div>
        <div className="relative max-w-xl">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-slate-500">Secure orchestration / local execution</p>
          <h1 className="mt-6 text-6xl font-semibold leading-[0.94] tracking-[-0.06em] text-white">{productSlogan}</h1>
          <p className="mt-8 max-w-md text-lg leading-8 text-slate-400">
            {productName} coordinates plans in the cloud while browser credentials and execution stay on your Windows machine.
          </p>
        </div>
        <p className="relative font-mono text-xs text-slate-600">{productName.toUpperCase()} · PRIVATE CONTROL PLANE</p>
      </section>
      <section className="flex items-center bg-slate-100 px-6 py-16 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-lg">
          <div className="inline-flex size-12 items-center justify-center rounded-md bg-cyan-700 text-white shadow-lg shadow-cyan-900/20">
            <ShieldCheck className="size-6" />
          </div>
          <h2 className="mt-8 text-4xl font-semibold tracking-[-0.04em] text-slate-950">Sign in to {productName}</h2>
          <p className="mt-3 leading-7 text-slate-600">
            Access is restricted to the configured account and managed by Neon Auth.
          </p>
          <SignInForm />
        </div>
      </section>
    </main>
  );
}
