/**
 * S0 STARTUP BLOCK (src/engine/startup-gate.ts; the design notes §4.4,
 * finding F12) [ticket].
 *
 *  - armed = blocked; a bare shell and every probe byte shape from
 *    test/channels.test.ts (the dev-channels WARNING + its option lines, the
 *    folder-trust dialog) never clear it;
 *  - clears only on positive evidence: a UserPromptSubmit/Stop hook (disarms),
 *    the REPL composer footer AFTER the last prompt (and for a channel launch
 *    only once the DialogWatcher accepted), or a human typing;
 *  - a Notification hook is NOT evidence; a prompt drawn after the evidence
 *    re-blocks; a composer in the same frame as prompt text is vetoed;
 *  - the escape sequences are split across chunks, like the real pty;
 *  - room-typer holds lines as `held:startup`, then types them the moment the
 *    block lifts (onClear), with the diag saying so and never carrying text.
 *
 * SAFETY: a temp db via HARBOR_WB_TABLE set BEFORE any import; no broker, no
 * pty, no port. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-startup-gate-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '100';
process.env.HARBOR_WB_VOICE_ENTER_MS = '10';
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
delete process.env.HARBOR_WB_ROOM_TYPE;

const gate = await import('../src/engine/startup-gate.ts');
const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const { table } = await import('../src/table/endpoint.ts');

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown, msg: string) => eq(JSON.stringify(a), JSON.stringify(b), msg);
const ESC = String.fromCharCode(27);

/* The probe byte shapes, verbatim from test/channels.test.ts (CC 2.1.282,
   probe r1/r6): words positioned by CSI cursor moves, not spaces. */
const WARN = `${ESC}[3G${ESC}[38;5;211m${ESC}[1mWARNING:${ESC}[12GLoading${ESC}[20Gdevelopment${ESC}[32Gchannels${ESC}[22m${ESC}[39m\r\r\n`;
const REST = `${ESC}[3G--dangerously-load-development-channels${ESC}[43Gis for local\r\n  ❯ 1. I am using this for local development\r\n  2. Exit\r\n Enter to confirm · Esc to cancel`;
const TRUST = `${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:${ESC}[22GIs this a project you trust?\r\n ❯ No, exit\r\n Yes, I trust this folder\r\n Enter to confirm`;
/* The old-session dialog's option labels (strings from the CC 2.1.282 binary;
   no byte capture exists yet — P1 — so the layout here is an approximation). */
const OLD_SESSION = `${ESC}[2GThis session is 3 days old and 254k tokens.\r\n ❯ 1. Resume from summary (recommended)\r\n   2. Resume full session as-is\r\n   3. Don't ask me again\r\n Enter to confirm · Esc to cancel`;
/* The REPL at rest: a border rule, the prompt line, a border rule, and the
   dim footer hint drawn word-by-word (an ASSUMED layout: what the heuristic
   needs is the normalised `? for shortcuts` with no prompt text right before). */
const RULE = '─'.repeat(120);
const COMPOSER = `${ESC}[2m${RULE}${ESC}[22m\r\n> ${ESC}[7m ${ESC}[27m\r\n${ESC}[2m${RULE}${ESC}[22m\r\n  ${ESC}[2m?${ESC}[5Gfor${ESC}[9Gshortcuts${ESC}[22m`;
/* A picker draws the same hint on the SAME ROW as its own keys. */
const PICKER = `  Resume Session\r\n ❯ fix the ring  3 days ago\r\n   rooms spec  1 week ago\r\n  → or enter to open · ctrl+x to delete · ? for shortcuts`;
const SHELL = 'svc-ops@homeserver:/srv/code/thing$ claude --resume 83cf5d1a-uuid\r\n';
/* An in-turn permission dialog (CC 2.1.28x) and the server's auto-mode footer. */
const PERM = `${ESC}[2GBash command\r\n   rm -rf build\r\n Do you want to proceed?\r\n ${String.fromCharCode(0x276f)} 1. Yes\r\n   2. No\r\n Esc to cancel ${String.fromCharCode(0xb7)} Tab to amend`;
const AUTO_FOOTER = `\r\n  ${ESC}[38;5;211m${String.fromCharCode(0x23f5, 0x23f5)} auto mode on${ESC}[39m ${ESC}[2m(shift+tab to cycle)${ESC}[22m`;
/* Guard 2b: what a keystroke needs after it to count — 200+ normalised,
   prompt-free characters (the conversation a resume renders, say). */
const FOLLOW = ' ● earlier turn: the ring colours were wrong on the phone'.repeat(5);

const cleared: string[] = [];
gate.onClear((p) => cleared.push(p));
let dialog: string | null = null;
gate.setDialogProbe(() => dialog);

console.log('\n[armed = blocked; bare shell and every probe shape keep it blocked]');
{
  const P = 'g1';
  eq(gate.isBlocked(P), false, 'an unarmed pane is never blocked (no regression for anything not spawned here)');
  gate.arm(P, { channel: false });
  eq(gate.isBlocked(P), true, 'armed at spawn: blocked with no evidence at all');
  gate.onPtyData(P, SHELL);
  eq(gate.isBlocked(P), true, 'a bare shell (claude not yet started) stays blocked');
  gate.onPtyData(P, WARN);
  gate.onPtyData(P, REST);
  eq(gate.isBlocked(P), true, 'probe WARN + REST (dev-channels dialog) never clear it');
  gate.onPtyData(P, TRUST);
  eq(gate.isBlocked(P), true, 'probe TRUST (folder trust, default "No, exit") never clears it');
  gate.onPtyData(P, OLD_SESSION);
  eq(gate.isBlocked(P), true, 'the old-session dialog (default: compact) never clears it');
  /* The frame's own "Enter to confirm · Esc to cancel" footer keeps the NAMED
     kind (guard 4's 409 {prompt} and override must say old-session, P6). */
  eq((gate.diag()[P] as { prompt: string }).prompt, 'old-session', 'diag names the latest prompt kind (the old-session frame, not its menu footer)');
  gate.onPtyData(P, PICKER);
  eq(gate.isBlocked(P), true, 'a picker footer carrying "? for shortcuts" on its own row is VETOED (same frame)');
  eq(cleared.length, 0, 'onClear never fired');
}

console.log('\n[composer after the last prompt clears; a prompt after it re-blocks]');
{
  const P = 'g2';
  gate.arm(P, { channel: false });
  gate.onPtyData(P, TRUST);
  gate.onHumanInput(P); // guard 2a: the human answers trust (Yes)...
  gate.onPtyData(P, WARN + REST); // ...then the dev-channels dialog draws (its text cancels the pending key, 2b)
  // The composer, split mid-escape and mid-word, like a real pty read.
  const at1 = COMPOSER.indexOf('[5G') + 1; // inside `ESC[5G`: the chunk ends on `ESC[`
  const at2 = COMPOSER.indexOf('shortcuts') + 4;
  gate.onPtyData(P, COMPOSER.slice(0, at1));
  eq(gate.isBlocked(P), true, 'half a composer frame: still blocked');
  gate.onPtyData(P, COMPOSER.slice(at1, at2));
  eq(gate.isBlocked(P), true, '"? for short" is not the footer yet');
  gate.onPtyData(P, COMPOSER.slice(at2));
  eq(gate.isBlocked(P), false, 'the footer completed AFTER the last prompt: cleared');
  eq(cleared.includes(P), true, 'onClear fired on the edge');
  eq((gate.diag()[P] as { clearedBy: string }).clearedBy, 'composer', 'diag: cleared by composer');
  gate.onPtyData(P, OLD_SESSION);
  eq(gate.isBlocked(P), true, 'a startup prompt drawn AFTER the composer blocks again');
  gate.onPtyData(P, COMPOSER);
  eq(gate.isBlocked(P), true, 'guard 2a: a composer after old-session with no human key after it: still held');
  gate.onHumanInput(P); // Esc: resume the full session
  gate.onPtyData(P, COMPOSER);
  eq(gate.isBlocked(P), false, '...Esc, then a fresh composer: cleared');
}

console.log('\n[guard 8: the permission-MODE footer is composer evidence too (defaultMode auto draws no hint)]');
{
  /* The mode footer as a TUI draws it: dim, word by word, under the composer
     rule — an ASSUMED layout; what matters is the normalised literal. */
  const mode = (m: string) => `${ESC}[2m${RULE}${ESC}[22m\r\n> \r\n${ESC}[2m${RULE}${ESC}[22m\r\n  ${ESC}[35m⏵⏵ ${m}${ESC}[39m ${ESC}[2m(shift+tab to cycle)${ESC}[22m`;
  const BANNER = `${ESC}[1mClaude Code${ESC}[22m ${ESC}[2mv2.1.283${ESC}[22m\r\n`;
  for (const m of ['auto mode on', 'accept edits on', 'plan mode on']) {
    const P = `g8-${m}`;
    gate.arm(P, { channel: false });
    gate.onPtyData(P, BANNER + TRUST);
    gate.onHumanInput(P); // the human answers trust
    gate.onPtyData(P, mode(m));
    eq(gate.isBlocked(P), false, `"${m}" after the last prompt: cleared`);
    eq((gate.diag()[P] as { clearedBy: string }).clearedBy, 'composer', '...clearedBy composer');
  }
  const Q = 'g8-only';
  gate.arm(Q, { channel: false });
  gate.onPtyData(Q, TRUST);
  gate.onPtyData(Q, `${ESC}[2m${RULE}${ESC}[22m\r\n  plan mode only applies to new sessions\r\n  auto mode online`);
  eq(gate.isBlocked(Q), true, '"plan mode only" and "auto mode online" are not the footer (word boundary)');
  const V = 'g8-veto';
  gate.arm(V, { channel: false });
  gate.onPtyData(V, `${OLD_SESSION}\r\n  auto mode on`);
  eq(gate.isBlocked(V), true, 'a mode footer inside the prompt\'s own frame (within 160 chars) is vetoed');

  const d = gate.diagFor('g8-auto mode on') as { lastPromptContext: unknown; ccVersion: string | null };
  eq(d.lastPromptContext, null, 'a CLEARED gate serves no screen text (review #5)');
  eq((gate.diag()['g8-auto mode on'] as { lastPromptContext: unknown }).lastPromptContext, null, '...nor on the top-level diag');
  eq(d.ccVersion, '2.1.283', 'diag ccVersion from the banner');
  const T = 'g8-held-trust';
  gate.arm(T, { channel: false });
  gate.onPtyData(T, TRUST);
  const dt = gate.diagFor(T) as { lastPromptContext: { kind: string; text: string } };
  eq(dt.lastPromptContext.kind, 'trust', 'a BLOCKED gate: lastPromptContext.kind names the prompt');
  eq(dt.lastPromptContext.text.endsWith('Yes, I trust this folder Enter to confirm'), true, 'lastPromptContext.text: the normalised screen text ending at the latest prompt text');
  eq(dt.lastPromptContext.text.length <= gate.VETO_CHARS, true, '...at most 160 normalised characters');
  gate.onHumanInput(T);
  gate.onPtyData(T, COMPOSER);
  eq((gate.diagFor(T) as { lastPromptContext: unknown }).lastPromptContext, null, 'the moment it clears, the text is gone from the diag');
  eq((gate.diagFor(V) as { lastPromptContext: { kind: string } }).lastPromptContext.kind, 'old-session', 'the held pane\'s diag names the old-session prompt');
  eq(gate.diagFor('never-armed'), undefined, 'an unarmed pane has no diag');
}

console.log('\n[guard 4: currentPrompt — what deliver-held must name before it may override]');
{
  const P = 'g4';
  eq(gate.currentPrompt(P), null, 'an unarmed pane: no current prompt');
  gate.arm(P, { channel: false });
  eq(gate.currentPrompt(P), null, 'armed, no prompt seen since: none current');
  gate.onPtyData(P, OLD_SESSION);
  eq(gate.currentPrompt(P)?.kind, 'old-session', 'the old-session frame is current (named, not "menu")');
  eq(typeof gate.currentPrompt(P)?.at, 'number', '...with when it was seen');
  gate.onPtyData(P, ' plain output'.repeat(20));
  eq(gate.currentPrompt(P)?.kind, 'old-session', 'still current with < 400 prompt-free chars after it');
  gate.onPtyData(P, ' plain output'.repeat(20));
  eq(gate.currentPrompt(P), null, 'more than 400 normalised chars back: not current');
  gate.onPtyData(P, TRUST);
  gate.release(P);
  eq(gate.isBlocked(P), false, 'release (a person\'s deliver-held) clears the block');
  eq((gate.diag()[P] as { clearedBy: string }).clearedBy, 'deliver-held', 'clearedBy deliver-held');
  gate.onPtyData(P, OLD_SESSION);
  eq(gate.isBlocked(P), true, 'a prompt drawn after the release blocks again');

  const C = 'g4-channel';
  gate.arm(C, { channel: true });
  gate.onPtyData(C, WARN + REST);
  dialog = 'not-seen';
  eq(gate.currentPrompt(C)?.kind, 'dev-channels', 'dev-channels, dialog not yet answered: current');
  for (const st of ['accepted', 'human-answered']) {
    dialog = st;
    eq(gate.currentPrompt(C), null, `dev-channels with the dialog ${st}: not current`);
  }
  /* Review #4/#11: a timed-out watcher never saw its dialog and stopped, so
     dev-channels text the gate saw is a dialog nobody answered. */
  dialog = 'timeout';
  eq(gate.currentPrompt(C)?.kind, 'dev-channels', 'dev-channels with the watcher TIMED OUT: still current (needs the override)');
  /* Review 2 P2 (f3): a channel launch whose dialog has not DRAWN yet. */
  const E = 'g4-channel-early';
  const armedAt = Date.now();
  gate.arm(E, { channel: true }, armedAt);
  gate.onPtyData(E, SHELL);
  dialog = 'not-seen';
  same(gate.currentPrompt(E), { kind: 'dev-channels', at: armedAt }, 'a channel launch before its dialog draws: dev-channels is due, at the arm time');
  dialog = 'accepted';
  eq(gate.currentPrompt(E), null, '...not once the watcher accepted it');
  const N = 'g4-no-channel-early';
  gate.arm(N, { channel: false });
  gate.onPtyData(N, SHELL);
  dialog = 'not-seen';
  eq(gate.currentPrompt(N), null, 'a NON-channel spawn before anything draws: nothing current (unchanged)');
  dialog = null;
  gate.onHook(C, 'Stop');
  eq(gate.currentPrompt(C), null, 'a hook-disarmed pane: none current');
}

console.log('\n[review 2 P1-B: owner-armed gates — info, unknown, distrustBefore]');
{
  const S = 'g-spawn';
  gate.arm(S, { channel: false });
  eq(gate.info(S)?.origin, 'spawn', 'a spawn gate says so');
  eq(gate.currentPrompt(S), null, 'a SPAWN gate that has seen nothing: no current prompt (spec §4.4 item 4)');
  const O = 'g-owner';
  gate.arm(O, { channel: false, origin: 'owner' });
  eq(gate.currentPrompt(O)?.kind, 'unknown', 'an OWNER gate that has named nothing: `unknown` (its claude\'s first screen may predate the arm)');
  gate.onPtyData(O, TRUST);
  eq(gate.currentPrompt(O)?.kind, 'trust', '...a named prompt names itself');
  gate.onHook(O, 'Stop', 12345);
  same(gate.info(O), { armedAt: gate.info(O)!.armedAt, origin: 'owner', done: true, doneAt: 12345 }, 'info: done, with the hook time');
  const D = 'g-distrust';
  gate.arm(D, { channel: false });
  gate.onHumanInput(D, 1000);
  eq(gate.isBlocked(D), true, 'guard 2b: a keystroke alone is not evidence yet');
  gate.onPtyData(D, FOLLOW, 1500);
  eq(gate.isBlocked(D), false, 'a keystroke followed by 200+ prompt-free chars cleared it');
  eq(gate.diagFor(D)?.evidenceAt, 1000, '...its evidence time is the KEY\'s');
  gate.distrustBefore(D, 999);
  eq(gate.isBlocked(D), false, 'evidence AFTER the claude\'s start is kept');
  gate.distrustBefore(D, 2000);
  eq(gate.isBlocked(D), true, 'evidence from BEFORE the claude started is set aside: blocked again');
  gate.onPtyData(D, COMPOSER);
  eq(gate.isBlocked(D), false, '...until that claude draws its composer');
  /* Review 4: distrustHumanSince sets aside KEYSTROKES only. */
  const H = 'g-distrust-human';
  gate.arm(H, { channel: false });
  gate.onHumanInput(H, 5000);
  gate.onPtyData(H, FOLLOW, 5200);
  gate.distrustHumanSince(H, 6000);
  eq(gate.isBlocked(H), false, 'a keystroke from before `since` is kept');
  gate.distrustHumanSince(H, 4000);
  eq(gate.isBlocked(H), true, 'a keystroke at or after `since` (the shell\'s `fg`) is set aside');
  gate.onPtyData(H, COMPOSER);
  gate.distrustHumanSince(H, 0);
  eq(gate.isBlocked(H), false, 'composer evidence (a SIGCONT repaint) is never set aside by it');
}

console.log('\n[a prompt and a composer in ONE chunk are ordered by position]');
{
  const P = 'g3';
  gate.arm(P, { channel: false });
  gate.onPtyData(P, COMPOSER + '\r\n' + TRUST);
  eq(gate.isBlocked(P), true, 'composer THEN trust in one chunk: blocked (trust is on screen last)');
  const Q = 'g3b';
  gate.arm(Q, { channel: false });
  gate.onPtyData(Q, TRUST + '\r\n' + 'x '.repeat(200) + COMPOSER);
  eq(gate.isBlocked(Q), true, 'guard 2a: trust THEN (far below) a composer, no human key: held (a footer can repaint under the dialog)');
  const Q2 = 'g3c';
  gate.arm(Q2, { channel: false });
  gate.onPtyData(Q2, TRUST);
  gate.onHumanInput(Q2);
  gate.onPtyData(Q2, '\r\n' + 'x '.repeat(200) + COMPOSER);
  eq(gate.isBlocked(Q2), false, 'trust, a human key, then (far below) a composer: cleared by the later composer');
  eq((gate.diag()[Q2] as { clearedBy: string }).clearedBy, 'composer', '...clearedBy composer (the composer came first, the key is moot)');
}

console.log('\n[channel launch: the dev-channels dialog must have been ACCEPTED]');
{
  const P = 'g4';
  dialog = 'not-seen';
  gate.arm(P, { channel: true });
  gate.onPtyData(P, COMPOSER);
  eq(gate.isBlocked(P), true, 'composer while the DialogWatcher has not accepted: not evidence');
  dialog = 'armed';
  gate.onPtyData(P, COMPOSER);
  eq(gate.isBlocked(P), true, '...nor while an accept is pending');
  dialog = 'accepted';
  gate.onPtyData(P, WARN + REST);
  eq(gate.isBlocked(P), true, 'the dialog text itself');
  gate.onPtyData(P, COMPOSER);
  eq(gate.isBlocked(P), false, 'accepted + a composer after the dialog: cleared');
  /* Guard 6e: a human answered the dialog, or the watcher timed out — the
     composer counts (a missed auto-accept must not hold lines forever). */
  for (const st of ['human-answered', 'timeout']) {
    const Q = `g4-${st}`;
    dialog = 'not-seen';
    gate.arm(Q, { channel: true });
    gate.onPtyData(Q, WARN + REST);
    dialog = st;
    gate.onPtyData(Q, COMPOSER);
    eq(gate.isBlocked(Q), false, `6e: dialog ${st} + a composer after the dialog: cleared`);
    eq((gate.diag()[Q] as { clearedBy: string }).clearedBy, 'composer', `6e: ...by composer (${st})`);
  }
  dialog = null;
  const S = 'g4-stream';
  gate.arm(S, { channel: true });
  eq(JSON.stringify(gate.streamOf(S)), JSON.stringify({ pos: 0, kind: null }), 'streamOf: armed, nothing fed');
  gate.onPtyData(S, WARN + REST);
  const v1 = gate.streamOf(S)!;
  eq(v1.kind, 'dev-channels', 'streamOf: the latest prompt kind');
  gate.onPtyData(S, `${ESC}]0;✳ Claude Code${String.fromCharCode(7)}`);
  const v2 = gate.streamOf(S)!;
  gate.onPtyData(S, `${ESC}]0;· Claude Code${String.fromCharCode(7)}`);
  gate.onPtyData(S, `${ESC}]0;✳ Claude Code${String.fromCharCode(7)}`);
  eq(gate.streamOf(S)!.pos, v2.pos, 'streamOf: OSC title blinks do not move the position counter');
  gate.onHook(S, 'Stop');
  eq(gate.streamOf(S), null, 'streamOf: null once a hook disarmed the gate');
}

console.log('\n[guard 2: human-answer prompts need a human; a keystroke needs output after it]');
{
  const MODE = `${ESC}[2m${RULE}${ESC}[22m\r\n> \r\n${ESC}[2m${RULE}${ESC}[22m\r\n  ${ESC}[35m⏵⏵ auto mode on${ESC}[39m`;
  // §8 human-answer rule: old-session frame, then a mode footer, then no key → held.
  const A = 'g2h-old';
  gate.arm(A, { channel: false });
  gate.onPtyData(A, OLD_SESSION);
  gate.onPtyData(A, '\r\n' + 'y '.repeat(150) + MODE);
  eq(gate.isBlocked(A), true, '2a: old-session frame, then (far below, past the veto) a mode footer, no key → held');
  gate.onHumanInput(A); // Esc
  gate.onPtyData(A, COMPOSER);
  eq(gate.isBlocked(A), false, '2a: Esc, then a composer → clear');
  // Every human-answer kind; generic menu and dev-channels are not in the set.
  const kinds: Array<[string, string, boolean]> = [
    ['trust', TRUST, true],
    ['old-session', OLD_SESSION, true],
    ['resume-conversation', '  Resume this conversation? ❯ yes', true],
    ['api-key', '  Do you want to use this API key? ❯ No', true],
    ['mcp-server', '  New MCP server found in .mcp.json: thing', true],
    ['picker', '  → or enter to open · ctrl+x to delete', true],
    ['dev-channels (dialog accepted)', WARN + REST, false],
    ['menu', '  Enter to select', false],
  ];
  for (const [name, frame, needsKey] of kinds) {
    const K = `g2h-${name}`;
    dialog = 'accepted';
    gate.arm(K, { channel: false });
    gate.onPtyData(K, frame + '\r\n' + 'z '.repeat(120) + COMPOSER);
    eq(gate.isBlocked(K), needsKey, `2a: ${name} then a far composer, no key → ${needsKey ? 'held' : 'cleared'}`);
  }
  dialog = null;
  // A key BEFORE the human-answer prompt is not an answer to it.
  const B = 'g2h-key-before';
  gate.arm(B, { channel: false });
  gate.onHumanInput(B);
  gate.onPtyData(B, TRUST + '\r\n' + 'z '.repeat(120) + COMPOSER);
  eq(gate.isBlocked(B), true, '2a: a key typed before the trust prompt does not answer it');

  // §8 keystrokes: a prompt, then a key that draws nothing, then 15 s → held.
  const C = 'g2k-nothing';
  gate.arm(C, { channel: false });
  gate.onPtyData(C, TRUST, 1_000);
  gate.onHumanInput(C, 2_000);
  gate.onPtyData(C, `${ESC}]0;✳ Claude Code${String.fromCharCode(7)}`, 17_000); // only a title blink, 15 s later
  eq(gate.isBlocked(C), true, '2b: a prompt, a key that draws nothing, 15 s → held');
  gate.onPtyData(C, FOLLOW, 17_100);
  eq(gate.isBlocked(C), true, '2b: output arriving after the 10 s window does not confirm the old key');
  // A key followed by 2 KB of prompt-free output (no human-answer prompt seen) → clear.
  const D2 = 'g2k-output';
  gate.arm(D2, { channel: false });
  gate.onPtyData(D2, SHELL, 1_000);
  gate.onHumanInput(D2, 2_000);
  gate.onPtyData(D2, 'q'.repeat(150), 2_500);
  eq(gate.isBlocked(D2), true, '2b: 150 chars after the key: not yet');
  gate.onPtyData(D2, 'w '.repeat(1024), 3_000);
  eq(gate.isBlocked(D2), false, '2b: a key followed by 2 KB of prompt-free output → clear');
  eq((gate.diag()[D2] as { clearedBy: string }).clearedBy, 'human', '...clearedBy human');
  // Prompt text inside the following output cancels the key.
  const E = 'g2k-prompt-after';
  gate.arm(E, { channel: false });
  gate.onHumanInput(E, 1_000);
  gate.onPtyData(E, 'r '.repeat(50) + OLD_SESSION + 'r '.repeat(300), 1_500);
  eq(gate.isBlocked(E), true, '2b: prompt text in the output after the key: the key does not count');
  // Explicit human verbs stay immediate.
  const F = 'g2k-release';
  gate.arm(F, { channel: false });
  gate.onPtyData(F, SHELL);
  gate.release(F);
  eq(gate.isBlocked(F), false, 'deliver-held (an explicit human verb) is still immediate');
  // A pending key set aside by distrust never confirms later.
  const G = 'g2k-distrust';
  gate.arm(G, { channel: false });
  gate.onHumanInput(G, 1_000); // `claude -c` + Enter at the bash prompt
  gate.distrustBefore(G, 1_500); // room-typer: that claude started after the key
  gate.onPtyData(G, FOLLOW, 2_000);
  eq(gate.isBlocked(G), true, '2b: a pending key distrusted as the shell\'s is dropped — later output does not confirm it');
  const G2 = 'g2k-distrust-human';
  gate.arm(G2, { channel: false });
  gate.onPtyData(G2, TRUST, 500);
  gate.onHumanInput(G2, 1_000); // `fg` + Enter at the shell
  gate.distrustHumanSince(G2, 900);
  gate.onPtyData(G2, COMPOSER, 1_200);
  eq(gate.isBlocked(G2), true, '2a: a key set aside by distrustHumanSince no longer answers the trust prompt');
}

console.log('\n[guard 5: draft reset on `? for shortcuts` after a prompt, never on a mode footer]');
{
  const MODE = `${ESC}[2m${RULE}${ESC}[22m\r\n> \r\n${ESC}[2m${RULE}${ESC}[22m\r\n  ${ESC}[35m⏵⏵ auto mode on${ESC}[39m`;
  const resets: string[] = [];
  gate.onDraftReset((p) => resets.push(p));
  const P = 'g5d-shortcuts';
  gate.arm(P, { channel: false });
  gate.onPtyData(P, OLD_SESSION);
  activity.onInput(P, ESC); // Esc answers the old-session dialog...
  gate.onHumanInput(P);
  eq(activity.draftState(P), 'draft', '(...and leaves the draft parse unknown: counts as a draft)');
  gate.onPtyData(P, COMPOSER);
  eq(gate.isBlocked(P), false, '(cleared on ? for shortcuts)');
  eq(resets.includes(P), true, '5: the draft-reset listener fired');
  eq(activity.draftState(P), 'clean', '5: the draft parse is reset to clean (room-typer wires activity.clearDraft)');
  const M = 'g5d-mode';
  gate.arm(M, { channel: false });
  gate.onPtyData(M, OLD_SESSION);
  activity.onInput(M, ESC);
  gate.onHumanInput(M);
  gate.onPtyData(M, MODE);
  eq(gate.isBlocked(M), false, '(cleared on the mode footer)');
  eq(resets.includes(M), false, '5: a MODE footer never resets the draft');
  eq(activity.draftState(M), 'draft', '5: ...the draft stays unknown');
  const N = 'g5d-noprompt';
  gate.arm(N, { channel: false });
  activity.onInput(N, ESC);
  gate.onPtyData(N, COMPOSER);
  eq(gate.isBlocked(N), false, '(no prompt seen: cleared on ? for shortcuts)');
  eq(resets.includes(N), false, '5: no prompt detected since arm → no reset');
  const K = 'g5d-key';
  gate.arm(K, { channel: false });
  gate.onPtyData(K, SHELL);
  activity.onInput(K, ESC);
  gate.onHumanInput(K);
  gate.onPtyData(K, FOLLOW);
  eq(gate.isBlocked(K), false, '(cleared by a confirmed key)');
  eq(resets.includes(K), false, '5: cleared by anything but ? for shortcuts → no reset');
  // S0 ride fix: a QUOTED hint in rendered history never resets; a counted draft is never wiped.
  const Q = 'g5d-quoted';
  gate.arm(Q, { channel: false });
  gate.onPtyData(Q, OLD_SESSION);
  activity.onInput(Q, ESC);
  gate.onHumanInput(Q);
  gate.onPtyData(Q, ' earlier: the hint reads "? for shortcuts" in the footer.' + FOLLOW);
  eq(gate.isBlocked(Q), false, '(cleared by the quoted hint as composer evidence, as before)');
  eq(resets.includes(Q), false, '5: a hint followed by >200 chars in the same chunk is quoted history → no reset');
  const T = 'g5d-typed';
  gate.arm(T, { channel: false });
  gate.onPtyData(T, OLD_SESSION);
  activity.onInput(T, ESC);
  gate.onHumanInput(T);
  activity.onInput(T, 'also check the');
  gate.onPtyData(T, COMPOSER);
  eq(resets.includes(T), true, '(the live hint fired the reset)');
  eq(activity.draftState(T), 'draft', '5: ...but a COUNTED draft (text Owner typed) is left alone');
}

console.log('\n[guard 1: adoption arms from the replay tail — it may block and name, and clears only on a tail that ends on the REPL footer]');
{
  const PLAIN = (n: number) => ' ● the model said something ordinary here.'.repeat(Math.ceil(n / 42));
  // A tail ending on a prompt → held, named.
  const A = 'g1a-ends-on-prompt';
  gate.adopt(A, SHELL + PLAIN(3000) + OLD_SESSION);
  eq(gate.isBlocked(A), true, '1: a replay tail ending on the old-session dialog → held');
  eq(gate.info(A)?.origin, 'adopt', '...armed with origin adopt');
  eq(gate.currentPrompt(A)?.kind, 'old-session', '...and the prompt is named (deliver-held needs the override)');
  eq((gate.diagFor(A) as { channel: boolean }).channel, false, '...channel:false (the DialogWatcher is not re-armed)');
  // A prompt quoted early, then a composer at the end → clear.
  const B = 'g1b-quoted-early';
  gate.adopt(B, TRUST + PLAIN(2000) + COMPOSER);
  eq(gate.isBlocked(B), false, '1: a human-answer prompt >1,500 chars back, then a composer at the end → clear');
  eq((gate.diagFor(B) as { clearedBy: string }).clearedBy, 'replay', '...clearedBy replay');
  // Human-answer prompt text within the last 1,500 chars → held (even with a composer after it).
  const C = 'g1c-human-answer-near';
  gate.adopt(C, PLAIN(3000) + TRUST + PLAIN(600) + COMPOSER);
  eq(gate.isBlocked(C), true, '1: trust text within the last 1,500 chars → held, the composer after it notwithstanding');
  eq(gate.currentPrompt(C), null, '...the prompt is >400 chars back: deliver-held may release it without an override (item 4)');
  // S0 ride fix: a footer after a NON-human-answer prompt ends the tail on the REPL → clear.
  const D = 'g1d-footer-after-dev-channels';
  gate.adopt(D, PLAIN(3000) + WARN + REST + PLAIN(300) + COMPOSER);
  eq(gate.isBlocked(D), false, '1: dev-channels 500 chars back + the REPL footer after it → clear (a fresh channel seat after a restart)');
  const D2 = 'g1d-footer-after-menu';
  gate.adopt(D2, PLAIN(3000) + PERM + PLAIN(900) + AUTO_FOOTER);
  eq(gate.isBlocked(D2), false, '1: an answered permission menu, a short turn, then the mode footer → clear');
  // ...but a replayed footer is still never live EVIDENCE: nothing else changes.
  eq((gate.diagFor(D) as { clearedBy: string }).clearedBy, 'replay', '...clearedBy replay (not composer)');
  // The auto-updater's notice in the footer's place is a REPL screen too (2026-09-27).
  const D3 = 'g1d-update-footer';
  gate.adopt(D3, PLAIN(3000) + `\r\n  ${ESC}[2mUpdate installed ${String.fromCharCode(0xb7)} Restart to apply${ESC}[22m`);
  eq(gate.isBlocked(D3), false, '1: "Update installed · Restart to apply" where the footer was → clear');
  const D4 = 'g1d-checking-footer';
  gate.adopt(D4, PLAIN(3000) + `\r\n  ${ESC}[2mChecking for updates${ESC}[22m`);
  eq(gate.isBlocked(D4), false, '1: "Checking for updates" where the footer was → clear');
  const D5 = 'g1d-claude-update-cli';
  gate.adopt(D5, SHELL + PLAIN(300) + '\r\nChecking for updates to latest version...\r\n');
  eq(gate.isBlocked(D5), true, '1: `claude update` run in a bare shell is NOT a REPL footer → held');
  const D6 = 'g1d-bypass-footer';
  gate.adopt(D6, PLAIN(3000) + `\r\n  ${ESC}[38;5;211m${String.fromCharCode(0x23f5, 0x23f5)} bypass permissions on${ESC}[39m ${ESC}[2m(shift+tab to cycle)${ESC}[22m`);
  eq(gate.isBlocked(D6), false, '1: the bypass-permissions mode footer → clear (vrpc1, held after every restart)');
  // No REPL footer at the end → held, nothing named.
  const E = 'g1e-no-footer';
  gate.adopt(E, SHELL + PLAIN(500));
  eq(gate.isBlocked(E), true, '1: no prompt text but no REPL footer either → held');
  eq(gate.currentPrompt(E), null, '...with nothing named: one deliver-held releases it');
  const E2 = 'g1e-empty';
  gate.adopt(E2, '');
  eq(gate.isBlocked(E2), true, '1: an empty replay says nothing → held (nothing named)');
  const E3 = 'g1e-old-footer';
  gate.adopt(E3, PLAIN(300) + COMPOSER + PLAIN(2000));
  eq(gate.isBlocked(E3), true, '1: a footer more than 1,500 chars from the end is not the screen now → held');
  // The tail is NORMALISED characters, not raw bytes.
  const F = 'g1f-tail';
  gate.adopt(F, OLD_SESSION + 'p'.repeat(gate.REPLAY_TAIL_CHARS) + COMPOSER);
  eq(gate.isBlocked(F), false, '1: a prompt older than the normalised tail is not read (the footer at the end clears)');
  // THE P1 (S0 ride fix): an in-turn dialog left up for minutes, the focused tool bullet blinking.
  const BULLET = String.fromCharCode(0x23fa);
  const blink = (pairs: number) => {
    let out = '';
    for (let i = 0; i < pairs; i++) {
      out += `${ESC}[?25l${ESC}[7A${ESC}[1G${BULLET}${ESC}[7B${ESC}[1G${ESC}[?25h${ESC}[?25l${ESC}[7A${ESC}[1G ${ESC}[7B${ESC}[1G${ESC}[?25h`;
    }
    return out;
  };
  for (const minutes of [1, 10, 20, 60]) {
    const I = `g1i-perm-${minutes}min`;
    gate.adopt(I, PLAIN(3000) + AUTO_FOOTER + PLAIN(400) + PERM + blink(minutes * 50)); // one pair per 1.2 s
    eq(gate.isBlocked(I), true, `1: a permission dialog up ${minutes} min, only the bullet blinking since → held`);
  }
  eq(blink(60 * 50).length > 64 * 1024, true, '(the 60-minute case is more blink than the old 64 KB raw window held)');
  const I2 = 'g1i-perm-answered';
  gate.adopt(I2, PLAIN(3000) + PERM + blink(200) + PLAIN(300) + AUTO_FOOTER);
  eq(gate.isBlocked(I2), false, '1: the same dialog answered and the turn ended on its footer → clear');
  // Live output after adoption follows the normal rules — item 2 included.
  const G = 'g1g-live-after';
  gate.adopt(G, PLAIN(3000) + OLD_SESSION + PLAIN(200));
  gate.onPtyData(G, COMPOSER);
  eq(gate.isBlocked(G), true, '1+2a: a LIVE footer repainted under the replayed old-session dialog, no key → held');
  gate.onHumanInput(G); // Esc
  gate.onPtyData(G, COMPOSER);
  eq(gate.isBlocked(G), false, '1+2a: Esc, then a live composer → clear');
  const H = 'g1h-reblock';
  gate.adopt(H, SHELL + PLAIN(500) + COMPOSER);
  gate.onPtyData(H, TRUST);
  eq(gate.isBlocked(H), true, '1: a prompt drawn live after the replay cleared it re-blocks');
  gate.onHook(H, 'Stop');
  eq(gate.isBlocked(H), false, '...and its next hook clears and disarms it');
}

console.log('\n[hooks: UserPromptSubmit / Stop clear and disarm; Notification does not]');
{
  const P = 'g5';
  gate.arm(P, { channel: false });
  gate.onPtyData(P, TRUST);
  gate.onHook(P, 'Notification');
  eq(gate.isBlocked(P), true, 'Notification is NOT evidence (it means "needs you")');
  gate.onHook(P, 'SessionStart');
  eq(gate.isBlocked(P), true, 'an unrelated hook name is not evidence');
  gate.onHook(P, 'Stop');
  eq(gate.isBlocked(P), false, 'Stop: the REPL finished a turn — cleared');
  eq((gate.diag()[P] as { clearedBy: string }).clearedBy, 'hook', 'diag: cleared by hook');
  gate.onPtyData(P, TRUST + OLD_SESSION);
  eq(gate.isBlocked(P), false, 'disarmed: prompt-like text in later conversation output never re-blocks');
  const Q = 'g5b';
  gate.arm(Q, { channel: true });
  gate.onHook(Q, 'UserPromptSubmit');
  eq(gate.isBlocked(Q), false, 'UserPromptSubmit clears too, channel launch or not');
}

console.log('\n[human typing is the escape; a prompt drawn after it re-blocks]');
{
  const P = 'g6';
  gate.arm(P, { channel: false });
  gate.onPtyData(P, SHELL);
  gate.onHumanInput(P);
  gate.onPtyData(P, FOLLOW);
  eq(gate.isBlocked(P), false, 'a human typed in the pane, and output followed: cleared (eyes on it)');
  eq((gate.diag()[P] as { clearedBy: string }).clearedBy, 'human', 'diag: cleared by human');
  gate.onPtyData(P, WARN + REST);
  eq(gate.isBlocked(P), true, 'the next startup prompt drawn after the typing blocks again');
  gate.onHumanInput(P);
  gate.onPtyData(P, FOLLOW);
  eq(gate.isBlocked(P), false, 'typing again clears again');
  eq(JSON.stringify(gate.diag()).includes('"dev-channels"') || JSON.stringify(gate.diag()).includes('"menu"'), true, '(sanity: diag carries prompt kinds)');
  /* Guard 8: output text appears ONLY as lastPromptContext (160 chars, in memory). */
  const noCtx = JSON.stringify(Object.values(gate.diag()).map((d) => ({ ...(d as object), lastPromptContext: null })));
  eq(noCtx.includes('Quick') || noCtx.includes('development'), false, 'diag carries no output text outside lastPromptContext');
}

console.log('\n[activity.onInput reports typing vs focus/mouse reports]');
{
  const P = 'g7';
  eq(activity.onInput(P, `${ESC}[I`), false, 'a focus report is not typing');
  eq(activity.onInput(P, `${ESC}[<0;10;5M`), false, 'an SGR mouse report is not typing');
  eq(activity.onInput(P, 'y'), true, 'a key is typing');
  eq(activity.onInput(P, 3), false, 'a bare byte count cannot be classified');
}

console.log('\n[room-typer holds as held:startup and types on the edge]');
{
  activity.setOnChange((p, s) => typer.onActivity(p, s));
  const P = 'recipe:startup#1';
  table.upsert({ paneid: P, recipe_id: null, server: 'local', vendor: 'claude-code', agent: null, session_id: null, state: 'live' });
  const writes: string[] = [];
  sessions.add(P, { state: 'live', pty: { write: (d: string) => writes.push(d) } } as never, null as never);
  gate.arm(P, { channel: false }); // as the spawn path does, before onLive
  activity.onLive(P);
  eq(activity.get(P), 'idle', 'the pane reads idle — exactly the hazard');
  eq(typer.enqueue(P, 'r1', 1, 'Alpha', 'user', 'hello room'), 'queued', 'a room line is QUEUED, not typed');
  eq(typer.enqueueFabric(P, { id: 'env-1', from: 'auriga', kind: 'msg', body: 'hi' }), 'queued', 'a fabric envelope too');
  const pd = (typer.diag().panes as Record<string, { lastResult: string; depth: number }>)[P];
  eq(pd.lastResult, 'held:startup', 'diag: held:startup');
  eq(pd.depth, 2, 'diag: two waiting');
  eq(((typer.diag().startup as Record<string, { blocked: boolean }>)[P]).blocked, true, 'diag.startup shows the pane blocked');
  gate.onPtyData(P, TRUST);
  await sleep(250);
  eq(writes.length, 0, 'nothing typed into the trust dialog, even after the settle time');
  const held = (typer.diag().panes as Record<string, { startup?: { lastPromptContext: { kind: string } | null; clearedBy: string | null; ccVersion: string | null } }>)[P];
  eq(held.startup?.lastPromptContext?.kind, 'trust', 'the held:startup diag entry carries lastPromptContext (guard 8)');
  eq(held.startup?.clearedBy, null, '...clearedBy (null: still held)');
  eq(held.startup?.ccVersion, null, '...and the CC version (null: no banner seen)');
  gate.onHumanInput(P); // the human answers trust (guard 2a)
  // bindResident's order: the activity machine sees the bytes, then the gate.
  activity.onData(P, COMPOSER); // the render is output: the settle guard applies
  gate.onPtyData(P, COMPOSER);
  await sleep(40);
  eq(writes.length, 0, 'the block lifted, but the fresh render is still settling');
  await sleep(250);
  eq(writes[0], '[room Alpha · @user · #1] hello room (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'then the held room line is typed');
  eq(writes[1], '\r', '...with its Enter');
  eq(JSON.stringify(typer.diag()).includes('hello'), false, 'no diag field carries message content');
  sessions.remove(P);
  eq((gate.diag() as Record<string, unknown>)[P], undefined, 'the gate goes with the pane');
}

gate.reset();
typer.reset();
/* Windows refuses to unlink scratch.db while the in-process store holds it. */
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* held open by better-sqlite3 until exit */
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
