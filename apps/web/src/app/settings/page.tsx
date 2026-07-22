import { AppShell } from '@/components/app-shell';
import { PageFrame, Panel } from '@/components/page-frame';
import { RevokeHelperButton } from '@/components/revoke-helper-button';
import { requireAuthenticatedUser } from '@/lib/auth';
import { queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requireAuthenticatedUser();
  const helpers = await queryRows<{
    id: string;
    device_name: string;
    platform: string;
    architecture: string;
    version: string;
  }>(
    `select id, device_name, platform, architecture, version
     from helpers
     where user_id = $1 and revoked_at is null
     order by paired_at desc`,
    [user.id],
  );
  return (
    <AppShell email={user.email}>
      <PageFrame eyebrow="Control plane" title="Settings" description="Manage the private operator account and paired execution devices.">
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Authorized account">
            <div className="p-6">
              <p className="text-sm text-slate-500">Only this exact email can access the deployment.</p>
              <p className="mt-3 font-mono text-sm font-semibold text-slate-950">{user.email}</p>
            </div>
          </Panel>
          <Panel title="Paired helpers">
            {helpers.length ? helpers.map((helper) => (
              <div key={helper.id} className="flex items-center justify-between gap-4 border-b border-slate-200 p-5 last:border-0">
                <div>
                  <h2 className="font-semibold text-slate-950">{helper.device_name}</h2>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">{helper.platform}/{helper.architecture} · v{helper.version}</p>
                </div>
                <RevokeHelperButton helperId={helper.id} />
              </div>
            )) : <p className="p-6 text-sm text-slate-500">No active helper is paired.</p>}
          </Panel>
        </div>
      </PageFrame>
    </AppShell>
  );
}
