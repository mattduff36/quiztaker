import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintForUrl, sanitizeRecentUrl, type BrowserSessionSnapshot, type BrowserTabSnapshot } from '@quiztaker/core';
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
}>): BrowserSessionSnapshot {
  ensureHelperDirectories();
  const previous = readStored();
  const keys = { ...(previous?.keys ?? {}) };
  const bases = tabs.map((tab) => createHash('sha256').update(`${sanitizeRecentUrl(String(tab.url || '')) || String(tab.url || '')}\n${String(tab.title || '')}`).digest('hex'));
  const baseCounts = new Map<string, number>();
  for (const base of bases) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  const assigned = new Set<string>();
  const nextTabs: BrowserTabSnapshot[] = tabs.map((tab, index) => {
    const url = String(tab.url || '');
    const title = String(tab.title || '');
    const base = bases[index] || '';
    let key = (baseCounts.get(base) ?? 0) > 1
      ? `${base}#${Number(tab.index ?? tab.idx ?? index)}`
      : base;
    if (assigned.has(key)) key = `${base}#slot${index}`;
    assigned.add(key);
    const targetId = keys[key] || randomUUID();
    keys[key] = targetId;
    return {
      targetId,
      index: Number(tab.index ?? tab.idx ?? index),
      title,
      url,
      fingerprint: fingerprintForUrl(url),
      hasFocus: tab.hasFocus === true,
    };
  });
  const changed = !previous || previous.tabs.length !== nextTabs.length || nextTabs.some((tab, index) => (
    previous.tabs[index]?.targetId !== tab.targetId || previous.tabs[index]?.url !== tab.url
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
