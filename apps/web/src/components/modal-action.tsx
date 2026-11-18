'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** Task details stay available without competing with the primary controls. */
export function ModalAction({label,title=label,children}:{label:string;title?:string;children:ReactNode}) {
  return <Dialog.Root><Dialog.Trigger asChild><button type="button" className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:border-cyan-700 hover:bg-cyan-50 hover:text-cyan-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700">{label}</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/50"/><Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-slate-300 bg-white p-5 shadow-xl sm:p-7">
      <div className="mb-5 flex items-start justify-between gap-4"><Dialog.Title className="text-lg font-semibold text-slate-950">{title}</Dialog.Title><Dialog.Close asChild><button type="button" aria-label={`Close ${title}`} className="-mr-2 -mt-2 flex size-11 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-cyan-700"><X className="size-5"/></button></Dialog.Close></div>{children}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
