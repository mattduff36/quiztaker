'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Check, LoaderCircle } from 'lucide-react';

interface Review {
  id: string;
  type: string;
  title: string;
  detail: string;
  next_action: string;
  created_at: string;
}

export function ReviewList({ reviews }: { reviews: Review[] }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();
  function resolveReview(reviewId: string) {
    startTransition(async () => {
      setError('');
      try {
      const response = await fetch(`/api/reviews/${reviewId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: 'Resolved from the hosted Learning view.' }),
      });
      if (!response.ok) throw new Error('Could not resolve this review. Retry when connected.');
      router.refresh();
      } catch (cause) {setError(cause instanceof Error ? cause.message : 'Could not resolve this review. Retry when connected.');}
    });
  }
  if (!reviews.length) return <p className="p-6 text-sm text-slate-500">No open reviews.</p>;
  return <>{error ? <p role="alert" className="px-5 pt-4 text-sm text-rose-800">{error}</p> : null}{reviews.map((review) => (
    <article key={review.id} className="flex gap-4 border-b border-slate-200 p-5 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-amber-700">{review.type}</p>
        <h3 className="mt-1 font-semibold text-slate-950">{review.title}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">{review.next_action || review.detail}</p>
      </div>
      <button
        onClick={() => resolveReview(review.id)}
        disabled={isPending}
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-slate-300 px-3 text-xs font-semibold hover:border-emerald-500 hover:text-emerald-700"
      >
        {isPending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        Resolve
      </button>
    </article>
  ))}</>;
}
