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
}

export function HistoryList({ rows }: { rows: HistoryRow[] }) {
  const [query, setQuery] = useQueryState('q', parseAsString.withDefault(''));
  const normalized = query.trim().toLowerCase();
  const visibleRows = normalized
    ? rows.filter((row) => `${row.title} ${row.result} ${row.detail}`.toLowerCase().includes(normalized))
    : rows;
  return (
    <div>
      <label className="relative block max-w-md">
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
            </div>
            <p className="text-sm font-semibold text-slate-700 md:text-right">{row.result}</p>
          </article>
        )) : <p className="p-8 text-sm text-slate-500">No matching history events.</p>}
      </div>
    </div>
  );
}
