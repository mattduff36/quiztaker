export function PageFrame(props: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[1500px] px-5 py-8 sm:px-8 lg:px-12 lg:py-11">
      <header className="flex flex-col gap-6 border-b border-slate-300 pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-700">{props.eyebrow}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.045em] text-slate-950 sm:text-5xl">{props.title}</h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">{props.description}</p>
        </div>
        {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
      </header>
      <div className="pt-8">{props.children}</div>
    </div>
  );
}

export function Panel(props: {
  title?: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-slate-300 bg-white shadow-[0_14px_40px_rgba(15,23,42,0.06)] ${props.className ?? ''}`}>
      {props.title ? (
        <header className="flex min-h-14 items-center justify-between border-b border-slate-200 px-5">
          <h2 className="font-semibold tracking-tight text-slate-900">{props.title}</h2>
          {props.meta}
        </header>
      ) : null}
      {props.children}
    </section>
  );
}
