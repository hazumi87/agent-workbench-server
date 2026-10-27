/* Plugin install, one-time tokens (ported from workbench-app src/plugin-tokens.js; the design notes F2, the design notes M6): the
 * engine hands the page a token between two steps, so the bytes that were checked are the bytes installed (check -> install) and Undo names only the backup
 * the engine made (remove -> undo-remove). Redeemed once, expiring, bounded; the value never leaves the engine. Pure.
 * test/modules-plugin-tokens.test.ts. */
import { randomBytes } from 'node:crypto';

const TOKEN = /^[0-9a-f]{32}$/;

export interface TokenOptions {
  now?: () => number;
  ttlMs?: number;
  max?: number;
  rand?: () => string;
}
export interface Tokens<T> {
  put(value: T): string;
  take(token: unknown): T | null;
}

export function createTokens<T = unknown>({ now = () => Date.now(), ttlMs = 10 * 60 * 1000, max = 8, rand = () => randomBytes(16).toString('hex') }: TokenOptions = {}): Tokens<T> {
  const map = new Map<string, { value: T; until: number }>(); // token → {value, until}, in insertion order
  return {
    put(value) {
      const t = rand();
      map.set(t, { value, until: now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value as string);
      return t;
    },
    take(t) {
      if (typeof t !== 'string' || !TOKEN.test(t)) return null;
      const e = map.get(t);
      map.delete(t);
      return e && now() <= e.until ? e.value : null;
    },
  };
}
