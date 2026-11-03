import { Panel } from '@/components/page-frame';
import { formatDisplayDate } from '@/lib/display-date';
import type { PlayerEvidence } from '@/lib/player-knowledge';

export function PlayerKnowledgePanel({ records }: { records: Array<{ id: string; evidence: PlayerEvidence }> }) {
  return <Panel title="Course player knowledge">
    <p className="border-b border-slate-200 px-5 py-4 text-sm leading-6 text-slate-600">
      Vitriol remembers player patterns across courses. Documentation helps it look for controls; only observed results verify that an approach works.
    </p>
    {!records.length ? <p className="p-5 text-sm leading-6 text-slate-600">Player knowledge appears after a reading or quiz run. Unrecognized players are added to the research queue.</p> : records.map(({ id, evidence }) => <article key={id} className="border-b border-slate-200 p-5 last:border-0">
      <h3 className="font-semibold text-slate-950">{evidence.name}</h3>
      <p className="mt-1 text-sm text-slate-600">Seen in {evidence.observations} {evidence.observations === 1 ? 'run' : 'runs'} · {evidence.outcomes.length ? `${evidence.outcomes.filter(item => item.verified).length} verified results from ${evidence.outcomes.length} recent runs` : 'No run results recorded yet'}</p>
      <p className="mt-2 text-xs text-slate-600">Last observed {formatDisplayDate(evidence.lastSeenAt)}</p>
      {evidence.findings.length ? <details className="mt-3">
        <summary className="cursor-pointer text-sm font-semibold text-cyan-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-700">Documentation and findings</summary>
        <p className="mt-3 text-xs text-slate-600">Findings reviewed {evidence.researchedAt}. Website checks confirm availability, not newly researched findings or tested automation.</p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">{evidence.findings.map(finding => <li key={finding}>{finding}</li>)}</ul>
        <ul className="mt-3 space-y-2 text-sm">{evidence.sources.map(source => <li key={source.url}>
          <a className="font-medium text-cyan-900 underline underline-offset-4 hover:text-cyan-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-700" href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
          <span className="block text-xs text-slate-600">{source.checkedAt ? `${source.available ? 'Available' : 'Could not check'} · ${formatDisplayDate(source.checkedAt)}` : 'Reviewed source'}</span>
        </li>)}</ul>
      </details> : <p className="mt-3 text-sm leading-6 text-amber-900">Official documentation research is queued. A reviewing agent can add source-linked findings; Vitriol does not yet perform open-ended web research for unknown players.</p>}
    </article>)}
  </Panel>;
}
