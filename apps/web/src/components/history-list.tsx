'use client';

import { parseAsString, useQueryState } from 'nuqs';
import { Search } from 'lucide-react';

interface HistoryRow {
  id: number;
  kind: string;
  title: string;
  result: string;
  detail: string;
  occurred_at: string;
  payload?: { outputUrl?: string; diagnosis?: { likelyCause?: { label?: string } } } | null;
}

interface SessionRow {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  recap: { items?: number; courses?: number; error?: string };
  needs_review: Array<{ title?: string; result?: string }>;
}

interface JobRow {
  id: string;
  capability_id: string;
  status: string;
  output_url: string | null;
  diagnosis: { likelyCause?: { label?: string; recommendation?: string } } | null;
  created_at: string;
}

export function HistoryList({ rows, sessions = [], jobs = [] }: {
  rows: HistoryRow[];
  sessions?: SessionRow[];
  jobs?: JobRow[];
}) {
  const [query, setQuery] = useQueryState('q', parseAsString.withDefault(''));
  const [kind, setKind] = useQueryState('kind', parseAsString.withDefault(''));
  const normalized = query.trim().toLowerCase();
  const visibleRows = rows.filter((row) => (
    (!kind || row.kind === kind) &&
    (!normalized || `${row.title} ${row.result} ${row.detail} ${row.kind}`.toLowerCase().includes(normalized))
  ));
  const kinds = [...new Set(rows.map((row) => row.kind))];
  return (
    <div>
      {sessions.length ? (
        <div className="mb-5 grid gap-3 md:grid-cols-2">
          {sessions.map((session) => (
            <article key={session.id} className="rounded-lg border border-slate-300 bg-white p-4 text-sm">
              <p className="font-semibold text-slate-950">Session {session.status}</p>
              <p className="mt-1 text-slate-500">{new Date(session.started_at).toLocaleString()}{session.ended_at ? ` – ${new Date(session.ended_at).toLocaleString()}` : ''}</p>
              <p className="mt-2 text-slate-600">{session.recap?.courses ?? 0} courses in {session.recap?.items ?? 0} events{session.recap?.error ? ` · ${session.recap.error}` : ''}</p>
              {session.needs_review?.length ? <p className="mt-2 text-amber-800">{session.needs_review.length} items need review</p> : null}
            </article>
          ))}
        </div>
      ) : null}
      {jobs.length ? (
        <div className="mb-5 overflow-hidden rounded-lg border border-slate-300 bg-white">
          {jobs.map((job) => (
            <article key={job.id} className="grid gap-2 border-b border-slate-200 px-5 py-3 text-sm last:border-0 md:grid-cols-[1fr_auto]">
              <div>
                <p className="font-semibold text-slate-950">{job.capability_id} · {job.status}</p>
                <p className="text-slate-500">{job.diagnosis?.likelyCause?.label || job.diagnosis?.likelyCause?.recommendation || 'No diagnosis'}</p>
              </div>
              {job.output_url ? <a className="font-semibold text-cyan-800" href={job.output_url}>Output</a> : null}
            </article>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setKind(null)} className={`rounded-full border px-3 py-1 text-xs font-semibold ${kind ? 'border-slate-300' : 'border-cyan-600 bg-cyan-50'}`}>All</button>
        {kinds.map((value) => (
          <button key={value} type="button" onClick={() => setKind(value)} className={`rounded-full border px-3 py-1 text-xs font-semibold ${kind === value ? 'border-cyan-600 bg-cyan-50' : 'border-slate-300'}`}>{value}</button>
        ))}
      </div>
      <label className="relative mt-4 block max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value || null)}
          placeholder="Filter history"
          className="h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-4 text-sm outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100"
        />
      </label>
      <div className="mt-5 overflow-hidden rounded-lg border border-slate-300 bg-white">
        {visibleRows.length ? visibleRows.map((row) => (
          <article key={row.id} className="grid gap-3 border-b border-slate-200 px-5 py-4 last:border-0 md:grid-cols-[150px_100px_1fr_180px] md:items-center">
            <time className="font-mono text-[11px] text-slate-500">{new Date(row.occurred_at).toLocaleString()}</time>
            <span className="w-fit rounded-full bg-slate-100 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-600">{row.kind}</span>
            <div>
              <h2 className="font-semibold text-slate-950">{row.title}</h2>
              {row.detail ? <p className="mt-1 text-sm text-slate-500">{row.detail}</p> : null}
              {row.payload?.diagnosis?.likelyCause?.label ? <p className="mt-1 text-sm text-amber-800">{row.payload.diagnosis.likelyCause.label}</p> : null}
              {row.payload?.outputUrl ? <a className="mt-1 inline-block text-sm font-semibold text-cyan-800" href={row.payload.outputUrl}>Artifact</a> : null}
            </div>
            <p className="text-sm font-semibold text-slate-700 md:text-right">{row.result}</p>
          </article>
        )) : <p className="p-8 text-sm text-slate-500">No matching history events.</p>}
      </div>
    </div>
  );
}
