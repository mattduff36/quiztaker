import { sanitizeRecentUrl } from '@quiztaker/core';
import { queryRows } from '@/lib/db';

type SqlQuery = (text: string, values?: unknown[]) => Promise<unknown[]>;

export async function applyStructuredResult(input: {
  userId: string;
  helperId: string;
  jobId: string;
  capabilityId: string;
  result: Record<string, unknown>;
}, query: SqlQuery = queryRows): Promise<void> {
  const body = (input.result.result && typeof input.result.result === 'object'
    ? input.result.result
    : input.result) as Record<string, unknown>;
  const session = body.browserSession;
  if (session && typeof session === 'object') {
    const value = session as {
      id?: string;
      revision?: number;
      tabs?: unknown[];
      cdpConnected?: boolean;
    };
    if (value.id && value.revision) {
      await query(
        `update browser_sessions
         set closed_at = now(), updated_at = now()
         where helper_id = $1 and id <> $2 and closed_at is null`,
        [input.helperId, value.id],
      );
      await query(
        `insert into browser_sessions (
           id, user_id, helper_id, revision, cdp_connected, tabs, roster, detection, updated_at
         ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, now())
         on conflict (id) do update set
           revision = excluded.revision,
           cdp_connected = excluded.cdp_connected,
           tabs = excluded.tabs,
           roster = coalesce(excluded.roster, browser_sessions.roster),
           detection = coalesce(excluded.detection, browser_sessions.detection),
           updated_at = now()`,
        [
          value.id,
          input.userId,
          input.helperId,
          value.revision,
          value.cdpConnected !== false,
          JSON.stringify(value.tabs ?? []),
          body.roster ? JSON.stringify(body.roster) : null,
          body.detection ? JSON.stringify(body.detection) : null,
        ],
      );
    }
  }
  if (body.roster && typeof body.roster === 'object') {
    await query(
      `update browser_sessions
       set roster = $3::jsonb, updated_at = now()
       where user_id = $1 and helper_id = $2 and closed_at is null`,
      [input.userId, input.helperId, JSON.stringify(body.roster)],
    );
  }
  if (body.detection && typeof body.detection === 'object') {
    const detection = body.detection as {
      selection?: { kind?: string; title?: string; items?: unknown[] };
    };
    await query(
      `update browser_sessions
       set detection = $3::jsonb, updated_at = now()
       where user_id = $1 and helper_id = $2 and closed_at is null`,
      [input.userId, input.helperId, JSON.stringify(body.detection)],
    );
    const field = detection.selection?.kind === 'class-activities'
      ? 'activities'
      : detection.selection?.kind === 'cert-courses'
        ? 'courses'
        : null;
    if (field && Array.isArray(detection.selection?.items)) {
      await query(
        `update browser_sessions
         set roster = coalesce(roster, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb, 'certTitle', to_jsonb($5::text)),
             updated_at = now()
         where user_id = $1 and helper_id = $2 and closed_at is null`,
        [
          input.userId,
          input.helperId,
          field,
          JSON.stringify(detection.selection.items),
          detection.selection.title || '',
        ],
      );
    }
  }
  const tabs = Array.isArray((session as { tabs?: unknown[] } | undefined)?.tabs)
    ? (session as { tabs: Array<{ url?: string; title?: string }> }).tabs
    : [];
  for (const tab of tabs) {
    if (!tab.url) continue;
    const url = sanitizeRecentUrl(tab.url);
    if (!url) continue;
    await rememberUrl(query, input.userId, input.helperId, input.jobId, url, tab.title || url);
  }
  if (typeof body.url === 'string') {
    const url = sanitizeRecentUrl(body.url);
    if (url) await rememberUrl(query, input.userId, input.helperId, input.jobId, url, String(body.title || url));
  }
  if (input.capabilityId === 'learn-capture' && body.fingerprint) {
    await query(
      `insert into learning_captures (
         user_id, helper_id, source_id, fingerprint, title, detail, probe, captured_at
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
       on conflict (user_id, source_id) do nothing`,
      [
        input.userId,
        input.helperId,
        `job:${input.jobId}`,
        String(body.fingerprint),
        String(body.title || 'Learning capture'),
        String(body.detail || ''),
        JSON.stringify(body),
      ],
    );
  }
  if (input.capabilityId === 'close-browser') {
    await query(
      `update browser_sessions
       set closed_at = now(), cdp_connected = false, updated_at = now()
       where user_id = $1 and helper_id = $2 and closed_at is null`,
      [input.userId, input.helperId],
    );
  }
}

async function rememberUrl(
  query: SqlQuery,
  userId: string,
  helperId: string,
  jobId: string,
  url: string,
  title: string,
): Promise<void> {
  await query(
    `insert into recent_urls (user_id, helper_id, url, title, last_seen_at, last_job_id)
     values ($1, $2, $3, $4, now(), $5)
     on conflict (user_id, url) do update set
       helper_id = excluded.helper_id,
       title = excluded.title,
       seen_count = recent_urls.seen_count + case
         when recent_urls.last_job_id is not distinct from excluded.last_job_id then 0
         else 1
       end,
       last_seen_at = now(),
       forgotten_at = null,
       last_job_id = excluded.last_job_id`,
    [userId, helperId, url, title.slice(0, 300), jobId],
  );
}
