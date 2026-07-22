import { ShieldCheck } from 'lucide-react';
import { SignInForm } from './sign-in-form';

export default function SignInPage() {
  return (
    <main className="grid min-h-screen bg-slate-950 lg:grid-cols-[1.1fr_0.9fr]">
      <section className="relative hidden overflow-hidden border-r border-white/10 p-14 lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(34,211,238,.16)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,.16)_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="relative flex items-center gap-3 text-sm font-semibold uppercase tracking-[0.24em] text-cyan-300">
          <span className="size-2 rounded-full bg-cyan-300 shadow-[0_0_18px_#67e8f9]" />
          QuizTaker Control
        </div>
        <div className="relative max-w-xl">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-slate-500">Browser automation / isolated execution</p>
          <h1 className="mt-6 text-6xl font-semibold leading-[0.94] tracking-[-0.06em] text-white">
            Cloud control.
            <br />
            Local trust.
          </h1>
          <p className="mt-8 max-w-md text-lg leading-8 text-slate-400">
            Plans live in the control plane. Chrome credentials and execution stay on your Windows machine.
          </p>
        </div>
        <p className="relative font-mono text-xs text-slate-600">PRIVATE CONTROL PLANE · V1</p>
      </section>
      <section className="flex items-center bg-slate-100 px-6 py-16 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-lg">
          <div className="inline-flex size-12 items-center justify-center rounded-md bg-cyan-700 text-white shadow-lg shadow-cyan-900/20">
            <ShieldCheck className="size-6" />
          </div>
          <h2 className="mt-8 text-4xl font-semibold tracking-[-0.04em] text-slate-950">Operator sign-in</h2>
          <p className="mt-3 leading-7 text-slate-600">
            Access is restricted to the configured account and managed by Neon Auth.
          </p>
          <SignInForm />
        </div>
      </section>
    </main>
  );
}
