/**
 * The voice channel's guards in activity.ts (ticket, the design notes §3c):
 *
 *   The draft rule — "has the USER typed something since the last submitting Enter",
 *           classified from the input the WS handler passes to onInput.
 *   BUSY  — a turn is running, or a dialog came up inside one (questionInTurn).
 *
 * Every classification case the lead named is here, including the Enters that
 * do NOT submit (paste, ESC CR, backslash-Enter, the keypad's ⏎+) — counting
 * any of them as a submit would clear the draft in the UNSAFE direction.
 *
 * Run with tsx.
 */
process.env.HARBOR_WB_ACT_TURN_WATCHDOG_MS = '300';
process.env.HARBOR_WB_ACT_SPLIT_MS = '100'; // a held split-reply fragment expires fast here

const activity = await import('../src/engine/activity.ts');

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

const ESC = String.fromCharCode(27);
const BS = String.fromCharCode(92); // backslash, never typed as a literal
let n = 0;
/** A fresh pane with `inputs` fed in order; returns its draft state. */
function after(...inputs: string[]): string {
  const P = `pane-${++n}`;
  for (const i of inputs) {
    activity.onInput(P, i);
  }
  return activity.draftState(P);
}

console.log('\n[unobserved until the user types]');
eq(activity.draftState('never'), 'unobserved', 'no input → unobserved (the caller decides clean vs unknown)');
eq(activity.hasDraft('never'), false, 'hasDraft is false for unobserved');
activity.onInput('counted', 5);
eq(activity.draftState('counted'), 'unobserved', 'a byte COUNT (old callers) classifies nothing');

console.log('\n[typing sets it, a submitting Enter clears it]');
eq(after('h', 'ello'), 'draft', 'keystrokes → draft');
eq(after('hello', '\r'), 'clean', 'Enter submits → clean');
eq(after('ls -la\r'), 'clean', '"text + CR" in one chunk → clean');
eq(after('done\rnext'), 'draft', 'text after the last Enter → draft');
eq(after('\r'), 'clean', 'a bare Enter → clean');

console.log('\n[NOT typing: focus reports and mouse reports]');
eq(after(`${ESC}[I`), 'unobserved', 'focus-in ESC[I');
eq(after(`${ESC}[O`), 'unobserved', 'focus-out ESC[O');
eq(after(`${ESC}[<0;12;7M${ESC}[<0;12;7m`), 'unobserved', 'SGR mouse press/release');
eq(after(`${ESC}[M abc`.slice(0, 6)), 'unobserved', 'X10 mouse report ESC[M + 3 bytes');
eq(after('x\r', `${ESC}[I`, `${ESC}[O`), 'clean', 'focus reports do not dirty a clean line');
eq(after('half', `${ESC}[O`, `${ESC}[I`), 'draft', '...and do not clear a draft');

console.log('\n[NOT typing: the terminal answering a query (S0 ride fix, guard 6c)]');
const BSL = String.fromCharCode(92);
const BEL = String.fromCharCode(7);
eq(after(`${ESC}[?1;2c`), 'unobserved', 'DA1 reply ESC[?1;2c (xterm answers claude\'s ESC[c)');
eq(after(`${ESC}[>0;276;0c`), 'unobserved', 'DA2 reply');
eq(after(`${ESC}[12;40R`), 'unobserved', 'CPR reply');
eq(after(`${ESC}[0n`), 'unobserved', 'DSR reply');
eq(after(`${ESC}[?2004;1$y`, `${ESC}[4;2$y`), 'unobserved', 'DECRPM replies (private and ANSI)');
eq(after(`${ESC}[?1u`), 'unobserved', 'kitty keyboard flags reply');
eq(after(`${ESC}]11;rgb:0000/0000/0000${ESC}${BSL}`, `${ESC}]10;rgb:ffff/ffff/ffff${BEL}`), 'unobserved', 'OSC colour replies (ST and BEL)');
eq(after(`${ESC}P>|xterm.js(6.0.0)${ESC}${BSL}`), 'unobserved', 'DCS XTVERSION reply: its text is not typing');
eq(after('x\r', `${ESC}[?1;2c`), 'clean', 'a reply does not dirty a clean line');
eq(after('half', `${ESC}[?1;2c`), 'draft', '...and does not clear a draft');
eq(after(`${ESC}[?1;2cab`), 'draft', 'keys after a reply in the same chunk still count');
eq(after(`${ESC}[A`), 'draft', 'an arrow is still a key (unknown)');
eq(activity.onInput('da1-pane', `${ESC}[?1;2c`), false, 'onInput: a DA1 reply is not typing (no human evidence)');
eq(activity.onInput('da1-pane', 'y'), true, 'onInput: a real key is');

console.log('\n[a reply SPLIT across messages is still not typing, and never marks a draft [ticket]]');
{
  const SPLIT_REPLIES = [
    `${ESC}]11;rgb:1f1f/2323/2a2a${ESC}${BSL}`,
    `${ESC}]10;rgb:e6e6/e6e6/e6e6${BEL}`,
    `${ESC}]4;1;rgb:cdcd/3131/3131${ESC}${BSL}`,
    `${ESC}[?1;2c`,
    `${ESC}[>0;276;0c`,
    `${ESC}[24;80R`,
    `${ESC}[?2004;1$y`,
    `${ESC}P>|xterm.js(6.0.0)${ESC}${BSL}`,
    `${ESC}[8;24;80t`,
    `${ESC}[<0;10;5M`,
  ];
  let bad = 0;
  for (const r of SPLIT_REPLIES) {
    for (let cut = 3; cut < r.length; cut++) {
      if (after(r.slice(0, cut), r.slice(cut)) !== 'unobserved') {
        bad++;
        console.log(`    ${JSON.stringify(r)} cut at ${cut} marked a draft`);
      }
    }
  }
  eq(bad, 0, 'no split point of any reply creates a draft entry');
  eq(after('x\r', `${ESC}]11;rgb:1f1f/`, `2323/2a2a${ESC}${BSL}`), 'clean', 'a split reply does not dirty a clean line');
  /* The count survives replies: 3 typed, a burst of split replies, 3 deletes → clean. */
  eq(after('abc', `${ESC}]11;rgb:1f`, `1f/2323/2a2a${ESC}`, `${BSL}${ESC}[?1;`, '2c', '\u007f\u007f\u007f'), 'clean',
    'replies between typing and deleting do not change the count');
  eq(after(SPLIT_REPLIES.join('')), 'unobserved', 'every reply in one message: no draft');
  const all = SPLIT_REPLIES.join('');
  eq(after(all.slice(0, 50), all.slice(50, 111), all.slice(111)), 'unobserved', '...and chunked anywhere: no draft');
  eq(after(`${ESC}]11;rgb:1f1f/`, `2323/2a2a${ESC}${BSL}hi`), 'draft', 'a key after a split reply still counts');
  eq(after(ESC), 'draft', 'a lone Esc is still the Esc key (never held as a fragment)');
  eq(after(`${ESC}]`), 'draft', 'bare ESC ] is Alt+] (never held)');
  eq(after(`${ESC}[`), 'draft', 'bare ESC [ is Alt+[ (never held)');
  /* A fragment the rest never follows is dropped, not classified, and cannot
     swallow the typing that comes after it. */
  const P = 'split-expiry';
  activity.onInput(P, `${ESC}]11;rgb:1f1f/`);
  eq(activity.draftState(P), 'unobserved', 'an unfinished fragment is held, not classified');
  await sleep(150); // > SPLIT_MS
  eq(activity.onInput(P, 'ok'), true, 'typing after the fragment expired is typing');
  eq(activity.draftState(P), 'draft', '...and counts as a draft');
  activity.onInput(P, '\u007f\u007f');
  eq(activity.draftState(P), 'clean', '...of exactly its own two characters (the fragment was dropped)');
}

console.log('\n[keys whose effect cannot be counted set it (tracking lost)]');
eq(after('\r', `${ESC}[A`), 'draft', 'up-arrow history recall fills the composer');
eq(after('\r', `${ESC}OA`), 'draft', 'SS3 arrow');
eq(after('\r', ESC), 'draft', 'a bare Esc (Esc Esc on an empty line opens the rewind selector)');
eq(after('\r', '\t'), 'draft', 'tab (completion inserts unknown text)');
eq(after('\r', '\u0012'), 'draft', 'Ctrl-R (history search)');
eq(after('\r', '\u001a'), 'draft', 'Ctrl-Z (suspends claude: the shell would run a typed line)');
eq(after('\r', `${ESC}[Z`), 'clean', 'Shift+Tab cycles the permission mode — no content change');
eq(after('ab', `${ESC}[Z`), 'draft', '...and leaves a real draft a draft');

console.log('\n[function keys: no content on claude-code, unknown on any other vendor (Owner 2026-10-11, #6866)]');
{
  /* The vendor is handed in. Here: cc-* is claude-code, cx-* is codex-cli, anything else has none. */
  activity.setVendorResolver((p) => (p.startsWith('cc-') ? 'claude-code' : p.startsWith('cx-') ? 'codex-cli' : null));
  let k = 0;
  const on = (prefix: string, ...inputs: string[]): string => {
    const P = `${prefix}-${++k}`;
    for (const i of inputs) {
      activity.onInput(P, i);
    }
    return activity.draftState(P);
  };
  const BKSP = String.fromCharCode(127);
  const F5 = `${ESC}[15~`;
  /* every form the real-claude probe sent (2.1.296: zero bytes back, no row changed) */
  const PROBED: Array<[string, string]> = [
    ['F1 SS3', `${ESC}OP`], ['F2 SS3', `${ESC}OQ`], ['F3 SS3', `${ESC}OR`], ['F4 SS3', `${ESC}OS`],
    ['F1 11~', `${ESC}[11~`], ['F2 12~', `${ESC}[12~`], ['F3 13~', `${ESC}[13~`], ['F4 14~', `${ESC}[14~`],
    ['F5', F5], ['F6', `${ESC}[17~`], ['F7', `${ESC}[18~`], ['F8', `${ESC}[19~`],
    ['F9', `${ESC}[20~`], ['F10', `${ESC}[21~`], ['F11', `${ESC}[23~`], ['F12', `${ESC}[24~`],
    ['Shift+F5', `${ESC}[15;2~`], ['Ctrl+F5', `${ESC}[15;5~`], ['Alt+F5', `${ESC}[15;3~`], ['Shift+F1', `${ESC}[1;2P`],
  ];
  for (const [name, seq] of PROBED) {
    eq(on('cc', seq), 'clean', `${name} on an empty claude box: clean`);
  }
  eq(activity.onInput('cc-human', F5), true, 'F5 is still TYPING (a human is at the keys)');
  eq(on('cc', 'ab', F5), 'draft', 'F5 leaves a real draft a draft');
  eq(on('cc', 'ab', F5, BKSP, BKSP), 'clean', '...and its count: two backspaces still empty the box');
  eq(on('cc', `${ESC}[A`, F5), 'draft', 'F5 does not clear a box whose content is unknown');
  eq(on('cc', `${ESC}[25~`), 'draft', 'F13 and up were not probed: unknown');
  eq(on('cc', `${ESC}Op`), 'draft', 'an SS3 keypad key is not an F-key: unknown');
  eq(on('cc', `${ESC}[1;2R`), 'unobserved', 'a modified F3 still reads as a CPR reply: not typing');
  eq(on('cx', F5), 'draft', 'codex-cli was not probed: F5 stays unknown');
  eq(on('cx', `${ESC}OP`), 'draft', '...and so does SS3 F1');
  eq(on('other', F5), 'draft', 'no vendor known: F5 stays unknown');
  activity.setVendorResolver(() => null); // the default, for every section below
}

console.log('\n[NET content: typed then deleted is clean (FIX 4a, 2026-09-25)]');
const DEL = '\u007f';
eq(after('abc', DEL, DEL, DEL), 'clean', 'three chars, three Backspaces → clean (the @auriga case)');
eq(after('abc', DEL + DEL), 'draft', 'three chars, two Backspaces → draft');
eq(after('ab', '\b\b'), 'clean', 'BS (0x08) counts as Backspace too');
eq(after('\r', DEL), 'clean', 'Backspace on an empty composer changes nothing');
eq(after('a', DEL, DEL, DEL, 'b'), 'draft', 'extra Backspaces never go below zero');
eq(after('hello there', '\u0015'), 'clean', 'Ctrl-U clears a one-line composer');
eq(after('\r', '\u0015'), 'clean', 'Ctrl-U on an empty composer: clean');
eq(after('line1', `${ESC}\r`, 'line2', '\u0015'), 'draft', 'Ctrl-U in a MULTI-line composer clears one line only → still draft');
eq(after('half a thought', '\u0003'), 'clean', 'Ctrl-C clears the input (no turn running)');
eq(after('\r', '\u0003'), 'clean', 'Ctrl-C on an empty composer: clean');
eq(after('😀', DEL), 'clean', 'a surrogate pair is ONE character');
eq(after(`${ESC}[200~pasted${ESC}[201~`, DEL.repeat(6)), 'clean', 'pasted text counts by length');
eq(after('abc', `${ESC}[D`, DEL, DEL, DEL), 'draft', 'a cursor move loses the cursor: Backspaces no longer trusted');
eq(after('abc', `${ESC}[D`, '\u0015'), 'draft', '...nor Ctrl-U');
eq(after('abc', `${ESC}[D`, '\u0003'), 'clean', '...but Ctrl-C clears the whole input whatever the cursor');
eq(after('abc', `${ESC}[D`, '\r'), 'clean', '...and a submit still submits');
eq(after('\r', '\u0017'), 'clean', 'Ctrl-W on an empty composer is a no-op');

console.log('\n[cursor and navigation keys add no content (live @auriga: Enter, then 3 arrows)]');
eq(after('\r', `${ESC}[D`, `${ESC}[C`, `${ESC}[D`), 'clean', 'Enter on an empty composer, then ←→← : still clean');
eq(after('\r', `${ESC}[H`, `${ESC}[F`, `${ESC}[5~`, `${ESC}[6~`), 'clean', 'Home, End, PgUp, PgDn: clean');
eq(after('\r', `${ESC}[1~`, `${ESC}[4~`, `${ESC}[2~`), 'clean', 'Home/End/Insert as ~ keys: clean');
eq(after('\r', `${ESC}OD`, `${ESC}OC`, `${ESC}OH`, `${ESC}OF`), 'clean', 'SS3 ←→ Home End: clean');
eq(after('\r', `${ESC}[1;5D`, `${ESC}[1;5C`), 'clean', 'Ctrl+← / Ctrl+→ (modifier params): clean');
eq(after('\r', '\u0001', '\u0005'), 'clean', 'Ctrl-A / Ctrl-E on an empty composer: clean');
eq(after('\r', `${ESC}[B`), 'draft', '↓ still dirties (history)');
eq(after('\r', `${ESC}[A`, '\r'), 'clean', '↑ then Enter: the recalled prompt was submitted');
eq(after('abc', `${ESC}[D`), 'draft', '← over content leaves the content a draft');
eq(after('abc', `${ESC}[D`, `${ESC}[F`, DEL, DEL, DEL), 'clean', 'End puts the cursor back: Backspaces count again');
eq(after('abc', '\u0001', '\u0005', DEL.repeat(3)), 'clean', 'Ctrl-A then Ctrl-E: counted again');
eq(after('abc', '\u0001', DEL), 'draft', 'Backspace right after Ctrl-A (start of line): not counted');
eq(after('abc', `${ESC}[H`, 'x'), 'draft', 'typing after Home still adds content');
eq(after('abc', `${ESC}[3~`, DEL.repeat(3)), 'clean', 'Delete with the cursor at the end removes nothing: counting holds');
eq(after('abc', `${ESC}[D`, `${ESC}[3~`, DEL.repeat(2)), 'draft', 'Delete after a cursor move: not countable');
eq(after('abc', '\u000b', DEL.repeat(3)), 'clean', 'Ctrl-K at the end kills nothing');
eq(after('x\r', `${ESC}[<0;5;5M${ESC}[<0;5;5m`), 'clean', 'a mouse click on an empty composer: clean (and not typing)');
eq(after('abc', `${ESC}[<0;5;5M`, DEL.repeat(3)), 'draft', 'a click over content may have moved the cursor: Backspaces not counted');
eq(after('line1', `${ESC}\r`, 'line2', `${ESC}[F`, '\u0015'), 'draft', 'End in a multi-line composer is not the end of the content');
eq(after('two words', '\u0017'), 'draft', 'Ctrl-W with content: how much it deleted is unknown');
eq(after('typo!', DEL, '\r'), 'clean', 'fix a typo, Enter → submitted (no backslash anywhere)');
eq(after(`a${BS}b`, DEL, '\r'), 'draft', 'a backslash typed, then Backspace, then Enter: may be backslash-Enter → hold');
eq(after(`a${BS}b`, DEL, 'c', '\r'), 'clean', '...but a new char after the Backspace makes the last char known again');
{
  const T = 'pane-turn-ctrlc';
  activity.onTurnStart(T);
  activity.onInput(T, 'typed ahead');
  activity.onInput(T, '\u0003');
  eq(activity.draftState(T), 'draft', 'Ctrl-C DURING a turn interrupts the model — effect on the line unknown → draft');
  activity.onResponseDone(T);
}
{
  const L = 'pane-draft-clean-listener';
  const fired: string[] = [];
  activity.onDraftClean((p) => fired.push(p));
  activity.onInput(L, 'ab');
  eq(fired.length, 0, 'typing into a clean line does not fire draft→clean');
  activity.onInput(L, DEL);
  eq(fired.length, 0, 'still a draft after one Backspace');
  activity.onInput(L, DEL);
  eq(fired.join(), L, 'the Backspace that empties it fires draft→clean, once');
  activity.onInput(L, `${ESC}[D`);
  eq(fired.length, 1, 'a clean line staying clean does not fire again');
  activity.onInput(L, 'x');
  activity.onInput(L, '\r');
  eq(fired.length, 2, 'a submit is draft→clean too (the listener defers; see room-typer)');
  activity.onDraftClean(() => {
    throw new Error('listener boom');
  });
  activity.onInput(L, 'y');
  eq(activity.onInput(L, DEL), true, 'a throwing listener never reaches the input path');
}
{
  const H = 'pane-cleared-by-human';
  activity.onInput(H, 'abc');
  activity.onInput(H, `${ESC}[A`);
  eq(activity.draftState(H), 'draft', 'lost track → draft');
  activity.clearDraft(H);
  eq(activity.draftState(H), 'clean', 'clearDraft (the human says "I looked") → clean');
  activity.onInput(H, 'x');
  eq(activity.draftState(H), 'draft', '...and counting resumes from there');
}

console.log('\n[Enters that do NOT submit]');
eq(after(`${ESC}[200~one\rtwo${ESC}[201~`), 'draft', 'a CR inside a bracketed paste');
eq(after(`${ESC}[200~one\rtw`, `o${ESC}[201~`), 'draft', 'a paste split across chunks');
eq(after(`${ESC}[200~p${ESC}[201~`, '\r'), 'clean', 'Enter AFTER the paste ends does submit');
eq(after(`${ESC}\r`), 'draft', 'Alt/Shift+Enter and the keypad ⏎+ (both ESC CR)');
eq(after('line1', `${ESC}\r`, 'line2'), 'draft', 'multi-line composer');
eq(after(`abc${BS}\r`), 'draft', 'backslash-Enter in one chunk');
eq(after(`abc${BS}`, '\r'), 'draft', 'backslash, then Enter as its own keystroke');
eq(after(`abc${BS}x`, '\r'), 'clean', 'a backslash NOT directly before Enter does not count');
eq(after(`${ESC}[200~a${BS}${ESC}[201~`, '\r'), 'clean', 'a backslash inside a paste is content, not an escape');
eq(after('a\n'), 'draft', 'a lone LF (Ctrl+J) is a newline, not a submit');

console.log('\n[classification only: nothing else is kept]');
const P = 'pane-dropped';
activity.onInput(P, 'secret words');
eq(activity.draftState(P), 'draft', 'draft');
activity.drop(P);
eq(activity.draftState(P), 'unobserved', 'drop() forgets it with the pane');

console.log('\n[BUSY = turn || questionInTurn]');
const B = 'pane-busy';
eq(activity.isBusy(B), false, 'a pane with no hooks is not busy');
activity.onTurnStart(B);
eq(activity.isBusy(B), true, 'UserPromptSubmit → busy');
activity.onResponseDone(B);
eq(activity.isBusy(B), false, 'Stop → not busy');
activity.onQuestion(B);
eq(activity.isBusy(B), false, 'a Notification with NO turn (the idle nag) is not busy');
activity.onTurnStart(B);
activity.onQuestion(B);
eq(activity.isBusy(B), true, 'a dialog inside a turn → busy');
await sleep(1100); // watchdog 300ms + a 500ms sweep tick, with no output
eq(activity.isBusy(B), true, 'the dialog outlives the turn watchdog (questionInTurn)');
activity.onResponseDone(B);
eq(activity.isBusy(B), false, 'Stop clears questionInTurn');
activity.onTurnStart(B);
activity.onQuestion(B);
activity.onTurnStart(B); // the dialog was answered and a new turn began
await sleep(1100); // let the watchdog drop the turn
eq(activity.isBusy(B), false, 'a new turn start clears questionInTurn (nothing left after the watchdog)');

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
