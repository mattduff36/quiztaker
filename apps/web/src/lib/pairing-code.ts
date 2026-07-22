import { createHash, randomBytes } from 'node:crypto';

export function createPairingCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(8);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
}

export function hashPairingCodeForOrigin(code: string, origin: string): string {
  const controlPlaneUrl = new URL(origin).origin;
  return createHash('sha256')
    .update(`${controlPlaneUrl}\0${normalizePairingCode(code)}`)
    .digest('hex');
}

export function normalizePairingCode(code: string): string {
  return code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}
