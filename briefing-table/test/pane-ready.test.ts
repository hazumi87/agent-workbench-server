/**
 * The vendor-aware "past startup" test the seat-reload drive uses. The old gate-only test could never be true
 * for a Codex/Gemini pane, so every such reload timed out and skipped the welcome (Builder, 4 of 4, 2026-10-09).
 */
import { startupReady, requeueAfterFailedDrive, SETTLE_MS } from '../src/engine/pane-ready.ts';

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const base = { vendor: 'codex-cli', gateArmed: false, gateBlocked: false, live: true, state: 'idle', lastOutputAt: 1000, now: 1000 + SETTLE_MS };

ok(startupReady(base), 'a live, idle Codex pane quiet for the settle time is ready (no startup gate for it)');
ok(!startupReady({ ...base, now: 1000 + SETTLE_MS - 1 }), 'not before the screen has been quiet for the settle time');
ok(!startupReady({ ...base, state: 'streaming' }), 'not while it is still painting');
ok(!startupReady({ ...base, state: 'waiting' }), 'not while it waits on a prompt');
ok(!startupReady({ ...base, live: false }), 'not when the pty is not live');
ok(!startupReady({ ...base, lastOutputAt: undefined }), 'not before it has printed anything');
ok(startupReady({ ...base, vendor: 'gemini-cli' }), 'the same for Gemini');
ok(startupReady({ vendor: 'claude-code', gateArmed: true, gateBlocked: false, live: true, state: 'streaming', lastOutputAt: undefined, now: 5 }), 'Claude is unchanged: gate armed and not blocked');
ok(!startupReady({ vendor: 'claude-code', gateArmed: true, gateBlocked: true, live: true, state: 'idle', lastOutputAt: 0, now: 99999 }), 'Claude blocked stays blocked');
ok(!startupReady({ vendor: 'claude-code', gateArmed: false, gateBlocked: false, live: true, state: 'idle', lastOutputAt: 0, now: 99999 }), 'Claude not yet armed stays not ready');
ok(!startupReady({ vendor: null, gateArmed: false, gateBlocked: false, live: true, state: 'idle', lastOutputAt: 0, now: 99999 }), 'an unknown vendor takes the Claude rule (unchanged)');
ok(!startupReady({ ...base, dialogUp: true }), 'an in-turn dialog vetoes ready even when the screen is quiet');
ok(requeueAfterFailedDrive('timeout') && requeueAfterFailedDrive('needs-you'), 'a live-but-not-ready pane takes the held lines back');
ok(!requeueAfterFailedDrive('spawn-failed') && !requeueAfterFailedDrive('exited'), 'a pane that never spawned or exited has nowhere to hold them');
console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
