import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { HistoryList } from '@/components/history-list';
import { PageFrame } from '@/components/page-frame';
import { requireAuthenticatedUser } from '@/lib/auth';
import { queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'History',
  description: 'Review verified learning and automation outcomes.',
};

export default async function HistoryPage() {
  const user = await requireAuthenticatedUser();
  const [data, sessions, jobs, attempts] = await Promise.all([
    queryRows<{
      id: number;
      kind: string;
      title: string;
      result: string;
      detail: string;
      occurred_at: string;
      payload: { outputUrl?: string; diagnosis?: { likelyCause?: { label?: string } } } | null;
    }>(
      `select id, kind, title, result, detail, occurred_at, payload
       from history_events
       where user_id = $1
       order by occurred_at desc
       limit 500`,
      [user.id],
    ),
    queryRows<{
      id: string;
      status: string;
      started_at: string;
      ended_at: string | null;
      recap: { items?: number; courses?: number; error?: string };
      needs_review: Array<{ title?: string; result?: string }>;
    }>(
      `select id, status, started_at, ended_at, recap, needs_review
       from operator_sessions
       where user_id = $1
       order by started_at desc
       limit 20`,
      [user.id],
    ),
    queryRows<{
      id: string;
      capability_id: string;
      status: string;
      output_url: string | null;
      diagnosis: { likelyCause?: { label?: string; recommendation?: string } } | null;
      created_at: string;
    }>(
      `select jobs.id, jobs.capability_id, jobs.status, jobs.output_url, jobs.diagnosis, jobs.created_at
       from jobs
       where jobs.user_id = $1
       order by jobs.created_at desc
       limit 40`,
      [user.id],
    ),
    queryRows<{
      attempt_id: string;
      occurred_at: string;
      data: { outcome?: string; verified?: boolean; status?: string; diagnosis?: { likelyCause?: { label?: string } } };
    }>(
      `select attempt_id, occurred_at, data
       from attempt_events
       where user_id = $1 and event = 'attempt-finished'
       order by occurred_at desc
       limit 100`,
      [user.id],
    ),
  ]);
  const attemptRows = attempts.map((attempt, index) => ({
    id: -1 - index,
    kind: 'attempt',
    title: attempt.attempt_id,
    result: attempt.data?.verified ? `${attempt.data.outcome || 'finished'} (verified)` : String(attempt.data?.outcome || 'unknown'),
    detail: attempt.data?.diagnosis?.likelyCause?.label || attempt.data?.status || '',
    occurred_at: attempt.occurred_at,
    payload: attempt.data,
  }));
  return (
    <AppShell email={user.email}>
      <PageFrame eyebrow="Audit trail" title="History" description="Courses, activities, verification, sessions, diagnoses, and artifact links from the paired helper.">
        <HistoryList rows={[...attemptRows, ...data]} sessions={sessions} jobs={jobs} />
      </PageFrame>
    </AppShell>
  );
}
