import Link from 'next/link';
import { ArrowRight, CircleDot, Laptop, Radio } from 'lucide-react';
import { capabilities } from '@quiztaker/core';
import { requireAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { AppShell } from '@/components/app-shell';
import { OperationsClient } from '@/components/operations-client';
import { PageFrame, Panel } from '@/components/page-frame';

export const dynamic = 'force-dynamic';

interface HelperPresence {
  id: string;
  device_name: string;
  version: string;
  is_online: boolean;
}

interface ActiveJob {
  id: string;
  status: string;
  outcome: { status?: string; verified?: boolean } | null;
}

export default async function Home() {
  const user = await requireAuthenticatedUser();
  const helper = await queryOne<HelperPresence>(
    `select * from helper_presence
     where user_id = $1 and revoked_at is null
     order by last_seen_at desc nulls last
     limit 1`,
    [user.id],
  );
  const activeJob = helper ? await queryOne<ActiveJob>(
    `select id, status, outcome
     from jobs
     where user_id = $1 and helper_id = $2
       and status in ('queued', 'dispatched', 'running')
     order by created_at desc
     limit 1`,
    [user.id, helper.id],
  ) : null;
  const isOnline = helper?.is_online === true;

  return (
    <AppShell email={user.email}>
      <PageFrame
        eyebrow="Operations deck"
        title="Local browser operations"
        description="Plans are authorized here and executed by the paired helper against Chrome on your Windows machine."
        actions={(
          <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold ${
            isOnline ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 bg-white text-slate-500'
          }`}>
            <CircleDot className="size-3.5" />
            Helper {isOnline ? 'online' : 'offline'}
          </div>
        )}
      >
        {!helper ? (
          <Panel className="overflow-hidden">
            <div className="grid gap-8 p-7 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <span className="grid size-11 place-items-center rounded-md bg-cyan-100 text-cyan-800"><Laptop className="size-5" /></span>
                <h2 className="mt-5 text-2xl font-semibold tracking-tight text-slate-950">Connect the Windows helper</h2>
                <p className="mt-2 max-w-xl leading-7 text-slate-600">Download, install, and pair the helper before sending browser operations.</p>
              </div>
              <Link href="/helper" className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-5 py-3 font-semibold text-white hover:bg-cyan-700">
                Start setup <ArrowRight className="size-4" />
              </Link>
            </div>
          </Panel>
        ) : (
          <>
            <div className="mb-6 grid gap-4 sm:grid-cols-3">
              <Metric icon={<Radio className="size-4" />} label="Connection" value={isOnline ? 'Live' : 'Awaiting heartbeat'} />
              <Metric icon={<Laptop className="size-4" />} label="Device" value={helper.device_name} />
              <Metric icon={<CircleDot className="size-4" />} label="Helper version" value={helper.version} />
            </div>
            <OperationsClient
              helperId={String(helper.id)}
              capabilities={[...capabilities]}
              initialJob={activeJob ? {
                id: String(activeJob.id),
                status: String(activeJob.status),
                outcome: activeJob.outcome ?? undefined,
              } : null}
            />
          </>
        )}
      </PageFrame>
    </AppShell>
  );
}

function Metric(props: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-300 bg-white p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{props.icon}{props.label}</div>
      <p className="mt-3 truncate font-semibold text-slate-950">{props.value}</p>
    </div>
  );
}
