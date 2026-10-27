/* service-minted delete approvals for module pages (ported from workbench-app src/module-approval.js; the design notes revision 7 C2). When
 * the person confirms a delete in the host's dialog, the host mints a random token bound to the whole scope (window, module, gen, account,
 * selection version, engine epoch, room, verb, task). The delete carries it; the host takes it once. A replay, an expiry (60 s) or any change of
 * scope is refused, and a mismatch burns the token. At most 16 open per window, oldest dropped. Pure (node:crypto only).
 * test/modules-budget-approval.test.ts. */
import { randomBytes } from 'node:crypto';

const KEYS = ['window', 'module', 'gen', 'accountId', 'selectionVersion', 'engineEpoch', 'room', 'verb', 'taskId'] as const;
export type ScopeKey = (typeof KEYS)[number];
/** What a scope is asked to hold; mint and take read it as untrusted, so every field may be anything. */
export type ApprovalScope = Partial<Record<ScopeKey, unknown>>;
type Kind = 'int' | 'str' | 'strOrNull';
const TYPES: Record<ScopeKey, Kind> = { window: 'int', module: 'str', gen: 'int', accountId: 'strOrNull', selectionVersion: 'int', engineEpoch: 'int', room: 'str', verb: 'str', taskId: 'int' };
const MAX_OPEN = 16;
const ok = (k: ScopeKey, v: unknown): boolean =>
  TYPES[k] === 'int' ? Number.isSafeInteger(v) && (v as number) >= 0
    : TYPES[k] === 'str' ? typeof v === 'string' && v.length > 0 && v.length <= 128
      : v === null || (typeof v === 'string' && v.length <= 128);
const same = (a: ApprovalScope, b: ApprovalScope): boolean => KEYS.every((k) => a[k] === b[k]);

export interface ApprovalOptions { now?: () => number; ttlMs?: number }
export interface Approvals {
  /** The person confirmed: a token for exactly this scope, or null if the scope is malformed. */
  mint(scope: ApprovalScope | null | undefined): string | null;
  /** Use a token once for this scope. Any mismatch, replay or expiry is false; the token is gone either way. */
  take(token: unknown, scope: ApprovalScope | null | undefined): boolean;
}

export function createApprovals({ now = () => Date.now(), ttlMs = 60000 }: ApprovalOptions = {}): Approvals {
  const open = new Map<string, { scope: ApprovalScope; at: number }>(); // token -> { scope, at }
  return {
    mint(scope) {
      if (!scope || !KEYS.every((k) => ok(k, scope[k]))) return null;
      const token = randomBytes(16).toString('hex');
      open.set(token, { scope: Object.fromEntries(KEYS.map((k) => [k, scope[k]])) as ApprovalScope, at: now() });
      const mine = [...open].filter(([, v]) => v.scope.window === scope.window);
      for (let i = 0; i < mine.length - MAX_OPEN; i++) open.delete(mine[i][0]);
      return token;
    },
    take(token, scope) {
      if (typeof token !== 'string' || !open.has(token)) return false;
      const v = open.get(token)!;
      open.delete(token);
      return now() - v.at <= ttlMs && !!scope && same(v.scope, scope);
    },
  };
}
