'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { serviceIndicators, servicePollDelay, type ServiceStatusSnapshot, type ServiceTone } from '@/lib/service-status';

const dots: Record<ServiceTone, string> = { good: 'bg-emerald-600', warning: 'bg-amber-600', bad: 'bg-rose-600', unknown: 'bg-slate-400' };

export function ServiceStatusBar() {
  const [snapshot, setSnapshot] = useState<ServiceStatusSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    let failures = 0;
    // Advance from server time so a PC clock difference cannot make evidence fresh.
    let serverTime = Date.now();
    let receivedAt = Date.now();
    const updateClock = () => setNow(serverTime + Date.now() - receivedAt);
    const schedule = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(() => void poll(), servicePollDelay(!document.hidden, failures)); };
    async function poll() {
      clearTimeout(timer);
      if (stopped || controller) return;
      setOffline(!navigator.onLine);
      if (!navigator.onLine) { failures += 1; updateClock(); schedule(); return; }
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10_000);
      try {
        const response = await fetch('/api/services/status', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Status unavailable');
        const value = await response.json() as ServiceStatusSnapshot;
        if (!Number.isFinite(Date.parse(value.checkedAt)) || !value.assistant || !('helper' in value) || !('browser' in value)) throw new Error('Status unavailable');
        if (!stopped) {
          serverTime = Date.parse(value.checkedAt); receivedAt = Date.now(); failures = 0;
          setSnapshot(value); setFailed(false); updateClock();
        }
      } catch {
        if (!stopped) { failures += 1; setFailed(true); updateClock(); }
      } finally {
        clearTimeout(timeout); controller = null; schedule();
      }
    }
    const onVisibility = () => { if (!document.hidden) void poll(); else { clearTimeout(timer); schedule(); } };
    const onConnection = () => { setOffline(!navigator.onLine); void poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onConnection); window.addEventListener('offline', onConnection);
    const clock = setInterval(() => { if (!document.hidden) updateClock(); }, 10_000);
    void poll();
    return () => {
      stopped = true; clearTimeout(timer); clearInterval(clock); controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onConnection); window.removeEventListener('offline', onConnection);
    };
  }, []);

  const indicators = serviceIndicators({ snapshot, now, failed, offline });
  return (
    <nav aria-label="Service status" className="sticky top-0 z-20 max-w-full overflow-x-auto border-b border-slate-200 bg-white px-5 sm:px-8 lg:px-12">
      <ul className="flex w-max min-w-full items-center gap-5 text-xs text-slate-700" aria-live="polite" aria-atomic="true">
        {indicators.map(item => <li key={item.id} className="shrink-0">
          <Link href={item.href} aria-label={`${item.label}: ${item.state}`} title={`${item.label}: ${item.state}. ${item.detail}`} className="flex min-h-10 items-center gap-2 whitespace-nowrap rounded-sm hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan-700">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dots[item.tone]}`} />
            <span className="font-medium">{item.label}</span><span className="text-slate-600">{item.state}</span>
          </Link>
        </li>)}
      </ul>
    </nav>
  );
}
