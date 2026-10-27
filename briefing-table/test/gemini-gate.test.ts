/**
 * GEMINI GATE (src/engine/gemini-gate.ts) [ticket].
 *
 * Screen-based readiness/busy/dialog classification for gemini-cli panes,
 * driven by fixture text: `busy` and `idle` are sanitized excerpts of a REAL
 * screen (GET /api/sessions/:id/peek against Owner's live gem-ops pane,
 * read-only, never attached, never typed into); `dialog-proceed` /
 * `dialog-auth` / `dialog-auth-waiting` are built from strings verified in
 * the installed `@google/gemini-cli@0.62.0` bundle
 * (`bundle/interactiveCli-R4EMLFLM.js`, npm-packed to a scratch dir for grep,
 * not committed) — real product text, not screen-captured end to end since
 * that screen was never provoked on a live pane. See gemini-gate.ts's header
 * for the full provenance and the same-chunk reasoning.
 *
 * Run with tsx.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'gemini-gate');
const chunk = (name: string): string => (JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as { chunk: string }).chunk;

const gate = await import('../src/engine/gemini-gate.ts');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  }
}

console.log('\n[unarmed / not-ready]');
eq(gate.state('nope'), 'not-ready', 'a pane never armed reads not-ready');
eq(gate.dialogKindOf('nope'), null, '...and no dialog kind');

console.log('\n[real fixture: not-ready — a bare shell prompt, no gemini markers]');
{
  const P = 'g:not-ready';
  gate.arm(P);
  eq(gate.state(P), 'not-ready', 'armed but nothing seen yet: not-ready');
  gate.onPtyData(P, chunk('not-ready'));
  eq(gate.state(P), 'not-ready', 'a bash prompt alone proves nothing: still not-ready');
  gate.reset();
}

console.log('\n[real fixture: idle — the composer footer + boxed placeholder]');
{
  const P = 'g:idle';
  gate.arm(P);
  gate.onPtyData(P, chunk('idle'));
  eq(gate.state(P), 'idle', 'composer + footer, no busy marker in the same chunk: idle');
  eq(gate.dialogKindOf(P), null, 'no dialog');
  gate.reset();
}

console.log('\n[real fixture: busy — the spinner + "(esc to cancel, Ns)" line]');
{
  const P = 'g:busy';
  gate.arm(P);
  gate.onPtyData(P, chunk('busy'));
  eq(gate.state(P), 'busy', 'the busy marker wins the chunk it shares with the footer (same-chunk rule)');
  gate.reset();
}

console.log('\n[busy -> idle transition, same pane, two redraws (the real turn-end sequence)]');
{
  const P = 'g:transition';
  gate.arm(P);
  gate.onPtyData(P, chunk('busy'));
  eq(gate.state(P), 'busy', 'generating');
  gate.onPtyData(P, chunk('idle'));
  eq(gate.state(P), 'idle', 'the next redraw drops the busy marker: idle again (latest chunk wins)');
  gate.reset();
}

console.log('\n[idle -> busy transition]');
{
  const P = 'g:transition2';
  gate.arm(P);
  gate.onPtyData(P, chunk('idle'));
  eq(gate.state(P), 'idle', 'idle first');
  gate.onPtyData(P, chunk('busy'));
  eq(gate.state(P), 'busy', 'a new turn starts: busy');
  gate.reset();
}

console.log('\n[dialog: tool/shell approval — "Do you want to proceed?" / "Allow execution of"]');
{
  const P = 'g:dialog-proceed';
  gate.arm(P);
  gate.onPtyData(P, chunk('idle')); // it was idle a moment ago
  gate.onPtyData(P, chunk('dialog-proceed'));
  eq(gate.state(P), 'dialog', 'a tool-approval prompt blocks, even over a prior idle frame');
  eq(gate.dialogKindOf(P), 'proceed', 'kind: proceed');
  gate.reset();
}

console.log('\n[dialog: auth / login screen]');
{
  const P = 'g:dialog-auth';
  gate.arm(P);
  gate.onPtyData(P, chunk('dialog-auth'));
  eq(gate.state(P), 'dialog', 'the auth method picker blocks');
  eq(gate.dialogKindOf(P), 'auth', 'kind: auth');
  gate.reset();
}

console.log('\n[dialog: "Waiting for authentication…" (mid-OAuth-flow)]');
{
  const P = 'g:dialog-auth-waiting';
  gate.arm(P);
  gate.onPtyData(P, chunk('dialog-auth-waiting'));
  eq(gate.state(P), 'dialog', 'still a dialog while the browser flow is pending');
  eq(gate.dialogKindOf(P), 'auth', 'kind: auth (not proceed)');
  gate.reset();
}

console.log('\n[a dialog outranks a stale busy chunk from the same pane]');
{
  const P = 'g:dialog-over-busy';
  gate.arm(P);
  gate.onPtyData(P, chunk('busy'));
  eq(gate.state(P), 'busy', 'busy first');
  gate.onPtyData(P, chunk('dialog-proceed'));
  eq(gate.state(P), 'dialog', 'a dialog drawn after it takes over');
  gate.reset();
}

console.log('\n[release() — the deliver-held override: cleared until a NEW marker re-blocks]');
{
  const P = 'g:release';
  gate.arm(P);
  gate.onPtyData(P, chunk('dialog-proceed'));
  eq(gate.state(P), 'dialog', 'held on the dialog');
  gate.release(P);
  eq(gate.state(P), 'idle', 'release(): idle until something new draws');
  gate.onPtyData(P, chunk('dialog-auth'));
  eq(gate.state(P), 'dialog', 'a NEW dialog after release re-blocks it');
  eq(gate.dialogKindOf(P), 'auth', '...named correctly');
  gate.reset();
}
{
  const P = 'g:release-not-ready';
  gate.arm(P);
  eq(gate.state(P), 'not-ready', 'never seen anything yet');
  gate.release(P);
  eq(gate.state(P), 'idle', 'release() also lifts a not-ready hold (a human at the window is positive evidence)');
  gate.reset();
}
eq(gate.state('g:release'), 'not-ready', 'reset() drops every pane — a stale id reads not-ready again');

console.log('\n[chunk split across an incomplete escape sequence]');
{
  const P = 'g:split';
  gate.arm(P);
  const busy = chunk('busy');
  const cut = busy.indexOf('esc to cancel') - 3; // mid-escape-sequence, well before the marker text itself
  gate.onPtyData(P, busy.slice(0, cut));
  gate.onPtyData(P, busy.slice(cut));
  eq(gate.state(P), 'busy', 'the incomplete-escape carry reassembles the marker across the split');
  gate.reset();
}

console.log('\n[a chunk with none of the three markers changes nothing]');
{
  const P = 'g:noop-chunk';
  gate.arm(P);
  gate.onPtyData(P, chunk('idle'));
  eq(gate.state(P), 'idle', 'idle first');
  gate.onPtyData(P, '\x1b[2K\x1b[1A'); // a bare partial redraw, no marker text at all
  eq(gate.state(P), 'idle', 'unchanged — a chunk with nothing recognisable is not evidence of anything');
  gate.reset();
}

console.log('\n[drop() — pane end forgets the gate]');
{
  const P = 'g:drop';
  gate.arm(P);
  gate.onPtyData(P, chunk('idle'));
  eq(gate.state(P), 'idle', 'idle before drop');
  gate.drop(P);
  eq(gate.state(P), 'not-ready', 'dropped: reads not-ready like an unarmed pane');
}

console.log('\n[diag — counts and classifications only, never screen text]');
{
  const P = 'g:diag';
  gate.arm(P);
  gate.onPtyData(P, chunk('dialog-auth'));
  const d = gate.diag() as { panes: Record<string, { pastStartup: boolean; last: string; dialogKind: string | null }> };
  eq(d.panes[P].pastStartup, true, 'diag: pastStartup');
  eq(d.panes[P].last, 'dialog', 'diag: last');
  eq(d.panes[P].dialogKind, 'auth', 'diag: dialogKind');
  eq(JSON.stringify(d).includes('Sign in with Google'), false, 'diag never carries the matched screen text');
  gate.reset();
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
