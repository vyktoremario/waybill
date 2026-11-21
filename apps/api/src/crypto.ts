import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** An opaque, unguessable tracking token (128 bits). Only its hash is stored. */
export function newTrackingToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * The delivery PIN is derived from the tracking token, so the tracking page can show it without the
 * database storing it in plain text. The database keeps only a salted hash for verification.
 */
export function pinFromToken(pinSecret: string, trackingToken: string): string {
  const n = createHmac('sha256', pinSecret).update(`pin:${trackingToken}`).digest().readUInt32BE(0) % 10_000;
  return n.toString().padStart(4, '0');
}

export function hashPin(salt: string, pin: string): string {
  return sha256(`${salt}:${pin}`);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const got = scryptSync(password, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
