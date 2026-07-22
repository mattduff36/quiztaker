import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { HelperOnboarding } from '@/components/helper-onboarding';
import { PageFrame, Panel } from '@/components/page-frame';
import { requireAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { getLatestHelperRelease } from '@/lib/releases';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Local helper',
  description: 'Pair and inspect the local Windows automation helper.',
};

export default async function HelperPage() {
  const user = await requireAuthenticatedUser();
  const [helper, release] = await Promise.all([
    queryOne<{
      device_name: string;
      last_seen_at: string | null;
      version: string;
      status: string;
      is_online: boolean;
    }>(
      `select device_name, last_seen_at, version, status,
              last_seen_at > now() - interval '30 seconds' as is_online
       from helpers
       where user_id = $1 and revoked_at is null
       order by paired_at desc
       limit 1`,
      [user.id],
    ),
    getLatestHelperRelease(),
  ]);
  const lastSeenAt = helper?.last_seen_at ?? undefined;

  return (
    <AppShell email={user.email}>
      <PageFrame
        eyebrow="Local execution"
        title="Windows helper"
        description="The helper makes outbound HTTPS requests only. CDP, cookies, screenshots, and the interactive Chrome profile remain on your PC."
      >
        <HelperOnboarding
          download={{
            status: release ? 'available' : 'unavailable',
            url: release?.downloadUrl ?? null,
          }}
          connection={{
            state: helper ? (helper.is_online ? 'online' : 'offline') : 'not-paired',
            helperName: helper?.device_name,
            lastSeenAt,
            activity: helper?.status,
          }}
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
