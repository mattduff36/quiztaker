import { quickScrapeResult, resultEnvelope } from '@quiztaker/core';
import { readBrowserSession, replaceBrowserSession } from './browser-session.js';

export function structuredResult(
  capabilityId: string,
  output: string,
  code: number | null,
): Record<string, unknown> {
  const parsed = parseJson(output);
  if (capabilityId === 'list-tabs' && Array.isArray(parsed)) {
    const browserSession = replaceBrowserSession(parsed as Array<{ idx?: number; title?: string; url?: string; hasFocus?: boolean }>);
    return { ...resultEnvelope(capabilityId, code === 0, { browserSession }) };
  }
  if (capabilityId === 'quick-scrape') {
    const recording = quickScrapeResult(output);
    return { ...resultEnvelope(capabilityId, code === 0 && Boolean(recording), recording || {}) };
  }
  if (capabilityId === 'quiz-learn') {
    let courseResult: {status:'completed';title:string;evidence:string[]} | undefined;
    try {
      const raw=JSON.parse([...output.matchAll(/^AUTOMATION_RESULT (.+)$/gm)].at(-1)?.[1]||'null')?.courseResult;
      if(code===0 && raw?.status==='completed' && typeof raw.title==='string' && Array.isArray(raw.evidence)
        && raw.evidence.some((value:unknown)=>typeof value==='string'&&value.includes('Saba course detail shows Successful'))) {
        courseResult={status:'completed',title:raw.title.slice(0,200),evidence:raw.evidence.filter((value:unknown)=>typeof value==='string').slice(0,4).map((value:string)=>value.slice(0,500))};
      }
    } catch { /* Only bounded executor evidence is transported. */ }
    let quizResult: Record<string,unknown> | undefined;
    try {
      const raw=JSON.parse([...output.matchAll(/^AUTOMATION_RESULT (.+)$/gm)].at(-1)?.[1]||'null')?.quizResult;
      if(raw&&['passed','failed'].includes(raw.status)) {
        quizResult={status:raw.status};
        for(const field of ['scorePercent','passingScorePercent','questionsTotal','questionsCorrect','questionsIncorrect']) {
          const value=raw[field];
          if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&(field.endsWith('Percent')?value<=100:Number.isInteger(value)&&value<=10_000))quizResult[field]=value;
        }
        if(Array.isArray(raw.evidence))quizResult.evidence=raw.evidence.filter((v:unknown)=>typeof v==='string').slice(0,4).map((v:string)=>v.slice(0,2400));
      }
    } catch { /* Only the current executor's bounded structured result is retained. */ }
    const marker = [...output.matchAll(/^LEARNER_TABS (.+)$/gm)].at(-1)?.[1];
    try {
      const tabs: unknown = marker ? JSON.parse(marker) : null;
      if (Array.isArray(tabs) && tabs.every((tab) => tab && Number.isInteger(tab.idx) && typeof tab.url === 'string' && typeof tab.title === 'string')) {
        return { ...resultEnvelope(capabilityId, code === 0, { browserSession: replaceBrowserSession(tabs), ...(quizResult?{quizResult}:{}), ...(courseResult?{courseResult}:{}) }) };
      }
    } catch { /* Invalid evidence must not change the current browser session. */ }
    if(quizResult||courseResult)return {...resultEnvelope(capabilityId,code===0,{...(quizResult?{quizResult}:{}),...(courseResult?{courseResult}:{})})};
  }
  if (capabilityId === 'cdp-check') {
    const connected = Boolean((parsed as { ok?: boolean } | null)?.ok);
    const session = readBrowserSession();
    return { ...resultEnvelope(capabilityId, connected, {
      connected,
      ...(session ? { browserSession: { ...session, cdpConnected: connected } } : {}),
    }) };
  }
  if (capabilityId === 'cert-status' && parsed && typeof parsed === 'object') {
    return { ...resultEnvelope(capabilityId, code === 0, {
      browserSession: readBrowserSession() ?? replaceBrowserSession([]),
      roster: parsed,
    }) };
  }
  if (capabilityId === 'detect' && parsed && typeof parsed === 'object') {
    return { ...resultEnvelope(capabilityId, code === 0, {
      browserSession: readBrowserSession() ?? replaceBrowserSession([]),
      detection: parsed,
    }) };
  }
  if (capabilityId === 'open-url') {
    return { ...resultEnvelope(capabilityId, code === 0, parsed ?? { ok: code === 0 }) };
  }
  if (capabilityId === 'learn-capture' && parsed && typeof parsed === 'object') {
    const capture = parsed as { fingerprint?: string; title?: string; url?: string; detected?: string; dir?: string };
    return { ...resultEnvelope(capabilityId, code === 0, {
      fingerprint: capture.fingerprint,
      title: capture.title || 'Learning capture',
      detail: capture.detected || '',
      url: capture.url,
      browserSession: readBrowserSession(),
    }) };
  }
  if (capabilityId === 'close-browser') {
    return { ...resultEnvelope(capabilityId, code === 0, { closed: code === 0 }) };
  }
  return { ...resultEnvelope(capabilityId, code === 0, { exitCode: code }) };
}

function parseJson(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = Math.max(trimmed.lastIndexOf('\n{'), trimmed.lastIndexOf('\n['));
    if (start === -1) return null;
    try {
      return JSON.parse(trimmed.slice(start + 1));
    } catch {
      return null;
    }
  }
}
