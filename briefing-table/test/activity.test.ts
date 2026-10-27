/**
 * What counts as a session "doing something".
 *
 * This exists because the ring lied for hours at a time and nobody could see
 * why. Owner, 2026-09-01: "kiosk shows an animated icon on the cli manager
 * page when it's idle, and homehub shows a similar icon but not animated and
 * it's been active." Both halves came from one defect. Claude Code blinks the
 * TERMINAL TITLE when a session wants attention — an OSC write of ~29 bytes
 * every ~300ms, emitted precisely because nothing is happening — and the old
 * accumulator counted every pty byte and only ever reset on a gap longer than
 * QUIET_MS. A trickle that never leaves a gap therefore added up forever,
 * crossed the 600-byte floor, and then held the decay sweep off indefinitely.
 *
 * Kiosk's real numbers, read live from /api/diag/activity:
 *   burstBytes 145 -> 261 -> 377 -> 522 -> 638 -> 754 -> 899 -> 1015 -> 1276
 *   sinceDataMs never once above 900ms
 *
 * The second half is downstream: the CLI Manager animates exactly ONE ring per
 * list (the design system aggregate rule), so one pane falsely claiming `streaming`
 * SILENCES the pane that genuinely is. A false positive here is not a cosmetic
 * error, it is a stolen signal.
 *
 * Run with tsx.
 */
process.env.HARBOR_WB_ACT_QUIET_MS = '150';
process.env.HARBOR_WB_ACT_MIN_BYTES = '600';
// v21 three-way tuning, shrunk so the suite runs in seconds (sweep ticks 500ms)
process.env.HARBOR_WB_ACT_BG_PERSIST_MS = '300';
process.env.HARBOR_WB_ACT_BG_WINDOW_MS = '800';
process.env.HARBOR_WB_ACT_BG_QUIET_MS = '400';
process.env.HARBOR_WB_ACT_BG_GAP_MS = '200';
process.env.HARBOR_WB_ACT_ECHO_MS = '50';
process.env.HARBOR_WB_ACT_TURN_WATCHDOG_MS = '700';

const activity = await import('../src/engine/activity.ts');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed += 1;
    console.log(`  ✓ ${msg} (${String(actual)})`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One frame of Claude Code's attention blink, as it arrives on the wire. */
const BLINK = '\x1b]0;◘ Kiosk project setup\x07';

console.log('\n[terminal chrome is not output]');
activity.onLive('blink');
for (let i = 0; i < 60; i += 1) {
  activity.onData('blink', BLINK); // ~1700 bytes, far past the 600 floor
}
eq(activity.get('blink'), 'idle', 'a title blink never reads as streaming, however long it runs');
eq(activity.dump().find((p) => p.paneid === 'blink')?.burstBytes, 0, 'and contributes no burst bytes');

console.log('\n[real output still reads as streaming]');
activity.onLive('loud');
activity.onData('loud', 'x'.repeat(700));
eq(activity.get('loud'), 'streaming', '700 bytes of body text');

console.log('\n[content mixed with chrome counts only the content]');
activity.onLive('mixed');
activity.onData('mixed', BLINK + 'y'.repeat(599) + BLINK);
eq(activity.get('mixed'), 'idle', '599 content bytes stays below the floor despite two title writes');
activity.onData('mixed', 'y');
eq(activity.get('mixed'), 'streaming', 'the 600th content byte crosses it');

console.log('\n[an OSC split across chunks is still one sequence]');
activity.onLive('split');
activity.onData('split', BLINK.slice(0, 6));
activity.onData('split', BLINK.slice(6));
eq(activity.dump().find((p) => p.paneid === 'split')?.burstBytes, 0,
  'the tail of a sequence is not counted as body text');

console.log('\n[the window is a RATE, not an odometer — the Kiosk defect]');
activity.onLive('trickle');
for (let i = 0; i < 4; i += 1) {
  activity.onData('trickle', 'z'.repeat(200)); // 800 bytes total, 600 floor
  await sleep(200); // > QUIET_MS, so each 200 lands in its own window
}
eq(activity.get('trickle'), 'idle',
  '800 content bytes spread across four windows never claims streaming');

console.log('\n[streaming still decays once output stops]');
activity.onLive('decay');
activity.onData('decay', 'x'.repeat(700));
eq(activity.get('decay'), 'streaming', 'still streaming before the quiet window elapses');
await sleep(900);
eq(activity.get('decay'), 'idle', 'decays to idle after the sweep sees the gap');

console.log('\n[a blink cannot erase the state it is nagging about]');
activity.onLive('asking');
activity.onQuestion('asking');
for (let i = 0; i < 60; i += 1) {
  activity.onData('asking', BLINK);
}
eq(activity.get('asking'), 'waiting',
  'the nag that means "come here" does not overwrite itself with "busy"');

/* ---- ATTENTION (2026-09-04) ------------------------------------------- */

console.log('\n[attention clears the ALARM but never the ask]');
activity.onLive('seen');
activity.onQuestion('seen');
eq(activity.get('seen'), 'waiting', 'an ask raises the alarm');
activity.ack('seen', 'focus');
eq(activity.get('seen'), 'idle', 'a human arriving silences it');
eq(activity.dump().find((x) => x.paneid === 'seen')?.question, true,
  'the ask itself SURVIVES being seen (it is still listed)');
eq(activity.dump().find((x) => x.paneid === 'seen')?.acknowledged, true,
  'and is marked seen');

console.log('\n[a seen alert must not come back by itself]');
activity.onData('seen', 'y'.repeat(700));
eq(activity.get('seen'), 'streaming', 'output still moves the state');
await sleep(900);
eq(activity.get('seen'), 'idle',
  'the decay sweep does NOT re-raise an ask a human already looked at');

console.log('\n[an UNSEEN ask does come back — it is still unanswered]');
activity.onLive('unseen');
activity.onQuestion('unseen');
activity.onData('unseen', 'y'.repeat(700));
eq(activity.get('unseen'), 'streaming', 'output moves it');
await sleep(900);
eq(activity.get('unseen'), 'waiting', 'and it returns to the alarm, nobody having seen it');

console.log('\n[an alert no longer times out on output alone]');
activity.onLive('noTimeout');
activity.onQuestion('noTimeout');
for (let i = 0; i < 5; i += 1) {
  activity.onData('noTimeout', 'q'.repeat(700));
}
eq(activity.dump().find((x) => x.paneid === 'noTimeout')?.question, true,
  'bytes flowing is not a witness — the ask stands until acked or Stopped');

console.log('\n[typing IS attention]');
activity.onLive('typer');
activity.onQuestion('typer');
activity.onInput('typer', 'y');
eq(activity.get('typer'), 'idle', 'a keystroke into a blocked pane silences the alarm');

console.log('\n[a NEW ask re-arms an acknowledged pane]');
activity.onQuestion('typer');
eq(activity.get('typer'), 'waiting', 'the next question raises the alarm again');
eq(activity.dump().find((x) => x.paneid === 'typer')?.acknowledged, false, 'and clears "seen"');

console.log('\n[keystrokes cannot evict the events worth keeping]');
activity.onLive('flood');
activity.onQuestion('flood');
for (let i = 0; i < 5000; i += 1) {
  activity.onInput('flood', 1);
}
const kept = activity.history({ paneid: 'flood' });
eq(kept.some((e) => e.kind === 'hook' && /Notification/.test(e.detail ?? '')), true,
  '5000 keystrokes do not evict the hook that explains the alert');
const inputRecords = kept.filter((e) => e.kind === 'input').length;
eq(inputRecords < 50, true,
  `and they coalesce instead of filling the log (${inputRecords} records)`);

/* ---- THREE-WAY ACTIVITY (v21) ----------------------------------------- */

console.log('\n[a turn is busy from UserPromptSubmit to Stop]');
activity.onLive('turn');
activity.onTurnStart('turn');
eq(activity.get('turn'), 'streaming', 'UserPromptSubmit -> busy (streaming token) with no bytes at all');
await sleep(900);
eq(activity.get('turn'), 'streaming', 'a quiet turn (model thinking) stays busy through the decay sweep');
activity.onResponseDone('turn');
eq(activity.get('turn'), 'idle', 'Stop ends the turn');

console.log('\n[background enters by PERSISTENCE]');
activity.onLive('bgp');
activity.onTurnStart('bgp');
activity.onResponseDone('bgp');
for (let i = 0; i < 5; i += 1) {
  activity.onData('bgp', 'w'); // one continuous run: gaps ~80ms < BG_GAP 200ms
  eq(activity.get('bgp'), i < 4 ? 'idle' : 'background', `after ~${i * 80}ms of continuous output`);
  await sleep(80);
}

console.log('\n[background enters by TWO BURSTS within the window]');
activity.onLive('bgb');
activity.onTurnStart('bgb');
activity.onResponseDone('bgb');
activity.onData('bgb', 'line one\n');
eq(activity.get('bgb'), 'idle', 'one isolated burst is not enough');
await sleep(250); // > BG_GAP: a separate burst
activity.onData('bgb', 'line two\n');
eq(activity.get('bgb'), 'background', 'a second burst within the window enters background');

console.log('\n[background leaves only after its quiet window]');
await sleep(250);
eq(activity.get('bgb'), 'background', 'still background before BG_QUIET elapses');
await sleep(900);
eq(activity.get('bgb'), 'idle', 'leaves after BG_QUIET of quiet');
eq(activity.history({ paneid: 'bgb' }).some((e) => /^bg:leave/.test(e.detail ?? '')), true,
  'the transition log records bg:leave');

console.log('\n[busy SUBSUMES background]');
activity.onLive('sub');
activity.onTurnStart('sub');
for (let i = 0; i < 6; i += 1) {
  activity.onData('sub', 'v'.repeat(50));
  await sleep(120);
}
eq(activity.get('sub'), 'streaming', 'output during a turn is the turn, never background');

console.log('\n[the busy watchdog drops a turn whose Stop was lost]');
activity.onLive('dog');
activity.onTurnStart('dog');
await sleep(1400); // > watchdog 700ms + a sweep tick
eq(activity.get('dog'), 'idle', 'no Stop and no bytes for the watchdog window -> not busy');
eq(activity.dump().find((x) => x.paneid === 'dog')?.turn, false, 'the turn flag is dropped');
eq(activity.history({ paneid: 'dog' }).some((e) => e.kind === 'state' && e.detail === 'watchdog'), true,
  'the transition log records the watchdog as the cause');

console.log('\n[a pane that never sent UserPromptSubmit keeps the byte rule]');
activity.onLive('legacy');
activity.onData('legacy', 'x'.repeat(700));
eq(activity.get('legacy'), 'streaming', 'content bytes -> streaming, exactly as before');
eq(activity.dump().find((x) => x.paneid === 'legacy')?.turnAware, false, 'and it is not turn-aware');
await sleep(900);
eq(activity.get('legacy'), 'idle', 'and decays exactly as before');

console.log('\n[a keystroke echo is not background]');
activity.onLive('echo');
activity.onTurnStart('echo');
activity.onResponseDone('echo');
for (let i = 0; i < 4; i += 1) {
  activity.onInput('echo', 1);
  activity.onData('echo', 'c'.repeat(2295)); // claude's composer repaint
  await sleep(150);
}
eq(activity.get('echo'), 'idle', 'typing a prompt between turns does not read as background');

console.log('\n[an unseen ask outranks background chatter]');
activity.onLive('askbg');
activity.onTurnStart('askbg');
activity.onResponseDone('askbg');
activity.onQuestion('askbg');
activity.onData('askbg', 'a');
await sleep(250);
activity.onData('askbg', 'b');
eq(activity.get('askbg'), 'waiting', 'a watcher printing does not hide "needs you"');

/* ---- ONLY TYPING ACKS [ticket] --------------------------------------
 * 2026-09-30: an engine restart replayed a blocked pane's buffer into its
 * reattaching window; the window's xterm ANSWERED the colour queries in it
 * (`input 30B x6`), and `ack:input` cleared a questionnaire's alarm with
 * nobody at the keyboard. A terminal's reply is not a human arriving. */
const E = String.fromCharCode(27);
const ST = E + String.fromCharCode(92); // ESC backslash
const BEL = String.fromCharCode(7);
const REPLIES: Array<[string, string]> = [
  ['OSC 11 background colour', `${E}]11;rgb:1f1f/2323/2a2a${ST}`],
  ['OSC 10 foreground colour (BEL)', `${E}]10;rgb:e6e6/e6e6/e6e6${BEL}`],
  ['OSC 12 cursor colour', `${E}]12;rgb:ffff/ffff/ffff${ST}`],
  ['OSC 4 palette entry', `${E}]4;1;rgb:cdcd/3131/3131${ST}`],
  ['DA1', `${E}[?1;2c`],
  ['DA2', `${E}[>0;276;0c`],
  ['CPR', `${E}[24;80R`],
  ['DECRPM (private)', `${E}[?2004;1$y`],
  ['DECRPM (ANSI)', `${E}[4;2$y`],
  ['XTVERSION (DCS)', `${E}P>|xterm.js(6.0.0)${ST}`],
  ['XTWINOPS size report', `${E}[8;24;80t`],
  ['focus in', `${E}[I`],
  ['focus out', `${E}[O`],
  ['SGR mouse press', `${E}[<0;10;5M`],
];
let rp = 0;
/** A fresh pane blocked on a question, alarm up. */
function blockedPane(): string {
  const id = `reply-${++rp}`;
  activity.onLive(id);
  activity.setBlocked(id, { reason: 'question', since: Date.now() });
  return id;
}
const acked = (id: string): boolean => activity.dump().find((x) => x.paneid === id)?.acknowledged === true;

console.log('\n[a terminal reply is not a human arriving: each alone]');
for (const [name, r] of REPLIES) {
  const id = blockedPane();
  eq(activity.onInput(id, r), false, `${name}: not typing`);
  eq(activity.get(id) === 'waiting' && !acked(id), true, `${name}: the alarm stays up`);
}

console.log('\n[...split across two messages, at every point past the introducer]');
for (const [name, r] of REPLIES) {
  if (r.length <= 3) {
    /* ESC [ I split as ESC [ | I is Alt+[ then I, by construction: a
       two-byte introducer is a whole key. xterm never splits a reply. */
    continue;
  }
  let allQuiet = true;
  for (let cut = 3; cut < r.length; cut++) {
    const id = blockedPane();
    const t1 = activity.onInput(id, r.slice(0, cut));
    const t2 = activity.onInput(id, r.slice(cut));
    if (t1 || t2 || acked(id) || activity.get(id) !== 'waiting') {
      allQuiet = false;
      console.log(`    cut at ${cut} acked`);
    }
  }
  eq(allQuiet, true, `${name}: no split point acks`);
}

console.log('\n[...six in a burst: as six messages (the incident) and as one]');
{
  const six = REPLIES.slice(0, 6).map(([, r]) => r);
  const a = blockedPane();
  for (const r of six) {
    activity.onInput(a, r);
  }
  eq(activity.get(a) === 'waiting' && !acked(a), true, 'six reply messages leave the alarm up');
  const b = blockedPane();
  eq(activity.onInput(b, six.join('')), false, 'six replies in one message are not typing');
  eq(activity.get(b) === 'waiting' && !acked(b), true, '...and leave the alarm up');
  const c = blockedPane();
  const all = REPLIES.map(([, r]) => r).join('');
  activity.onInput(c, all.slice(0, 40));
  activity.onInput(c, all.slice(40, 97));
  activity.onInput(c, all.slice(97));
  eq(activity.get(c) === 'waiting' && !acked(c), true, 'every reply type chunked arbitrarily leaves the alarm up');
}

console.log('\n[a real key IS a human arriving]');
{
  const a = blockedPane();
  eq(activity.onInput(a, '1'), true, 'a key is typing');
  eq(activity.get(a), 'waiting-seen', 'and it silences the alarm (seen, still blocked)');
  eq(activity.blockedOf(a)?.reason, 'question', 'but the prompt is still recorded (ask kept)');
  const b = blockedPane();
  eq(activity.onInput(b, `${E}[B`), true, 'an arrow key (a questionnaire answer) is typing');
  eq(activity.get(b), 'waiting-seen', 'and silences the alarm');
  const c = blockedPane();
  eq(activity.onInput(c, `${E}[?1;2cx`), true, 'a reply AND a key in one message is typing');
  eq(activity.get(c), 'waiting-seen', 'and silences the alarm');
  const d = blockedPane();
  activity.onInput(d, `${E}]11;rgb:1f1f/`);
  eq(activity.onInput(d, `2323/2a2a${ST}x`), true, 'a split reply whose second half carries a key is typing');
  eq(activity.get(d), 'waiting-seen', 'and silences the alarm');
  const n = blockedPane();
  eq(activity.onInput(n, 5), false, 'a bare byte count cannot be classified');
  eq(activity.get(n), 'waiting', 'so it acks nothing');
}

console.log('\n[the incident: blocked -> replayed replies -> a typed key]');
{
  const id = 'incident';
  activity.onLive(id);
  activity.setBlocked(id, { reason: 'question', since: Date.now() });
  eq(activity.get(id), 'waiting', 'blocked:question raises the alarm');
  for (let i = 0; i < 6; i++) {
    activity.onInput(id, `${E}]4;${i};rgb:1f1f/2323/2a2a${ST}`); // the reattaching window answers the replay
  }
  eq(activity.get(id), 'waiting', 'six replayed replies later: STILL waiting');
  eq(activity.history({ paneid: id }).some((e) => /^ack:/.test(e.detail ?? '')), false, 'no ack in the log');
  activity.onInput(id, '2'); // Owner picks an answer
  eq(activity.get(id), 'waiting-seen', 'a typed key: the alarm is cleared (seen, still blocked)');
  eq(activity.blockedOf(id)?.reason, 'question', 'and `blocked` is kept (the prompt is still on screen)');
  eq(activity.history({ paneid: id }).some((e) => e.detail === 'ack:input (alarm cleared, ask kept)'), true,
    'the log says the typing cleared it');
}

/* ---- NEEDS YOU, SEEN (window-chrome v33, ticket) ----------------------
 * An acked SCREEN block used to rest at `idle`, so an unanswered prompt looked
 * like a finished session on every ring. It now rests at `waiting-seen`: the
 * alarm is off, the block is still said. A hook-only `question` (which is
 * also claude's idle nag) keeps resting where it did — see the [typing IS
 * attention] case above, still `idle`. */
console.log('\n[blocked -> waiting -> ack -> waiting-seen]');
{
  const id = 'seen-block';
  activity.onLive(id);
  activity.setBlocked(id, { reason: 'permission', since: Date.now() });
  eq(activity.get(id), 'waiting', 'a new block raises the alarm');
  activity.ack(id, 'focus');
  eq(activity.get(id), 'waiting-seen', 'seen, not answered: waiting-seen, not idle');
  eq(activity.history({ paneid: id }).some((e) => e.kind === 'state' && e.to === 'waiting-seen' && e.detail === 'ack:focus'), true,
    'the transition log names the ack');
  activity.onData(id, 'r'.repeat(900)); // the prompt repainting itself
  eq(activity.get(id), 'waiting-seen', "the prompt's own repaint does not move it");
  await sleep(700);
  eq(activity.get(id), 'waiting-seen', 'and the sweep does not re-raise or drop it');
  activity.ack(id, 'focus');
  eq(activity.get(id), 'waiting-seen', 'a second ack changes nothing');
}

console.log('\n[the block clears -> the normal state]');
{
  const a = 'seen-clear-idle';
  activity.onLive(a);
  activity.setBlocked(a, { reason: 'question', since: Date.now() });
  activity.ack(a, 'input');
  activity.setBlocked(a, null); // the footer redraw: the prompt is gone
  eq(activity.get(a), 'idle', 'no turn running: idle');
  const b = 'seen-clear-turn';
  activity.onLive(b);
  activity.onTurnStart(b);
  activity.setBlocked(b, { reason: 'permission', since: Date.now() });
  eq(activity.get(b), 'waiting', 'a permission dialog inside a turn: the alarm');
  activity.ack(b, 'input');
  eq(activity.get(b), 'waiting-seen', 'seen: still blocked, not busy');
  activity.setBlocked(b, null); // answered: the turn resumes
  eq(activity.get(b), 'streaming', 'the turn is running again: streaming');
  const c = 'seen-clear-stop';
  activity.onLive(c);
  activity.setBlocked(c, { reason: 'question', since: Date.now() });
  activity.ack(c, 'input');
  activity.onResponseDone(c);
  eq(activity.get(c), 'idle', 'Stop: the agent says it is done -> idle');
  const d = 'seen-clear-submit';
  activity.onLive(d);
  activity.setBlocked(d, { reason: 'question', since: Date.now() });
  activity.ack(d, 'input');
  activity.setBlocked(d, null);
  activity.onTurnStart(d);
  eq(activity.get(d), 'streaming', 'UserPromptSubmit: a turn -> streaming');
}

console.log('\n[a NEW block after a seen one -> waiting again, ack reset]');
{
  const id = 'seen-new';
  activity.onLive(id);
  activity.setBlocked(id, { reason: 'question', since: Date.now() });
  activity.ack(id, 'input');
  eq(activity.get(id), 'waiting-seen', 'the first block, seen');
  activity.setBlocked(id, { reason: 'permission', since: Date.now() });
  eq(activity.get(id), 'waiting', 'a different prompt is a new ask: the alarm again');
  eq(activity.dump().find((x) => x.paneid === id)?.acknowledged, false, 'and "seen" is reset');
  activity.ack(id, 'input');
  activity.setBlocked(id, null);
  activity.setBlocked(id, { reason: 'permission', since: Date.now() });
  eq(activity.get(id), 'waiting', 'the same reason coming back after a clear is new too');
}

console.log('\n[tuning is reported]');
eq(activity.tuning().bgQuietMs, 400, 'bgQuietMs is exposed for /api/diag/activity');

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
