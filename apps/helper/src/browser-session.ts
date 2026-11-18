import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintForUrl, type BrowserSessionSnapshot, type BrowserTabSnapshot } from '@quiztaker/core';
import { ensureHelperDirectories, getHelperHome } from './config.js';

interface StoredSession extends BrowserSessionSnapshot {
  keys: Record<string, string>;
}

export function readBrowserSession(): BrowserSessionSnapshot | null {
  try {
    const value = JSON.parse(readFileSync(sessionPath(), 'utf8')) as StoredSession;
    if (!value?.id || !Array.isArray(value.tabs)) return null;
    return { id: value.id, revision: value.revision, tabs: value.tabs };
  } catch {
    return null;
  }
}

export function replaceBrowserSession(tabs: Array<{
  idx?: number;
  index?: number;
  title?: string;
  url?: string;
  hasFocus?: boolean;
  cdpTargetId?: string;
}>): BrowserSessionSnapshot {
  ensureHelperDirectories();
  const previous = readStored();
  const keys: Record<string,string> = {};
  const assigned = new Set<string>();
  const nextTabs: BrowserTabSnapshot[] = tabs.map((tab, index) => {
    const url = String(tab.url || '');
    const title = String(tab.title || '');
    const cdpTargetId = typeof tab.cdpTargetId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(tab.cdpTargetId) ? tab.cdpTargetId : undefined;
    if (cdpTargetId && assigned.has(cdpTargetId)) throw new Error('Duplicate live browser target identity');
    if (cdpTargetId) assigned.add(cdpTargetId);
    const key = cdpTargetId ? `cdp:${cdpTargetId}` : null;
    // Older executors without live identity fail closed on refresh instead of
    // rebinding a selection to another tab with the same URL/title.
    const targetId = (key && previous?.keys?.[key]) || randomUUID();
    if (key) keys[key] = targetId;
    return {
      targetId,
      ...(cdpTargetId ? {cdpTargetId} : {}),
      index: Number(tab.index ?? tab.idx ?? index),
      title,
      url,
      fingerprint: fingerprintForUrl(url),
      hasFocus: tab.hasFocus === true,
    };
  });
  const changed = !previous || previous.tabs.length !== nextTabs.length || nextTabs.some((tab, index) => (
    previous.tabs[index]?.targetId !== tab.targetId || previous.tabs[index]?.url !== tab.url || previous.tabs[index]?.index !== tab.index
  ));
  const session: StoredSession = {
    id: previous?.id || randomUUID(),
    revision: (previous?.revision || 0) + (changed ? 1 : 0),
    tabs: nextTabs,
    keys,
  };
  if (session.revision < 1) session.revision = 1;
  writeFileSync(sessionPath(), JSON.stringify(session, null, 2));
  return { id: session.id, revision: session.revision, tabs: session.tabs };
}

export function rotateBrowserSession(): void {
  ensureHelperDirectories();
  writeFileSync(sessionPath(), JSON.stringify({
    id: randomUUID(),
    revision: 1,
    tabs: [],
    keys: {},
  }, null, 2));
}

function readStored(): StoredSession | null {
  try {
    return JSON.parse(readFileSync(sessionPath(), 'utf8')) as StoredSession;
  } catch {
    return null;
  }
}

function sessionPath(): string {
  return join(getHelperHome(), 'browser-session.json');
}
