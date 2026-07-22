import { AppShell } from '@/components/app-shell';
import { HelperOnboarding } from '@/components/helper-onboarding';
import { PageFrame, Panel } from '@/components/page-frame';
import { requireAuthenticatedUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function HelperPage() {
  const user = await requireAuthenticatedUser();
  const supabase = createSupabaseAdminClient();
  const { data: helper } = await supabase
    .from('helpers')
    .select('device_name,last_seen_at,version,status')
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .order('paired_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (
    <AppShell email={user.email}>
      <PageFrame
        eyebrow="Local execution"
        title="Windows helper"
        description="The helper makes outbound HTTPS requests only. CDP, cookies, screenshots, and the interactive Chrome profile remain on your PC."
      >
        <HelperOnboarding
          isPaired={Boolean(helper)}
          helperName={helper?.device_name}
          lastSeenAt={helper?.last_seen_at}
        />
        <Panel title="Trust boundary" className="mt-6">
          <div className="grid gap-6 p-6 text-sm leading-6 text-slate-600 md:grid-cols-3">
            <Boundary title="Cloud stores">Confirmed plans, job state, normalized history, and encrypted private artifacts.</Boundary>
            <Boundary title="PC stores">Chrome profile, SSO cookies, local logs, and offline automation cache.</Boundary>
            <Boundary title="Never exposed">Port 9222 is loopback-only. The helper opens no inbound network listener.</Boundary>
          </div>
        </Panel>
      </PageFrame>
    </AppShell>
  );
}

function Boundary(props: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="font-semibold text-slate-950">{props.title}</h3>
      <p className="mt-2">{props.children}</p>
    </div>
  );
}
