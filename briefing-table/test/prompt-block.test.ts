/**
 * PROMPT BLOCK (src/engine/prompt-block.ts) [ticket] [ticket] — "this
 * session needs you": login / permission / question, and the activity ring
 * that must read `waiting` (never `streaming`) while one is on screen.
 *
 * FIXTURES (test/fixtures/prompt-block/) are REAL pty recordings of the
 * installed Claude Code 2.1.285, captured 2026-09-30 from a scratch python
 * pty (120x40) — never a pane of Owner's, nothing typed into a live session:
 *   logged-out        scratch CLAUDE_CONFIG_DIR (no credentials): the REPL's
 *                     `Not logged in · Run /login` footer, then a prompt that
 *                     answered `Not logged in · Please run /login`
 *   login-method      the /login screen (`Select login method:`)
 *   permission-open   a Bash approval (`Do you want to proceed?`), left up
 *   permission-answered  the same, answered with Enter: the composer footer
 *                     (`⏸ manual mode on · esc to interrupt`) comes back
 *   question          an AskUserQuestion picker (`3. Type something.`,
 *                     `4. Chat about this`, `Enter to select · …`)
 * The scratch path and the account's usage line are redacted; nothing else
 * was changed. Gemini reuses test/fixtures/gemini-gate (see its header). The
 * 2.1.282 recordings in test/fixtures/vscreen are the normal-session control.
 *
 * Run with tsx.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
type Rec = { t: number; dir: string; data: string };
const rec = (path: string): Rec[] =>
  readFileSync(join(FIX, path), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec)
    .filter((r) => r.dir === 'out');
const cc = (name: string): Rec[] => rec(`prompt-block/cc-2.1.285-${name}.jsonl`);
const gchunk = (name: string): string => (JSON.parse(readFileSync(join(FIX, 'gemini-gate', `${name}.json`), 'utf8')) as { chunk: string }).chunk;

const pb = await import('../src/engine/prompt-block.ts');
const activity = await import('../src/engine/activity.ts');
const gemini = await import('../src/engine/gemini-gate.ts');
const typer = await import('../src/engine/room-typer.ts');
const { heldWord } = await import('../web/held-words.mjs');

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
const reason = (p: string): string | null => pb.get(p)?.reason ?? null;
/** Feed every recorded chunk; the answer after each, in order. */
function play(p: string, recs: Rec[]): Array<string | null> {
  const seen: Array<string | null> = [];
  for (const r of recs) {
    activity.onData(p, r.data);
    pb.onPtyData(p, r.data);
    seen.push(reason(p));
  }
  return seen;
}
/** Index of the first chunk whose raw text contains `s`. */
const firstWith = (recs: Rec[], s: string): number => recs.findIndex((r) => r.data.includes(s));

console.log('\n[unarmed]');
eq(pb.get('nope'), null, 'a pane never armed is never blocked');
pb.arm('shell', 'cli-manager');
pb.onPtyData('shell', 'Please run /login\r\n');
eq(pb.get('shell'), null, 'a shell (not claude / gemini) is never armed, whatever it prints');

console.log('\n[CC 2.1.285 logged out: the /login prompt]');
{
  const P = 'cc:logged-out';
  pb.arm(P, 'claude-code');
  activity.onLive(P);
  const recs = cc('logged-out');
  const seen = play(P, recs);
  const foot = recs.findIndex((r) => r.data.includes('Run') && r.data.includes('/login'));
  eq(foot > 0, true, 'the recording draws the logged-out footer');
  eq(seen.slice(0, foot).every((x) => x === null), true, 'nothing blocked before the login text draws (banner, notices, composer)');
  eq(seen[seen.length - 1], 'login', 'at the end (footer + "Please run /login" error): needs you — login');
  eq(activity.get(P), 'waiting', 'the ring reads waiting (coral "needs you")');
  const b = activity.dump().find((x) => x.paneid === P)?.blocked;
  eq(b?.reason, 'login', '/api/diag/activity carries blocked.reason');
  eq(typeof b?.since, 'number', '...and blocked.since');

  /* THE BUG (Owner 2026-09-29): the repeating prompt counted as output, so the
     seat read streaming. Replay the logged-out frames over and over, well
     above the 600-byte streaming floor. */
  const frames = recs.slice(foot).map((r) => r.data).join('');
  for (let i = 0; i < 8; i++) {
    activity.onData(P, frames);
    pb.onPtyData(P, frames);
  }
  eq(frames.length > 600, true, `the repaint is above the streaming floor (${frames.length} bytes)`);
  eq(activity.get(P), 'waiting', 'a repeating /login prompt stays WAITING — never streaming');
  eq(reason(P), 'login', '...and still blocked on login');

  /* asks decay in loudness, never in existence */
  activity.ack(P, 'input');
  eq(activity.get(P), 'waiting-seen', 'a human looked (ack): the alarm quiets to waiting-seen (v33, ticket) — not idle, not streaming');
  activity.onData(P, frames);
  eq(activity.get(P), 'waiting-seen', '...and the repaint still cannot make it stream');
  eq(reason(P), 'login', '...but the block itself is still there (the room keeps saying it)');

  pb.onPtyData(P, 'Login successful. Press Enter to continue…\r\n');
  eq(reason(P), null, '"Login successful" clears it');
  activity.drop(P);
  pb.drop(P);
}

console.log('\n[CC 2.1.285 /login method screen]');
{
  const P = 'cc:login-method';
  pb.arm(P, 'claude-code');
  const seen = play(P, cc('login-method'));
  eq(seen[seen.length - 1], 'login', '"Select login method:" is a login block');
  pb.onHook(P, 'Notification', 'auth_success');
  eq(reason(P), null, 'the auth_success notification clears it');
  pb.drop(P);
}

console.log('\n[CC 2.1.285 permission dialog, left up]');
{
  const P = 'cc:perm-open';
  pb.arm(P, 'claude-code');
  activity.onLive(P);
  const recs = cc('permission-open');
  const seen = play(P, recs);
  const at = firstWith(recs, 'proceed?');
  eq(at > 0, true, 'the recording draws the dialog');
  eq(seen.slice(0, at).every((x) => x === null), true, 'the NORMAL busy screen before it (trust answered, banner, prompt, thinking spinner) is never blocked');
  eq(seen[seen.length - 1], 'permission', 'the Bash approval: needs you — permission');
  eq(activity.get(P), 'waiting', 'ring: waiting');
  /* its cursor animation keeps emitting for as long as it is up */
  for (let i = 0; i < 400; i++) {
    const blink = i % 2 ? '\x1b[?25l\x1b[12;3H\x1b[38;5;246m❯\x1b[39m' : '\x1b[?25l\x1b[12;3H \x1b[?25h';
    activity.onData(P, blink.repeat(12));
    pb.onPtyData(P, blink.repeat(12));
  }
  eq(reason(P), 'permission', 'a dialog left up stays blocked however long its cursor blinks (no distance/time rule)');
  eq(activity.get(P), 'waiting', '...and the blink never reads as streaming');
  pb.onHook(P, 'UserPromptSubmit');
  eq(reason(P), null, 'a UserPromptSubmit hook clears it');
  activity.drop(P);
  pb.drop(P);
}

console.log('\n[CC 2.1.285 permission dialog, answered]');
{
  const P = 'cc:perm-answered';
  pb.arm(P, 'claude-code');
  const recs = cc('permission-answered');
  const seen = play(P, recs);
  const at = firstWith(recs, 'proceed?');
  eq(seen[at], 'permission', 'blocked the moment the dialog draws');
  eq(seen[seen.length - 1], null, 'answered: the composer footer came back — clear');
  const back = seen.lastIndexOf('permission');
  eq(back >= at && back < seen.length - 1, true, 'it cleared at the redraw that followed the answer, not before');
  pb.drop(P);
}

console.log('\n[CC 2.1.285 AskUserQuestion picker]');
{
  const P = 'cc:question';
  pb.arm(P, 'claude-code');
  activity.onLive(P);
  const recs = cc('question');
  const seen = play(P, recs);
  const at = firstWith(recs, 'Chat');
  eq(at > 0, true, 'the recording draws the picker');
  eq(seen.slice(0, firstWith(recs, 'Type')).every((x) => x === null), true, 'the busy screen before it (thinking…) is never blocked');
  eq(seen[seen.length - 1], 'question', 'the questionnaire: needs you — question');
  eq(activity.get(P), 'waiting', 'ring: waiting');
  pb.onHook(P, 'Stop');
  eq(reason(P), null, 'a Stop hook clears it');
  activity.drop(P);
  pb.drop(P);
}

console.log('\n[CC 2.1.282 normal sessions (vscreen recordings): never blocked]');
for (const name of ['r5-startup', 'r1-trust']) {
  const P = `cc:normal:${name}`;
  pb.arm(P, 'claude-code');
  const seen = play(P, rec(`vscreen/cc-2.1.282-pty/${name}.jsonl`));
  eq(seen.every((x) => x === null), true, `${name}: no chunk reads as needs-you (startup prompts are the startup gate's)`);
  pb.drop(P);
}
{
  /* r6 (chan-probe, 2.1.282) holds a REAL in-turn MCP tool approval — "Tool
     use probe — Reply … Do you want to proceed? ❯ 1. Yes 2. Yes, and don't
     ask again …" — answered a few seconds later. A second, independent
     recording (an older CC, an MCP tool rather than Bash) of the same rule. */
  const P = 'cc:normal:r6-draft';
  pb.arm(P, 'claude-code');
  const recs = rec('vscreen/cc-2.1.282-pty/r6-draft.jsonl');
  const seen = play(P, recs);
  const at = firstWith(recs, 'proceed?');
  eq(seen.slice(0, at).every((x) => x === null), true, 'r6-draft (2.1.282): the session before its MCP tool approval is never blocked');
  eq(seen[at], 'permission', '...the MCP tool approval is a permission block');
  eq(seen[seen.length - 1], null, '...and answered, its composer back: clear');
  pb.drop(P);
}

console.log('\n[quoted marker text clears itself]');
{
  const P = 'cc:quoted';
  pb.arm(P, 'claude-code');
  pb.onPtyData(P, '● The error text is "Please run /login" in that build.\r\n');
  eq(reason(P), 'login', 'quoted login text reads as login while it is current (the safe direction)');
  pb.onPtyData(P, 'x'.repeat(pb.LOGIN_CURRENT_CHARS + 10));
  eq(reason(P), null, `...and clears once ${pb.LOGIN_CURRENT_CHARS} characters of other output follow it`);
  pb.onPtyData(P, '● it would ask "Do you want to proceed?" there\r\n');
  eq(reason(P), 'permission', 'quoted dialog text reads as permission...');
  pb.onPtyData(P, `${'─'.repeat(200)}\r\n❯ \r\n${'─'.repeat(200)}\r\n  ⏸ manual mode on · ? for shortcuts`);
  eq(reason(P), null, '...until the composer footer draws after it');
  pb.drop(P);
}

console.log('\n[a footer inside the dialog frame does not clear it]');
{
  const P = 'cc:veto';
  pb.arm(P, 'claude-code');
  pb.onPtyData(P, 'Do you want to proceed? ❯ 1. Yes 2. No ? for shortcuts');
  eq(reason(P), 'permission', 'a footer within 160 chars after dialog text is that frame, not the composer');
  pb.drop(P);
}

console.log('\n[hooks]');
{
  const P = 'cc:hooks';
  pb.arm(P, 'claude-code');
  pb.onHook(P, 'Notification', 'idle_prompt');
  eq(reason(P), null, 'idle_prompt is not an ask');
  pb.onHook(P, 'Notification', 'permission_prompt');
  eq(reason(P), 'permission', 'permission_prompt raises permission (a dialog no marker knows is still seen)');
  pb.onPtyData(P, `${'─'.repeat(200)} ❯ ${'─'.repeat(200)} ⏵⏵ auto mode on (shift+tab to cycle)`);
  eq(reason(P), null, 'a composer footer drawn after it clears it');
  pb.onHook(P, 'Notification', 'elicitation_dialog');
  eq(reason(P), 'question', 'any other notification type raises question');
  pb.onHook(P, 'Stop');
  eq(reason(P), null, 'Stop clears it');
  pb.onPtyData(P, 'Not logged in · Please run /login');
  pb.onHook(P, 'Stop');
  eq(reason(P), null, 'Stop clears login (an API failure ends a turn with StopFailure, not Stop)');
  pb.onHook('cc:unarmed', 'Notification', 'permission_prompt');
  eq(reason('cc:unarmed'), 'permission', 'a hook-only ask on a pane never armed still counts');
  pb.onHook('cc:unarmed', 'UserPromptSubmit');
  eq(reason('cc:unarmed'), null, '...and a turn hook clears it');
  pb.drop(P);
  pb.drop('cc:unarmed');
}

console.log('\n[adoption: seed() reads the replay tail]');
{
  const open = cc('permission-open').map((r) => r.data).join('');
  pb.seed('cc:adopt-open', 'claude-code', open);
  eq(reason('cc:adopt-open'), 'permission', 'a pane adopted while its dialog was up says so at once');
  const answered = cc('permission-answered').map((r) => r.data).join('');
  pb.seed('cc:adopt-done', 'claude-code', answered);
  eq(reason('cc:adopt-done'), null, 'a pane adopted after the dialog was answered is clear');
  pb.drop('cc:adopt-open');
  pb.drop('cc:adopt-done');
}

console.log('\n[gemini-cli: gemini-gate\'s dialogs]');
{
  const P = 'g:auth';
  gemini.arm(P);
  pb.arm(P, 'gemini-cli');
  gemini.onPtyData(P, gchunk('dialog-auth'));
  pb.onPtyData(P, gchunk('dialog-auth'));
  eq(reason(P), 'login', 'the auth screen: needs you — login');
  gemini.onPtyData(P, gchunk('dialog-auth-waiting'));
  pb.onPtyData(P, gchunk('dialog-auth-waiting'));
  eq(reason(P), 'login', '"Waiting for authentication…" (a spinner that redraws): still login');
  gemini.onPtyData(P, gchunk('idle'));
  pb.onPtyData(P, gchunk('idle'));
  eq(reason(P), null, 'its composer again: clear');
  const Q = 'g:proceed';
  gemini.arm(Q);
  pb.arm(Q, 'gemini-cli');
  gemini.onPtyData(Q, gchunk('dialog-proceed'));
  pb.onPtyData(Q, gchunk('dialog-proceed'));
  eq(reason(Q), 'permission', '"Do you want to proceed?" / "Allow execution of": needs you — permission');
  gemini.onPtyData(Q, gchunk('busy'));
  pb.onPtyData(Q, gchunk('busy'));
  eq(reason(Q), null, 'busy (a normal generating screen): not blocked');
  gemini.onPtyData(Q, gchunk('dialog-proceed'));
  pb.onPtyData(Q, gchunk('dialog-proceed'));
  gemini.release(Q); // a human's deliver-held override (room-typer)
  pb.sync(Q);
  eq(reason(Q), null, 'the gate released by a human: sync() lifts it');
  pb.drop(P);
  pb.drop(Q);
  gemini.reset();
}

console.log('\n[CC usage-limit menu (ticket follow-up, Owner 2026-09-30)]');
{
  /* SYNTHETIC, not a recording: no rate-limited account can be driven from a
     scratch pty without touching Owner's sessions. The text is the two panes'
     screenshots (rooms/briefing-table-workrooms-8e04befa/Pasted image 15-22,
     15-23) with the escape sequences CC draws a menu with; the option labels
     are the installed CC 2.1.286 binary's own strings. The live panes left on
     the menu are the acceptance test after deploy. */
  const E = '\x1b';
  const rule = `${E}[2m${'─'.repeat(118)}${E}[22m\r\n`;
  const error = `  ⎿  ${E}[35mYou've hit your weekly limit · resets Oct 3, 8pm (America/Los_Angeles)${E}[39m\r\n     ${E}[2mUse your limit reset to reset it now: clau.de/reset${E}[22m\r\n\r\n`;
  const cmd = `${E}[48;5;237m  /rate-limit-options ${E}[49m\r\n\r\n`;
  const menu = `${rule}  ${E}[1mWhat do you want to do?${E}[22m\r\n\r\n  ${E}[36m❯ 1. Stop and wait for limit to reset${E}[39m\r\n    2. Wait here, then continue automatically at Oct 3, 8pm\r\n    3. Switch to usage credits\r\n\r\n  ${E}[3mEnter to confirm · Esc to cancel${E}[23m\r\n${rule}`;
  const blink = `${E}[?25l${E}[12;3H${E}[36m❯${E}[39m${E}[?25h`;
  const composer = `${rule}${E}[1m❯${E}[22m \r\n${rule}  ${E}[2m⏸ manual mode on · ? for shortcuts${E}[22m\r\n`;
  const P = 'cc:limit';
  pb.arm(P, 'claude-code');
  activity.onLive(P);
  activity.onData(P, error);
  pb.onPtyData(P, error);
  eq(reason(P), null, 'the "You\'ve hit your weekly limit" error alone is not a block (it stays in scrollback after the menu closes)');
  activity.onData(P, cmd + menu);
  pb.onPtyData(P, cmd + menu);
  eq(reason(P), 'limit', 'the menu ("Stop and wait for limit to reset" …): needs you — limit');
  eq(activity.get(P), 'waiting', 'the ring reads waiting (coral "needs you")');
  pb.onHook(P, 'UserPromptSubmit');
  eq(reason(P), 'limit', 'the /rate-limit-options submit hook arriving AFTER the menu does not clear it (the lead\'s 3:20 PM race)');
  for (let i = 0; i < 40; i++) {
    activity.onData(P, blink);
    pb.onPtyData(P, blink);
  }
  eq(reason(P), 'limit', 'the menu\'s cursor redraws keep it blocked');
  activity.ack(P, 'input');
  eq(activity.get(P), 'waiting-seen', 'a human looked (ack): the alarm quiets to waiting-seen (v33), the block kept');
  eq(reason(P), 'limit', '...the block stays (the room + manager keep "needs you: limit")');
  eq(typer.blockReason({
    enabled: true, live: true, vendor: 'claude-code', claude: true, startup: false, state: 'idle', busy: false,
    draft: 'clean' as const, now: 10_000, lastOutputAt: 0, settleMs: 1500, awaitingIdle: false, blocked: reason(P),
  }), 'needs-you', 'room lines are held: a typed line + Enter would pick "Stop and wait"');
  activity.onData(P, composer);
  pb.onPtyData(P, composer);
  eq(reason(P), null, 'the composer\'s footer drawn after the menu (answered or Esc): clear');
  activity.onData(P, cmd + menu);
  pb.onPtyData(P, cmd + menu);
  eq(reason(P), 'limit', 'the menu again: limit');
  pb.onHook(P, 'Stop');
  eq(reason(P), null, 'a Stop hook (a turn the API answered) clears it');
  activity.drop(P);
  pb.drop(P);

  /* The two live panes were ON the menu when the engine restarted: seed()
     must flag them from the replay, before their next byte. */
  const Q = 'cc:limit-adopted';
  const history = `${E}[2J${E}[H● Agent(Shell: tab MRU + Alt+Tab messages)\r\n  ⎿  Backgrounded agent\r\n\r\n`.repeat(30);
  pb.seed(Q, 'claude-code', history + error + `✻ Waiting for 1 background agent to finish\r\n\r\n` + cmd + menu + blink.repeat(20));
  eq(reason(Q), 'limit', 'adopted on engine boot sitting on the menu: needs you — limit from the replay');
  pb.drop(Q);
  const R = 'cc:limit-adopted-answered';
  pb.seed(R, 'claude-code', history + error + cmd + menu + `${E}[2m  Stopped. Waiting for limit to reset.${E}[22m\r\n\r\n` + composer);
  eq(reason(R), null, 'adopted after the menu was answered (composer back): not blocked');
  pb.drop(R);
  eq(heldWord({ reason: 'needs-you', blocked: 'limit' }), 'needs you (limit)', 'held words: "needs you (limit)"');
}

console.log('\n[room-typer: the needs-you hold]');
{
  const base = {
    enabled: true, live: true, vendor: 'claude-code', claude: true, startup: false, state: 'idle', busy: false,
    draft: 'clean' as const, now: 10_000, lastOutputAt: 0, settleMs: 1500, awaitingIdle: false,
  };
  eq(typer.blockReason({ ...base }), null, 'control: typeable');
  eq(typer.blockReason({ ...base, blocked: 'login' }), 'needs-you', 'blocked: held needs-you (a typed line + Enter would answer the prompt)');
  eq(typer.blockReason({ ...base, blocked: 'permission', state: 'streaming' }), 'needs-you', '...whatever the ring says');
  eq(typer.blockReason({ ...base, blocked: 'question', startup: true }), 'startup', 'startup is still named first');
  eq(heldWord({ reason: 'needs-you', blocked: 'login' }), 'needs you (login)', 'held words: "needs you (login)"');
  eq(heldWord({ reason: 'needs-you', blocked: 'permission' }), 'needs you (permission)', 'held words: "needs you (permission)"');
  eq(heldWord({ reason: 'needs-you' }), 'needs you', 'held words without a reason: "needs you"');
}

console.log('\n[diag — kinds and counts only, never screen text]');
{
  const P = 'cc:diag';
  pb.arm(P, 'claude-code');
  pb.onPtyData(P, 'Not logged in · Please run /login');
  const d = JSON.stringify(pb.diag());
  eq(d.includes('"login"'), true, 'diag names the reason');
  eq(d.includes('Please run'), false, 'diag never carries the matched screen text');
  pb.drop(P);
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
