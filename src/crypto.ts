import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for the bearer gate. Hashing first makes
 * the comparison length-independent (timingSafeEqual throws on unequal
 * lengths, which would itself leak length) — the sibling tools' pattern.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
