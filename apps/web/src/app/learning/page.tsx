import { AppShell } from '@/components/app-shell';
import { PageFrame, Panel } from '@/components/page-frame';
import { ReviewList } from '@/components/review-list';
import { requireAuthenticatedUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function LearningPage() {
  const user = await requireAuthenticatedUser();
  const supabase = createSupabaseAdminClient();
  const [{ data: strategies }, { data: reviews }] = await Promise.all([
    supabase.from('strategies').select('*').eq('user_id', user.id).order('updated_at', { ascending: false }),
    supabase.from('review_items').select('*').eq('user_id', user.id).eq('status', 'open').order('created_at', { ascending: false }),
  ]);
  const values = strategies ?? [];
  return (
    <AppShell email={user.email}>
      <PageFrame eyebrow="Measured evidence" title="Learning" description="Strategies promote only after three verified successes across two distinct targets. Regressions return to review.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Metric label="Promoted" value={values.filter((item) => item.status === 'promoted').length} />
          <Metric label="Candidates" value={values.filter((item) => item.status === 'candidate').length} />
          <Metric label="Needs review" value={reviews?.length ?? 0} />
        </div>
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <Panel title="Strategies">
            {values.length ? values.map((strategy) => (
              <article key={strategy.id} className="grid grid-cols-[1fr_auto] gap-4 border-b border-slate-200 p-5 last:border-0">
                <div>
                  <h3 className="font-semibold text-slate-950">{strategy.capability_id}</h3>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">{strategy.fingerprint || 'unfingerprinted'}</p>
                  <p className="mt-2 text-sm text-slate-600">{strategy.successes} verified successes · {strategy.failures} failures</p>
                </div>
                <span className="h-fit rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-700">{strategy.status}</span>
              </article>
            )) : <p className="p-6 text-sm text-slate-500">No strategy evidence has been synced yet.</p>}
          </Panel>
          <Panel title="Review queue" meta={<span className="font-mono text-xs text-slate-500">{reviews?.length ?? 0} open</span>}>
            <ReviewList reviews={reviews ?? []} />
          </Panel>
        </div>
      </PageFrame>
    </AppShell>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-300 bg-white p-5">
      <p className="font-mono text-xs uppercase tracking-wider text-slate-500">{props.label}</p>
      <p className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-slate-950">{props.value}</p>
    </div>
  );
}
