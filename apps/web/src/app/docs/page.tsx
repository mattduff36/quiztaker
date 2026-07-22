import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { AppShell } from '@/components/app-shell';
import { PageFrame, Panel } from '@/components/page-frame';
import { requireAuthenticatedUser } from '@/lib/auth';

const documents = {
  agents: { label: 'Agent guide', file: 'AGENTS.md' },
  types: { label: 'Quiz types', file: 'QUIZ-TYPES.md' },
  runbook: { label: 'Assessment runbook', file: 'RUNBOOK.md' },
  deployment: { label: 'Deployment & recovery', file: 'DEPLOYMENT.md' },
} as const;

export default async function DocsPage(props: {
  searchParams: Promise<{ document?: string }>;
}) {
  const user = await requireAuthenticatedUser();
  const query = await props.searchParams;
  const key = query.document && query.document in documents
    ? query.document as keyof typeof documents
    : 'agents';
  const selected = documents[key];
  const contentRoot = path.join(process.cwd(), 'content');
  const markdown = await readFile(path.join(contentRoot, selected.file), 'utf8').catch(() => 'Document unavailable in this deployment.');
  return (
    <AppShell email={user.email}>
      <PageFrame eyebrow="Operational knowledge" title="Runbooks" description="Versioned procedures and measured strategy evidence shipped with the control plane.">
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          <nav className="space-y-2">
            {Object.entries(documents).map(([documentKey, value]) => (
              <Link
                key={documentKey}
                href={`/docs?document=${documentKey}`}
                className={`block rounded-md border px-4 py-3 text-sm font-semibold ${
                  key === documentKey ? 'border-cyan-600 bg-cyan-50 text-cyan-900' : 'border-slate-300 bg-white text-slate-600'
                }`}
              >
                {value.label}
              </Link>
            ))}
          </nav>
          <Panel>
            <article className="prose prose-slate max-w-none p-6 lg:p-8 [&_code]:font-mono [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-slate-950 [&_pre]:p-4 [&_pre]:text-slate-300 [&_table]:block [&_table]:overflow-auto">
              <ReactMarkdown>{markdown}</ReactMarkdown>
            </article>
          </Panel>
        </div>
      </PageFrame>
    </AppShell>
  );
}
