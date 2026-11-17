'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { LoaderCircle, Unplug } from 'lucide-react';

export function RevokeHelperButton({ helperId }: { helperId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  function revoke() {
    startTransition(async () => {
      await fetch(`/api/helper/${helperId}/revoke`, { method: 'POST' });
      router.refresh();
    });
  }
  return (
    <button
      type="button"
      onClick={revoke}
      title="Disconnect this helper. Pair it again to reconnect."
      disabled={isPending}
      className="inline-flex items-center gap-2 rounded-md border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
    >
      {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Unplug className="size-4" />}
      Revoke helper
    </button>
  );
}
