import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { HistoryList } from '@/components/history-list';
import { PageFrame } from '@/components/page-frame';
import { requireAuthenticatedUser } from '@/lib/auth';
import { queryRows } from '@/lib/db';
import { MAINTENANCE_CAPABILITIES } from '@/lib/task-completion';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'History',
  description: 'Review verified learning and automation outcomes.',
};

export default async function HistoryPage() {
  const user = await requireAuthenticatedUser();
  const [data, jobs] = await Promise.all([
    queryRows<{
      id: number;
      kind: string;
      title: string;
      result: string;
      detail: string;
      occurred_at: string;
      payload: { outputUrl?: string; diagnosis?: { likelyCause?: { label?: string } } } | null;
    }>(
      `select id, kind, title, result, detail, occurred_at,
         coalesce(payload,'{}'::jsonb) || jsonb_build_object('outputUrl',
           (select '/api/artifacts/'||a.id::text||'/url' from artifacts a
            where a.user_id=history_events.user_id and a.storage_url=history_events.payload->>'outputUrl' limit 1)) as payload
       from history_events
       where user_id = $1
         and not(kind='automation' and coalesce(payload->'outcome'->>'verified','false')='true'
           and exists(select 1 from jobs j where j.id::text=history_events.payload->>'jobId'
             and j.user_id=history_events.user_id and j.capability_id=any($2::text[])))
       order by occurred_at desc
       limit 500`,
      [user.id, MAINTENANCE_CAPABILITIES],
    ),
    queryRows<{
      id: string;
      capability_id: string;
      status: string;
      output_url: string | null;
      diagnosis: { likelyCause?: { label?: string; recommendation?: string } } | null;
      created_at: string;
    }>(
      `select jobs.id, jobs.capability_id, jobs.status,
         case when output.id is not null then '/api/artifacts/'||output.id::text||'/url' else null end as output_url,
         jobs.diagnosis, jobs.created_at
       from jobs
       left join lateral (select id from artifacts where artifacts.job_id=jobs.id and artifacts.user_id=jobs.user_id and artifacts.storage_url=jobs.output_url limit 1) output on true
       where jobs.user_id = $1
       order by jobs.created_at desc
       limit 40`,
      [user.id],
    ),
  ]);
  return (
    <AppShell email={user.email}>
      <PageFrame eyebrow="Audit trail" title="History" description="Courses, activities, verification, sessions, diagnoses, and artifact links from the paired helper.">
        <HistoryList rows={data} jobs={jobs} />
      </PageFrame>
    </AppShell>
  );
}
