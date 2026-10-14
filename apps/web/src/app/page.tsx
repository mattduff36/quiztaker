import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Laptop } from 'lucide-react';
import { requireAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { AppShell } from '@/components/app-shell';
import { OperationsClient } from '@/components/operations-client';
import { PageFrame, Panel } from '@/components/page-frame';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Operations',
  description: 'Authorize and monitor local learning automation.',
};

interface HelperPresence {
  id: string;
  device_name: string;
  version: string;
  is_online: boolean;
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

  return (
    <AppShell email={user.email}>
      <PageFrame
        title="Your learning assistant"
        description="Choose a course tab and start. Vitriol inspects the page, chooses a supported approach, and asks for your help when it needs it."

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
            <OperationsClient helperId={String(helper.id)} />
          </>
        )}
      </PageFrame>
    </AppShell>
  );
}

