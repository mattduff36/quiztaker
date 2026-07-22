import { AppShell } from '@/components/app-shell';
import { HistoryList } from '@/components/history-list';
import { PageFrame } from '@/components/page-frame';
import { requireAuthenticatedUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const user = await requireAuthenticatedUser();
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('history_events')
    .select('id,kind,title,result,detail,occurred_at')
    .eq('user_id', user.id)
    .order('occurred_at', { ascending: false })
    .limit(500);
  return (
    <AppShell email={user.email}>
      <PageFrame eyebrow="Audit trail" title="History" description="Normalized course, activity, session, and automation outcomes from the paired helper.">
        <HistoryList rows={data ?? []} />
      </PageFrame>
    </AppShell>
  );
}
