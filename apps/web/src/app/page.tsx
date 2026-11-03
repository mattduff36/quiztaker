import type { Metadata } from 'next';
import { requireAuthenticatedUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { AppShell } from '@/components/app-shell';
import { OperationsClient } from '@/components/operations-client';
import { PageFrame } from '@/components/page-frame';
import { HelperWelcome } from '@/components/helper-welcome';

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
        title="Welcome to Vitriol"
        description="A helping hand with your courses. Read, learn and work through quizzes, with clear progress at every step."

      >
        {!helper ? (
          <HelperWelcome helper={null}/>
        ) : (
          <>
            <OperationsClient helperId={String(helper.id)} />
          </>
        )}
      </PageFrame>
    </AppShell>
  );
}

