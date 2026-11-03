/** Bounded, read-only server tools. Tool output is untrusted reference material. */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { queryRows, type SqlQuery } from '@/lib/db';

export type ToolEvidence = { tool: string; status: 'completed' | 'failed'; sources?: Array<{ title: string; url: string }>; detail?: string };
export const SERVER_TOOLS = [
  { type: 'function', name: 'read_public_page', description: 'Read a public HTTPS HTML/text reference. No login, private network, LMS session, or credentials. Prefer manufacturer documentation.', strict: true, parameters: { type: 'object', properties: { url: { type: 'string', maxLength: 1000 } }, required: ['url'], additionalProperties: false } },
  { type: 'function', name: 'search_course_material', description: 'Search the authenticated owner’s previously retained course material for facts and source excerpts. Use specific question terms, never URLs or secrets.', strict: true, parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 240 } }, required: ['query'], additionalProperties: false } },
  { type: 'function', name: 'calculate', description: 'Evaluate arithmetic with numbers, parentheses, + - * / % and **. No programming or variables.', strict: true, parameters: { type: 'object', properties: { expression: { type: 'string', maxLength: 200 } }, required: ['expression'], additionalProperties: false } },
  { type: 'function', name: 'current_time', description: 'Current UTC date and time.', strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
] as const;

export function publicSource(value: string): string | null {
  try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null; return `${u.origin}${u.pathname}`.slice(0, 500); } catch { return null; }
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // Public IPv6 global-unicast only; reject mapped/compatible IPv4 and special ranges.
  const first = parseInt(address.split(':')[0],16); const second = parseInt(address.split(':')[1] || '0',16);
  return isIP(address) === 6 && first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

export function validatePublicUrl(raw: string): URL {
  if (raw.length > 1000) throw new Error('Public URL is too long');
  const u = new URL(raw);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443' || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|test|invalid)$/.test(host) || /(?:metadata|instance-data)/.test(host) || /(?:^|\.)(?:sabacloud\.com|id\.hp\.com)$/.test(host) || isIP(host) && !isPublicAddress(host) || [...u.searchParams.keys()].some(k => /token|key|auth|pass|session|cookie|signature|credential|code|sso/i.test(k))) throw new Error('Only credential-free public HTTPS references are allowed');
  u.hash = '';
  return u;
}

export async function readPublicPage(raw: string, redirects = 0, deadline = Date.now() + 10_000): Promise<{ text: string; sources: Array<{ title: string; url: string }> }> {
  const url = validatePublicUrl(raw);
  if (Date.now() >= deadline) throw new Error('Public page time limit reached');
  const answers = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('DNS time limit reached')), Math.min(3000, deadline - Date.now())); t.unref(); })]);
  if (!answers.length || answers.some(a => !isPublicAddress(a.address))) throw new Error('Public page address is not allowed');
  const pinned = answers[0];
  const page = await new Promise<{ status: number; location?: string; type: string; body: string }>((resolve, reject) => {
    const req = httpsRequest(url, {
      method: 'GET', family: pinned.family, headers: { Accept: 'text/html,text/plain', 'User-Agent': 'Vitriol-ReferenceReader/1.0' },
      // Pin the validated IP while retaining the original host and TLS certificate checks.
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
    }, res => {
      const status = res.statusCode || 0;
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (status >= 300 && status < 400) { res.resume(); resolve({ status, location: res.headers.location, type, body: '' }); return; }
      if (status !== 200 || !/^(?:text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/.test(type)) { res.destroy(); reject(new Error('Reference is not a public HTML/text page')); return; }
      if (Number(res.headers['content-length'] || 0) > 256_000) { res.destroy(); reject(new Error('Public page is too large')); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256_000) { res.destroy(new Error('Public page is too large')); return; } chunks.push(chunk); });
      res.on('end', () => resolve({ status, type, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('Public page time limit reached')), Math.max(1, deadline - Date.now()));
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end();
  });
  if (page.status >= 300 && page.status < 400) {
    if (!page.location || redirects >= 3) throw new Error('Public page redirect limit reached');
    return readPublicPage(new URL(page.location, url).toString(), redirects + 1, deadline);
  }
  const title = (page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url.hostname).replace(/<[^>]*>/g, '').slice(0, 200);
  const text = page.body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10_000);
  return { text, sources: [{ title, url: publicSource(url.toString())! }] };
}

/** Recursive descent parser; never executes JavaScript or accesses local code. */
export function calculate(expression: string): number {
  if (!expression || expression.length > 200 || /[^\d.\s+\-*/%()eE]/.test(expression)) throw new Error('Invalid arithmetic expression');
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|\*\*|[()+\-*/%]/g) || [];
  if (tokens.join('') !== expression.replace(/\s/g, '') || tokens.length > 100) throw new Error('Invalid arithmetic expression');
  let pos = 0; let depth = 0;
  function primary(): number { if (++depth > 30) throw new Error('Expression nesting limit'); let n: number; const t = tokens[pos++]; if (t === '(') { n = sum(); if (tokens[pos++] !== ')') throw new Error('Unbalanced expression'); } else if (t === '+' || t === '-') n = (t === '-' ? -1 : 1) * primary(); else { n = Number(t); if (t === undefined || !Number.isFinite(n)) throw new Error('Invalid number'); } depth--; return n; }
  function power(): number { const n = primary(); return tokens[pos] === '**' ? (pos++, n ** power()) : n; }
  function product(): number { let n = power(); while (['*','/','%'].includes(tokens[pos])) { const op = tokens[pos++]; const b = power(); n = op === '*' ? n*b : op === '/' ? n/b : n%b; } return n; }
  function sum(): number { let n = product(); while (['+','-'].includes(tokens[pos])) { const op = tokens[pos++]; const b = product(); n = op === '+' ? n+b : n-b; } return n; }
  const result = sum(); if (pos !== tokens.length || !Number.isFinite(result)) throw new Error('Arithmetic result is not finite'); return result;
}

export async function searchCourseMaterial(userId: string | undefined, query: string, sql: SqlQuery = queryRows) {
  if (!userId) throw new Error('Authenticated course context is unavailable');
  if (!query.trim() || query.length > 240 || /https?:|token|password|bearer|sk-/i.test(query)) throw new Error('Use bounded topic terms without URLs or credentials');
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].slice(0, 16);
  if (!terms.length) throw new Error('Use specific topic terms');
  const rows = await sql<{ materials: unknown }>('select materials from learner_sessions where user_id = $1 order by updated_at desc limit 12', [userId]);
  const matches = rows.flatMap(r => Array.isArray(r.materials) ? r.materials.slice(0,64) : []).flatMap((m: unknown) => {
    if (!m || typeof m !== 'object') return []; const item = m as Record<string, unknown>;
    if (typeof item.text !== 'string') return []; const text = item.text.slice(0,8000); const lower = text.toLowerCase();
    const score = terms.filter(t => lower.includes(t)).length; if (!score) return [];
    const at = Math.max(0, lower.indexOf(terms.find(t => lower.includes(t))!) - 180);
    return [{ score, title: String(item.title || 'Retained course material').slice(0,200), url: publicSource(String(item.url || '')) || '', excerpt: text.slice(at, at+1400) }];
  }).sort((a,b) => b.score-a.score).slice(0,5);
  return { matches };
}

export async function executeServerTool(name: string, raw: string, userId?: string): Promise<{ output: string; evidence: ToolEvidence }> {
  try {
    if (raw.length > 1600) throw new Error('Tool arguments are too large');
    const args = JSON.parse(raw); if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Tool arguments must be an object');
    const field = name === 'read_public_page' ? 'url' : name === 'search_course_material' ? 'query' : name === 'calculate' ? 'expression' : null;
    if (name !== 'current_time' && !field) throw new Error('Tool is unavailable');
    if (Object.keys(args).some(k => k !== field) || field && typeof args[field] !== 'string') throw new Error('Tool arguments are invalid');
    const result = name === 'read_public_page' ? await readPublicPage(args.url) : name === 'search_course_material' ? await searchCourseMaterial(userId, args.query) : name === 'calculate' ? { result: calculate(args.expression) } : { utc: new Date().toISOString() };
    const sources = 'sources' in result ? result.sources : 'matches' in result ? result.matches.filter(m => m.url).map(m => ({ title: m.title, url: m.url })) : undefined;
    return { output: JSON.stringify(result).slice(0,12_000), evidence: { tool: name, status: 'completed', ...(sources ? { sources } : {}) } };
  } catch { return { output: JSON.stringify({ error: 'Tool unavailable, invalid arguments, or reference could not be read. Do not claim it succeeded.' }), evidence: { tool: name.slice(0,80), status: 'failed' } }; }
}
