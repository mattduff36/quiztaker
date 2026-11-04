import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

const PRIVATE_KEY = /authorization|cookie|password|passphrase|secret|api[_-]?key|token|signature|nonce|credential|^key$/i;
const BINARY_KEY = /^(screenshot|image|image_url|base64|binary|blob|bytes)$/i;
const MAX_TEXT = 64_000;

export function sanitizeLogText(raw: string): string {
  return raw.replace(/data:(?:image|application)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]*/gi, '[binary omitted]')
    .replace(/\\(["'])/g, '$1').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\b(?:Cookie|Set-Cookie):[^\r\n]*/gi, 'Cookie: [redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[redacted key]')
    .replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie|password|passphrase|secret|deviceSecret|encryptedDeviceSecret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|nonce|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, '$1"[redacted]"')
    .replace(/https?%3a%2f%2f[^\s"'<>]+/gi, '[encoded URL omitted]')
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, value => {
      try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return '[redacted URL]'; }
    })
    // Tokenize once. Nested/retried slash matches can freeze the event loop on
    // screenshot payloads before the HTTP request or heartbeat is sent.
    .replace(/[^\s"'<>]+/g, token => {
      const query = token.indexOf('?');
      const slash = token.indexOf('/');
      return slash >= 0 && query > slash ? token.slice(0, query) : token;
    });
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth limit]';
  if (value instanceof Error) return sanitizeLogText(`${value.name}: ${value.message}`);
  if (typeof value === 'string') {
    if (/^data:(?:image|application)\//i.test(value)) return '[binary omitted]';
    if (value.length > 4096 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) return `[binary-like payload omitted: ${value.length} characters]`;
    const clipped = value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)} [truncated after ${MAX_TEXT} characters]` : value;
    return sanitizeLogText(clipped);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return { binary: true, bytes: value.byteLength };
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeLogValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key, PRIVATE_KEY.test(key) ? '[redacted]' : BINARY_KEY.test(key) ? '[binary omitted]' : sanitizeLogValue(item, depth + 1)]));
  return value;
}

export async function responseLogPayload(response: Response, maxBytes = 192_000, deadlineMs = 2000): Promise<unknown> {
  const type = response.headers.get('content-type') || 'unknown';
  if (!/json|text|javascript|xml/i.test(type)) return { type, bytes: response.headers.get('content-length') || 'unknown', body: '[binary omitted]' };
  const reader = response.clone().body?.getReader();
  if (!reader) return { type, body: '' };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const deadline = Date.now() + deadlineMs;
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('preview timeout')), Math.max(1, deadline - Date.now())); })]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      const remaining = maxBytes - size;
      chunks.push(next.value.subarray(0, remaining));
      size += Math.min(remaining, next.value.byteLength);
      if (next.value.byteLength > remaining || size >= maxBytes) { truncated = true; break; }
    }
  } catch { truncated = true; }
  finally { void reader.cancel().catch(() => undefined); }
  const text = Buffer.concat(chunks).toString('utf8');
  let body: unknown = text;
  if (!truncated && /json/i.test(type)) { try { body = JSON.parse(text); } catch { /* Preserve malformed response as sanitized text. */ } }
  return { type, bytes: size, truncated, body: sanitizeLogValue(body) };
}

export interface TerminalStatus { version: string; device: string; connection: string; job: string; updatePhase: string; lastHttp: string; sent: number; received: number }
interface TerminalOutput { isTTY?: boolean; rows?: number; columns?: number; write(value: string): unknown; on?(event: string, listener: () => void): unknown; off?(event: string, listener: () => void): unknown }

export class HelperTerminal {
  private readonly output: TerminalOutput;
  private readonly file: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private closed = false;
  private fileFailed = false;
  private status: TerminalStatus;
  private readonly resize = () => this.prepareScreen();
  constructor(options: { helperHome: string; version: string; device: string; output?: TerminalOutput; maxFileBytes?: number; maxFiles?: number }) {
    this.output = options.output || process.stdout;
    this.maxFileBytes = options.maxFileBytes || 5 * 1024 * 1024;
    this.maxFiles = Math.max(1, Math.min(5, options.maxFiles || 3));
    this.file = join(options.helperHome, 'logs', 'helper-live.jsonl');
    this.status = { version: options.version, device: options.device, connection: 'connecting', job: '', updatePhase: '', lastHttp: 'none', sent: 0, received: 0 };
    try { mkdirSync(join(options.helperHome, 'logs'), { recursive: true }); } catch { this.fileFailed = true; }
    if (this.output.isTTY) { this.output.on?.('resize', this.resize); this.prepareScreen(); }
    else this.drawStatus();
  }
  setStatus(patch: Partial<TerminalStatus>): void { this.status = { ...this.status, ...patch }; this.drawStatus(); }
  private prepareScreen(): void {
    if (this.closed || !this.output.isTTY) return;
    const rows = Math.max(8, this.output.rows || 24);
    this.output.write(`\x1b[r\x1b[2J\x1b[4;${rows}r\x1b[4;1H`);
    this.drawStatus();
  }
  private drawStatus(): void {
    if (this.closed) return;
    const s = this.status;
    const lines = [`Vitriol Helper ${s.version} | ${s.device} | ${s.connection}${s.job ? ' · busy' : ''}`,
      `Job: ${s.job || 'none'} | Update: ${s.updatePhase || 'none'} | HTTP sent ${s.sent} / received ${s.received}`,
      `Last HTTP: ${s.lastHttp} | ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })}`].map(line => sanitizeLogText(line));
    if (!this.output.isTTY) { this.output.write(`[status] ${lines.join(' | ')}\n`); return; }
    const width = Math.max(20, (this.output.columns || 100) - 1);
    this.output.write(`\x1b7${lines.map((line, index) => `\x1b[${index + 1};1H\x1b[2K${line.slice(0, width)}`).join('')}\x1b8`);
  }
  log(kind: string, value: unknown): void {
    if (this.closed) return;
    const safe = sanitizeLogValue(value);
    const record = { at: new Date().toISOString(), kind, data: safe };
    const json = JSON.stringify(record);
    const line = json.length > 256_000 ? `${JSON.stringify({ ...record, data: sanitizeLogText(json.slice(0, 240_000)), truncated: true })}\n` : `${json}\n`;
    const display = typeof safe === 'string' ? safe : JSON.stringify(safe);
    this.output.write(`${record.at} ${kind} ${display.length > 240_000 ? `${display.slice(0, 240_000)} [truncated]` : display}\n`);
    if (this.fileFailed) return;
    try {
      if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > this.maxFileBytes) {
        const last = this.maxFiles - 1;
        if (last === 0) unlinkSync(this.file);
        else {
          if (existsSync(`${this.file}.${last}`)) unlinkSync(`${this.file}.${last}`);
          for (let i = last - 1; i >= 1; i -= 1) if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
          renameSync(this.file, `${this.file}.1`);
        }
      }
      appendFileSync(this.file, line, 'utf8');
    } catch { this.fileFailed = true; this.output.write('Helper log file unavailable; terminal output continues.\n'); }
  }
  sent(method: string, path: string, body: BodyInit | null | undefined): void {
    let value: unknown = body;
    if (typeof body === 'string') { try { value = JSON.parse(body); } catch { /* Text body. */ } }
    else if (body instanceof FormData) value = [...body.entries()].map(([name, entry]) => ({ name, ...(typeof entry === 'string' ? { text: entry } : { type: entry.type, bytes: entry.size, binary: true }) }));
    this.status.sent += 1;
    this.drawStatus();
    this.log('HTTP SEND', { method, path: path.split(/[?#]/)[0], body: value ?? null });
  }
  async received(method: string, path: string, response: Response, durationMs: number): Promise<void> {
    this.status.received += 1;
    this.setStatus({ connection: response.ok ? 'online' : 'reconnecting', lastHttp: `${method} ${path.split(/[?#]/)[0]} → ${response.status} (${durationMs}ms)` });
    this.log('HTTP RECEIVE', { method, path: path.split(/[?#]/)[0], status: response.status, durationMs, payload: await responseLogPayload(response) });
  }
  installConsole(): () => void {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const original = methods.map(method => [method, console[method]] as const);
    for (const method of methods) console[method] = (...values: unknown[]) => this.log(method.toUpperCase(), values.map(value => typeof value === 'string' ? value : value instanceof Error ? `${value.name}: ${value.message}` : inspect(value, { depth: 5, maxArrayLength: 100 })).join(' '));
    return () => { for (const [method, implementation] of original) console[method] = implementation; };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.output.off?.('resize', this.resize);
    if (this.output.isTTY) this.output.write('\x1b[r\x1b[?25h\n');
  }
}
