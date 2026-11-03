'use client';
import { useState } from 'react';
import { Panel } from '@/components/page-frame';
import type { aiToolCatalog } from '@/lib/ai-tool-catalog';

type Evidence = {tool:string;status:string;detail?:string;sources?:Array<{title:string;url:string}>};
export function AiToolsPanel({tools}:{tools:ReturnType<typeof aiToolCatalog>}) {
  const [busy,setBusy] = useState(false);
  const [result,setResult] = useState<{ok?:boolean;error?:string;evidence?:Evidence[]} | null>(null);
  async function testTool(tool:'web_search'|'code_interpreter') {
    setBusy(true); setResult(null);
    try { const response = await fetch('/api/settings/tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool})}); setResult(await response.json()); }
    catch {setResult({error:'Tool test could not complete.'});} finally {setBusy(false);}
  }
  return <Panel title="Available AI tools"><div className="divide-y divide-slate-200">{tools.map(tool => <div className="p-5" key={tool.id}><div className="flex items-center justify-between gap-4"><h3 className="font-semibold text-slate-900">{tool.name}</h3><span className="text-xs text-slate-600">{tool.available ? 'Connected' : 'Unavailable'}</span></div><p className="mt-1 text-sm text-slate-600">{tool.detail}</p>{tool.available && (tool.id === 'web_search' || tool.id === 'code_interpreter') ? <button type="button" disabled={busy} onClick={() => testTool(tool.id as 'web_search'|'code_interpreter')} className="mt-3 rounded border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50">Test {tool.id === 'web_search' ? 'web search' : 'Python'}</button> : null}</div>)}</div><div className="border-t border-slate-200 p-5 text-sm text-slate-600"><p>These are this app’s connected capabilities. Model support is confirmed by a successful test. Tests use the saved key on the server and may incur provider charges.</p>{busy ? <p role="status" className="mt-3">Running tool test…</p> : null}{result ? <div aria-live="polite" className="mt-3"><p className="font-medium">{result.ok ? 'Tool test completed.' : result.error || 'Tool test failed.'}</p>{result.evidence?.map((entry,i) => <div className="mt-2" key={i}><p>{entry.tool}: {entry.status}</p>{entry.detail ? <pre className="mt-1 whitespace-pre-wrap break-words text-xs">{entry.detail}</pre> : null}{entry.sources?.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="mt-1 block break-words text-cyan-700 underline">{source.title}</a>)}</div>)}</div> : null}</div></Panel>;
}
