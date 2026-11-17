export function PageFrame(props: {
  eyebrow?: string;
  title: string;
  description?: string;
  compact?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`mx-auto w-full max-w-[1500px] px-5 sm:px-8 lg:px-12 ${props.compact ? 'py-5 sm:py-7' : 'py-8 lg:py-11'}`}>
      <header className={`flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between ${props.compact ? '' : 'border-b border-slate-300 pb-8'}`}>
        <div>
          {props.eyebrow ? <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-700">{props.eyebrow}</p> : null}
          <h1 className={`${props.eyebrow ? 'mt-3 ' : ''}font-semibold tracking-[-0.03em] text-slate-950 ${props.compact ? 'text-3xl' : 'text-4xl sm:text-5xl'}`}>{props.title}</h1>
          {props.description ? <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">{props.description}</p> : null}
        </div>
        {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
      </header>
      <div className={props.compact ? 'pt-3' : 'pt-8'}>{props.children}</div>
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
