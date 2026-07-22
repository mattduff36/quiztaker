import { AppShell } from '@/components/app-shell';
import { HistoryList } from '@/components/history-list';
import { PageFrame } from '@/components/page-frame';
import { requireAuthenticatedUser } from '@/lib/auth';
import { queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const user = await requireAuthenticatedUser();
  const data = await queryRows<{
    id: number;
    kind: string;
    title: string;
    result: string;
    detail: string;
    occurred_at: string;
  }>(
    `select id, kind, title, result, detail, occurred_at
     from history_events
     where user_id = $1
     order by occurred_at desc
     limit 500`,
    [user.id],
  );
  return (
    <AppShell email={user.email}>
      <PageFrame eyebrow="Audit trail" title="History" description="Normalized course, activity, session, and automation outcomes from the paired helper.">
        <HistoryList rows={data} />
      </PageFrame>
    </AppShell>
  );
}
