// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recovery codes (§5.1/§5.2): 10 codes generated at setup, shown once, stored
 * as SHA-256 hashes. Each code has 80 bits of entropy, so a leaked hash (e.g.
 * in a database export) cannot be brute-forced.
 */
import { randomBytes, sha256Hex } from '../../core/crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: easy to read back
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return s.match(/.{4}/g)!.join('-');
}

/** Codes are compared case- and separator-insensitively. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(`recovery:${normalizeRecoveryCode(code)}`);
}
