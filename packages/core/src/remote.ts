/** Browser-safe, bounded remote protocol. Private keys and plaintext never enter the relay. */
export const REMOTE_VERSION = 1;
export const REMOTE_HELPER_MIN_VERSION = '1.0.48';
export function supportsRemoteHelper(version: string | undefined): boolean {
  const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version||'');
  if(!match)return false;
  const major=Number(match[1]),minor=Number(match[2]),patch=Number(match[3]);
  return major>1 || (major===1 && (minor>0 || patch>=48));
}
export const REMOTE_LEASE_MS = 15_000;
export const REMOTE_FRAME_MS = 10_000;
export const REMOTE_COMMAND_MS = 8_000;
export const REMOTE_MAX_CIPHER = 900_000;
export type RemoteContext = { helperId: string; sessionId: string; clientId: string };
export type SealedRemote = { seq: number; expiresAt: number; iv: string; ciphertext: string };
export type RemoteGeometry = { width: number; height: number; dpr: number; scrollX: number; scrollY: number; url: string };
export type RemoteFrame = {
  frameId: string; tabId: string; geometry: RemoteGeometry; jpeg: string;
  tabs: Array<{ id: string; title: string; url: string }>;
  capturedAt: number; manual: boolean; message?: string;
};
export type RemoteAction =
  | { type: 'back' | 'forward' | 'reload' }
  | { type: 'tap'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'select-tab'; targetId: string }
  | { type: 'navigate'; url: string };
export type RemoteInput = RemoteAction & { frameId: string; tabId: string; geometry: RemoteGeometry };
export const REMOTE_KEYS = ['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Control+A'] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function base64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
export function validRemotePublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{87}=$/.test(value)) return false;
  try { const raw = unbase64(value); return raw.length === 65 && raw[0] === 4; } catch { return false; }
}
export function validSealedRemote(value: unknown, now = Date.now(), maxFuture = REMOTE_FRAME_MS): value is SealedRemote {
  if (!value || typeof value !== 'object') return false;
  const item = value as SealedRemote;
  return Number.isSafeInteger(item.seq) && item.seq > 0
    && Number.isSafeInteger(item.expiresAt) && item.expiresAt > now && item.expiresAt <= now + maxFuture
    && typeof item.iv === 'string' && /^[A-Za-z0-9+/]{16}$/.test(item.iv)
    && typeof item.ciphertext === 'string' && item.ciphertext.length >= 24
    && item.ciphertext.length <= REMOTE_MAX_CIPHER && /^[A-Za-z0-9+/]+=*$/.test(item.ciphertext);
}
export async function createRemoteKeys(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  return { privateKey: keys.privateKey, publicKey: base64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))) };
}
export async function deriveRemoteKey(privateKey: CryptoKey, publicKey: string): Promise<CryptoKey> {
  if (!validRemotePublicKey(publicKey)) throw new Error('Invalid remote public key');
  const peer = await crypto.subtle.importKey('raw', unbase64(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: peer }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function aad(context: RemoteContext, direction: 'frame' | 'input', seq: number, expiresAt: number) {
  return encoder.encode(JSON.stringify([REMOTE_VERSION, context.helperId, context.sessionId, context.clientId, direction, seq, expiresAt]));
}
export async function sealRemote(key: CryptoKey, context: RemoteContext, direction: 'frame' | 'input', seq: number, value: unknown, now = Date.now()): Promise<SealedRemote> {
  const expiresAt = now + (direction === 'input' ? REMOTE_COMMAND_MS : REMOTE_FRAME_MS);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.length > 650_000) throw new Error('Remote payload is too large');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context, direction, seq, expiresAt) }, key, plaintext);
  return { seq, expiresAt, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
export async function openRemote<T>(key: CryptoKey, context: RemoteContext, direction: 'frame' | 'input', value: SealedRemote, lastSeq: number, now = Date.now()): Promise<T> {
  if (!validSealedRemote(value, now) || value.seq <= lastSeq) throw new Error('Remote payload expired or replayed');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: unbase64(value.iv),
    additionalData: aad(context, direction, value.seq, value.expiresAt),
  }, key, unbase64(value.ciphertext));
  return JSON.parse(decoder.decode(plaintext)) as T;
}
export function safeRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && !/^(localhost|.*\.localhost|.*\.local)$/i.test(url.hostname)
      && !/^[\d.[\]:]+$/.test(url.hostname) && !url.port;
  } catch { return false; }
}
export function sameRemoteGeometry(a: RemoteGeometry, b: RemoteGeometry): boolean {
  return a.width === b.width && a.height === b.height && a.dpr === b.dpr
    && a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.url === b.url;
}
export function assertRemoteInput(value: unknown): asserts value is RemoteInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid remote input');
  const v = value as RemoteInput;
  if (typeof v.frameId !== 'string' || v.frameId.length > 100 || typeof v.tabId !== 'string' || v.tabId.length > 200
    || !v.geometry || !Number.isFinite(v.geometry.width) || !Number.isFinite(v.geometry.height)
    || v.geometry.width < 1 || v.geometry.height < 1 || v.geometry.width > 10_000 || v.geometry.height > 10_000
    || !Number.isFinite(v.geometry.dpr) || !Number.isFinite(v.geometry.scrollX) || !Number.isFinite(v.geometry.scrollY)
    || typeof v.geometry.url !== 'string' || v.geometry.url.length > 20_000) throw new Error('Invalid remote geometry');
  switch (v.type) {
    case 'back': case 'forward': case 'reload': break;
    case 'tap':
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.x < 0 || v.y < 0 || v.x >= v.geometry.width || v.y >= v.geometry.height) throw new Error('Tap is outside the viewport');
      break;
    case 'scroll':
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || Math.abs(v.x) > 2000 || Math.abs(v.y) > 2000) throw new Error('Invalid remote scroll');
      break;
    case 'type': if (typeof v.text !== 'string' || v.text.length > 4000) throw new Error('Remote text is too long'); break;
    case 'key': if (!(REMOTE_KEYS as readonly string[]).includes(v.key)) throw new Error('Unsupported remote key'); break;
    case 'select-tab': if (typeof v.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(v.targetId)) throw new Error('Invalid remote tab'); break;
    case 'navigate': if (!safeRemoteUrl(v.url)) throw new Error('Use a public HTTPS address without credentials or a custom port'); break;
    default: throw new Error('Unsupported remote input');
  }
}
