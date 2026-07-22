import Link from 'next/link';
import {
  BookOpenText,
  Bot,
  Boxes,
  Cable,
  Download,
  History,
  LogOut,
  Settings,
} from 'lucide-react';
import { productName, productSlogan } from '@/lib/brand';

const navigation = [
  { href: '/', label: 'Operations', icon: Boxes },
  { href: '/helper', label: 'Local helper', icon: Cable },
  { href: '/history', label: 'History', icon: History },
  { href: '/learning', label: 'Learning', icon: Bot },
  { href: '/docs', label: 'Runbooks', icon: BookOpenText },
  { href: '/download', label: 'Download', icon: Download },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell(props: {
  email: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#e9eff1] lg:grid lg:grid-cols-[250px_1fr]">
      <aside className="border-b border-slate-800 bg-slate-950 text-slate-300 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-20 items-center justify-between px-5 lg:h-auto lg:justify-start lg:gap-3 lg:px-7 lg:py-8">
          <Link
            href="/"
            aria-label={`${productName} operations`}
            className="flex items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400"
          >
            <span className="grid size-9 place-items-center rounded-md bg-cyan-500 font-mono text-base font-bold text-slate-950">V</span>
            <span>
              <span className="block font-semibold tracking-tight text-white">{productName}</span>
              <span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-400">Control plane</span>
            </span>
          </Link>
        </div>
        <nav aria-label="Primary navigation" className="flex gap-1 overflow-x-auto px-3 pb-4 lg:block lg:space-y-1 lg:px-4">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex shrink-0 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition hover:bg-white/8 hover:text-white"
            >
              <Icon className="size-4 text-cyan-400" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="hidden border-t border-white/10 p-5 lg:absolute lg:inset-x-0 lg:bottom-0 lg:block">
          <p className="mb-4 text-xs leading-5 text-slate-500">{productSlogan}</p>
          <p className="truncate text-xs text-slate-500">{props.email}</p>
          <form action="/auth/sign-out" method="post" className="mt-3">
            <button className="flex items-center gap-2 text-xs font-semibold text-slate-400 hover:text-white">
              <LogOut className="size-3.5" />
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0">{props.children}</main>
    </div>
  );
}
