// Route errors in the pane (the design notes F11; the design's step-1 design).
// Drawn by the Workbench over the pane body, never into the terminal text:
//  - Reconnecting is quiet: a 3 px progress line and a "Reconnecting…" chip, no scrim, no focus change.
//  - Errors use one card over the body (title bar stays reachable), scrim = surface at 62%.
//  - Small panes (< 360 wide or < 240 tall) get a one-line banner; Details moves into ⋯.
//  - Details shows only what the Workbench knows (server, login, route, state, close/exit code,
//    time, attempt, versions) + [Copy details]. ssh's own message stays in the terminal, unread.
//  - Typing while not connected is refused visibly: a chip for 3 s, no queue.
//  - Focus: never taken from another pane; on the active pane the primary button gets it; Tab cycles
//    the card's buttons; Esc returns focus to the terminal and the card stays.

import { icon } from './m3-chrome.js';

const CLOSE_NAMES = { 1000: 'normal', 1001: 'going away', 1006: 'no close frame', 1011: 'server error', 4401: 'unauthorized' };

/** "5:00 PM today" / "5:00 PM tomorrow" / "Oct 21, 5:00 PM": when a grace ends (the design's 3d page). */
export function untilWord(ms) {
  const d = new Date(Number(ms) || 0);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  return diff === 0 ? time + ' today' : diff === 1 ? time + ' tomorrow' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

/** "2:14 PM": when a command finished (the design's 3c page, § This machine). */
export function timeWord(ms) {
  return new Date(Number(ms) || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// The words, per state. Returns null for states that draw nothing (up; connecting on This machine).
/** Step 4 (the design's workbench-step4-restore): why a CLI stopped, in a sentence ("when server restarted") and
 *  short, for a row ("server restarted"). Never a guess like "crashed". */
export function causeWords(cause, N) {
  const n = N || 'the server';
  switch (cause) {
    case 'restarted':
      return { long: 'when ' + n + ' restarted', short: n + ' restarted' };
    case 'broker-updated':
      return { long: 'when ' + n + "'s broker was updated", short: n + "'s broker updated" };
    case 'broker-stopped':
      return { long: 'when ' + n + "'s broker stopped", short: n + "'s broker stopped" };
    case 'app-updated':
      return { long: 'when the Workbench updated', short: 'Workbench updated' };
    case 'app-crashed':
      return { long: 'when the Workbench closed unexpectedly', short: 'closed unexpectedly' };
    case 'computer-restarted':
      return { long: 'when this computer restarted', short: 'computer restarted' };
    default:
      return { long: '', short: '' };
  }
}

export function routeWords(st, program) {
  if (!st) {
    return null;
  }
  // This machine reads "this computer" in a sentence (0.12.1, the design : "Found on this computer.")
  const N = !st.route || st.route === 'local' || !st.serverName || st.serverName === 'This machine' ? 'this computer' : st.serverName;
  const p = st.protocol || {};
  // a recipe's pane names its program (3c, the design's launch table); a plain pane says the shell
  const P = st.program || program || 'the shell';
  const L = st.login ? ' for ' + st.login : '';
  const H = '@' + String(st.handle || 'the seat').replace(/^@/, ''); // W3b: the seat, as the room says it
  if (st.route === 'broker' && st.state === 'up' && st.control) {
    const c = st.control;
    const nudge = st.nudged && Date.now() - st.nudged < 3000 ? st.nudged : 0;
    if (!c.controlling) {
      const word = nudge ? "Typing is off while you're watching" : c.controller ? c.controller.label + ' has control.' : 'Watching';
      return { quiet: true, strip: true, tone: 'watch', noBar: true, icon: 'visibility', word, primary: 'Take control', primaryAct: 'take', pulse: nudge };
    }
    const others = (c.viewers || []).filter((v) => v.id !== c.viewerId).map((v) => v.label);
    return { quiet: true, strip: true, tone: 'control', noBar: true, icon: 'keyboard', word: others.length ? 'Also open on ' + others.join(', ') : 'You have control', primary: 'Stop', primaryAct: 'stop' };
  }
  if (st.keyInstall) {
    // 5a, Connect with a password (the design #s5 k2a/k2b; the plan's round-3 words for a failed check). The
    // strip reads ssh's exit code and the app's own check, never the terminal
    const KN = (st.keyInstall && st.keyInstall.name) || N;
    const typeWords = 'Type your password for ' + KN + ' in the terminal below. The Workbench never sees it, and never stores it.';
    switch (st.state) {
      case 'connecting':
      case 'up':
        return { quiet: true, strip: true, tone: 'key', noBar: true, icon: 'lock', word: typeWords, primary: 'Cancel', primaryAct: 'close' };
      case 'key-signin-failed':
        // a wrong password is ssh's own "Permission denied" in the terminal; the strip stays to try again
        return { quiet: true, strip: true, tone: 'key', noBar: true, icon: 'lock', word: typeWords, primary: 'Try again', primaryAct: 'retry', secondary: 'Cancel', secondaryAct: 'close' };
      case 'key-checking':
        return { quiet: true, strip: true, tone: 'key', noBar: true, icon: 'progress_activity', word: 'Checking it works…' };
      case 'key-done':
        return { quiet: true, strip: true, tone: 'key-done', noBar: true, icon: 'check_circle', word: 'Done. ' + KN + " now signs in with this PC's key.", primary: 'Open a shell', primaryAct: 'key-shell' };
      case 'key-check-failed':
        return { icon: 'error', title: 'Your key was added, but ' + KN + " won't accept it yet.", body: 'This is usually file permissions on ' + KN + '.', primary: 'Try again', primaryAct: 'retry', secondary: 'Close', secondaryAct: 'close', word: "Key not accepted" };
      default:
        break;
    }
  }
  switch (st.state) {
    // ---- W3b: a seat's CLI in a Terminals pane, watched by default; refusals as cards
    case 'viewing': {
      if (st.route === 'term' && st.inlineWatchPrompt) {
        return { choice: true, icon: 'visibility', title: 'Watch ' + H + ' or take control?',
          body: 'Watching keeps typing off. Take control to type in this terminal.',
          primary: 'Take control', primaryAct: 'take', secondary: 'Just watch', secondaryAct: 'watch',
          noDetails: true, calm: true, word: 'Watching ' + H };
      }
      // the design : typing while watching: for 3 s the line says why, and [Take control] pulses once
      const nudge = st.nudged && Date.now() - st.nudged < 3000 ? st.nudged : 0;
      return { quiet: true, strip: true, tone: 'watch', noBar: true, icon: 'visibility', word: nudge ? "Typing is off while you're watching" : 'Watching ' + H, primary: 'Take control', primaryAct: 'take', pulse: nudge };
    }
    case 'controlling':
      return { quiet: true, strip: true, tone: 'control', noBar: true, icon: 'keyboard', word: "You're typing as yourself in " + H + "'s terminal", primary: 'Stop', primaryAct: 'stop' };
    case 'term-refused':
      if (st.why === 'not-live') {
        return { icon: 'bedtime', neutral: true, title: H + ' is resting', body: 'Wake it first, then open its terminal.', primary: 'Wake', primaryAct: 'wake', secondary: 'Close', secondaryAct: 'close', noDetails: true, calm: true, word: 'Resting', calmBar: true };
      }
      if (st.why === 'not-allowed') {
        return { icon: 'block', title: "You can't open " + H + "'s terminal", body: 'An admin sets who can open seats in Terminals.', primary: 'Close', primaryAct: 'close', noDetails: true, calm: true, word: 'Not allowed' };
      }
      if (st.why === 'off') {
        return { info: true, icon: 'toggle_off', title: 'Terminals for seats are turned off here', body: "An admin can turn them on for this room's server.", primary: 'Close', primaryAct: 'close', noDetails: true, calm: true, word: 'Turned off' };
      }
      if (st.why === 'too-many') {
        return { choice: true, icon: 'block', title: 'Too many open terminals', body: 'Close one to open another. The limit is ' + (Number(st.limit) || 4) + '.', primary: 'Show them', primaryAct: 'show', secondary: 'Close', secondaryAct: 'close', noDetails: true, calm: true, word: 'Too many open' };
      }
      return { icon: 'error', title: "Can't open " + H + "'s terminal", body: st.why === 'unreachable' ? "Can't reach the room service." : st.why === 'signed-out' ? 'Sign in to Workrooms again, then try.' : st.why === 'gone' ? 'That seat or its CLI is gone.' : 'The room service said no.', primary: 'Try again', secondary: 'Close', secondaryAct: 'close', noDetails: true, calm: true, word: "Can't open" };
    case 'term-closed': {
      const why = { expired: 'The link to it expired before it opened.', 'timed-out': 'It was idle too long.', 'too-fast': 'It sent too much at once.', refused: 'The room service closed it.', protocol: 'The room service closed it.', closed: 'The room service closed it.', unreachable: "Can't reach the room service." }[st.why] || 'The room service closed it.';
      return { icon: 'link_off', neutral: true, title: H + "'s terminal closed", body: why + ' Its CLI is still running in the room.', primary: 'Open again', secondary: 'Close', secondaryAct: 'close', noDetails: true, calm: true, word: 'Closed' };
    }
    // ---- step 4 (the design's workbench-step4-restore): a stopped conversation, and one that couldn't be found
    case 'conversation-stopped': {
      const where = N === 'this computer' ? 'this computer' : N;
      const c = causeWords(st.cause, N === 'this computer' ? 'this computer' : N);
      return { icon: 'history', neutral: true, calm: true, title: 'This conversation stopped' + (c.long ? ' ' + c.long : '') + '.', body: 'Restore brings it back where it left off, in ' + (st.folder || '~') + ' on ' + where + '.', primary: 'Restore', primaryAct: 'restore', secondary: 'Close', secondaryAct: 'close', noDetails: true, word: 'Stopped' };
    }
    case 'resume-not-found':
      return { icon: 'search_off', neutral: true, title: "Couldn't find this conversation on " + N + '.', body: "Its history isn't where " + P + ' keeps it.', primary: 'Start a new one', primaryAct: 'fresh', secondary: 'Close', secondaryAct: 'close', detailsLink: true, word: 'Not found' };
    case 'connecting':
      if (st.restoring) {
        return { quiet: true, word: 'Restoring ' + (st.name || P) + ' on ' + N + '…' }; // step 4
      }
      if (st.route === 'term') {
        return { quiet: true, word: 'Opening ' + H + "'s terminal…" };
      }
      // the design : a server pane opens at once in the quiet state, "Connecting to server…" (never
      // "Reconnecting…", nothing was connected yet), then the shell or the matching card.
      // A recipe's pane: "Starting Claude Code on server…"
      if (st.program) {
        return { quiet: true, word: 'Starting ' + P + ' on ' + N + '…' };
      }
      // the Console tab's terminal: "Connecting to server as the owner…"
      return st.route && st.route !== 'local' ? { quiet: true, word: 'Connecting to ' + N + (st.consoleTerminal && st.login ? ' as ' + st.login : '') + '…' } : null;
    // ---- a recipe's launch (3c): the four cards of the design's launch table
    case 'not-installed':
      // the design  /  (0.12.4): nothing broke, it's just missing: a neutral icon. On this computer
      // Install runs the vendor's command in a pane; on a server it is the admin's to install.
      if (N === 'this computer') {
        return { icon: 'download', neutral: true, title: P + " isn't installed on this computer", body: 'This recipe needs it. Install it here, then the recipe starts.', primary: 'Install', primaryAct: 'install', secondary: 'Edit recipe', secondaryAct: 'edit', detailsLink: true, word: 'Not installed' };
      }
      return { icon: 'download', neutral: true, title: P + " isn't installed on " + N, body: 'Ask ' + N + "'s admin to install it.", primary: 'Edit recipe', primaryAct: 'edit', detailsLink: true, word: 'Not found on ' + N };
    // ---- the Install pane
    case 'install-wait':
      // the design : a full-width strip above the terminal (the terminal starts under it), not a chip over the output
      return { quiet: true, strip: true, icon: 'keyboard_return', word: 'The Workbench typed the install command for you. Press Enter to run it, or close this pane to cancel.', bar: 'Install' };
    case 'install-checking':
      return { quiet: true, word: 'Checking…', bar: 'Install' };
    case 'install-done':
      return { quiet: true, done: true, icon: 'check_circle', word: P + ' is installed' + (st.version ? ' · ' + st.version : ''), bar: 'Installed', primary: st.recipeId ? 'Start recipe' : 'Close', primaryAct: st.recipeId ? 'start-recipe' : 'close', secondary: st.recipeId ? 'Close' : undefined, secondaryAct: st.recipeId ? 'close' : undefined };
    case 'install-nofind':
      return { quiet: true, done: true, icon: 'help', word: "The install finished, but the Workbench can't find " + P + ' yet. Restart the Workbench to pick up the new path.', bar: 'Installed?', primary: 'Restart Workbench', primaryAct: 'restart', secondary: 'Close', secondaryAct: 'close' };
    case 'install-failed':
      return { quiet: true, done: true, error: true, icon: 'error', word: 'The install stopped with an error · exit ' + (st.code == null ? '?' : st.code) + '. The reason is above.', tip: 'Exit code ' + (st.code == null ? '?' : st.code), bar: 'Stopped', primary: 'Try again', primaryAct: 'again', secondary: 'Close', secondaryAct: 'close' };
    case 'install-nonode':
      return { icon: 'extension_off', neutral: true, title: 'Installing ' + P + " needs Node.js, which isn't on this computer.", body: '', primary: 'Get Node.js', primaryAct: 'nodejs', secondary: 'Close', secondaryAct: 'close', word: 'Needs Node.js' };
    case 'stopped-early':
      return { icon: 'stop_circle', neutral: true, title: P + ' stopped right after it started on ' + N + '.', body: 'Its last lines are under Details.', primary: 'Try again', word: 'Stopped' };
    case 'package-error':
      return { icon: 'error', title: P + "'s package hit an error starting this.", body: st.message || '', primary: 'Close', primaryAct: 'close', word: "Didn't start" };
    case 'broker-old':
      // a 0.12.0 app against a broker before 0.2.0: plain shells open, a recipe says the broker is too old
      // and never assumes the scoping it doesn't have
      return { info: true, icon: 'update', title: N + "'s broker" + L + ' is too old for recipes.', body: 'Recipes need Workbench Broker 0.2 or later. An admin can update it from the console.', primary: 'Close', primaryAct: 'close', word: 'Broker too old' };
    case 'folder-gone':
      return { icon: 'folder_off', title: "There's no " + (st.folder || '~') + ' on ' + N + L + '.', body: 'It may have been moved or deleted.', primary: 'Start in the home folder', primaryAct: 'home', secondary: 'Edit recipe', secondaryAct: 'edit', word: 'Folder missing' };
    // ---- step 3d (the design's 3d page, "The limit and drain"; piece 9's grace)
    case 'at-cap': {
      const n = Number(st.live) || Number(st.cap) || 0;
      return { choice: true, icon: 'block', title: n + ' CLIs are already running on ' + N + (st.login ? ' · ' + st.login : '') + ', the limit.', body: 'End one to start another.', primary: 'Show them', primaryAct: 'show', secondary: 'Close', secondaryAct: 'close', noDetails: true, word: 'At the limit' };
    }
    // ---- step 3e (the design , "When a recipe is blocked"): the server's recipe policy refused this start
    case 'recipe-policy': {
      const none = st.policy === 'none';
      const yours = st.manages ? ' You can change this in Servers › ' + N + ' › Recipes.' : '';
      return {
        choice: true,
        icon: 'block',
        title: none ? 'Recipes are turned off on ' + N : N + " doesn't let you start recipes",
        body: (none ? 'An admin of ' + N + ' turned them off.' : 'An admin of ' + N + ' decides who can.') + ' A shell still works here.' + yours,
        primary: 'Open a shell',
        primaryAct: 'shell',
        secondary: 'Close',
        secondaryAct: 'close',
        ...(st.manages ? { tertiary: 'Change policy', tertiaryAct: 'policy' } : {}),
        noDetails: true,
        calm: true, // the standard card color, not the pane's tint
        word: none ? 'Recipes off' : 'Not allowed',
      };
    }
    case 'draining':
      return { info: true, icon: 'update', title: N + (st.login ? ' · ' + st.login : '') + " isn't starting new CLIs right now.", body: 'Its broker is waiting to update. CLIs already running there are fine.', primary: 'Close', primaryAct: 'close', noDetails: true, word: 'Waiting to update' };
    case 'grace':
      // the refusal under a "Let them run" grace (decided 2026-10-19): the design's removal sentence, then
      // what the grace keeps (the running ones) and what it refuses (this one)
      return { icon: 'block', title: 'An admin removed your access to ' + N + (st.login ? ' · ' + st.login : '') + '.', body: 'CLIs already running there keep going until ' + untilWord(st.until) + '. Nothing new starts there.', primary: 'Close', primaryAct: 'close', noDetails: true, word: 'Access removed' };
    case 'finished':
      // 0.12.1: a custom command that exited 0 has finished, not
      // stopped early: a quiet line under the output, "Finished · 2:14 PM" · [Run again] [Close], tooltip
      // "Exit code 0"; the title bar reads Finished; the output stays, selectable; no card
      return { quiet: true, done: true, icon: 'check_circle', word: 'Finished · ' + timeWord(st.since), tip: 'Exit code ' + (st.code == null ? 0 : st.code), bar: 'Finished', primary: 'Run again', primaryAct: 'again', secondary: 'Close', secondaryAct: 'close' };
    case 'stopped':
      // a non-zero exit after the first 10 s: "Stopped with an error · exit 3 · 2:14 PM" · [Run again] [Close]
      return { quiet: true, done: true, error: true, icon: 'error', word: 'Stopped with an error · exit ' + (st.code == null ? '?' : st.code) + ' · ' + timeWord(st.since), tip: 'Exit code ' + (st.code == null ? '?' : st.code), bar: 'Stopped', primary: 'Run again', primaryAct: 'again', secondary: 'Close', secondaryAct: 'close' };
    case 'reconnecting':
      return { quiet: true, word: 'Reconnecting…' };
    case 'down':
      return { icon: 'cloud_off', title: "Can't reach " + N, body: "Check that it's on and on your network.", auto: true, primary: 'Try again', word: "Can't reach" };
    case 'unauthorized':
      // "Pair again" arrives with real pairing (step 3b); until then the button re-reads the token and retries.
      return { icon: 'key_off', title: N + "'s broker turned down this computer", body: 'Its pairing was probably replaced. Pair again to continue.', primary: 'Try again', word: 'Token rejected' };
    case 'version-mismatch':
      if (p.mismatch === 'broker-newer') {
        return { info: true, icon: 'update', title: 'This Workbench is older than ' + N + "'s broker", body: 'It speaks version ' + p.version + ', and this Workbench speaks version ' + p.need + '. Update this Workbench.', primary: 'Try again', word: 'Needs update' };
      }
      return {
        info: true,
        icon: 'update',
        title: N + "'s broker is older than this Workbench",
        body: p.need ? 'It speaks version ' + p.version + ', and this Workbench needs version ' + p.need + '. Update the broker on ' + N + '.' : 'Update the broker on ' + N + '.',
        primary: 'Try again',
        word: 'Needs update',
      };
    case 'identity-mismatch': {
      // the design  (aurora <commit>): the host-key family, error colour, no proceed-anyway. "Your access
      // wasn't sent" is true: the token goes out only after the identity checks ().
      const who = N + "'s broker" + (st.login ? ' for ' + st.login : '');
      return {
        icon: 'gpp_bad',
        title: who + " isn't the one your account approved.",
        body: "Its identity doesn't match. That happens when the broker was reinstalled without being approved again, or when something else is answering at its address. Your access wasn't sent to it. Don't connect until an admin has checked " + N + '.',
        primary: 'Close',
        primaryAct: 'close',
        word: "Identity doesn't match", // the design's 3b title-bar word (, confirmed 2026-10-19)
      };
    }
    case 'access-expired':
      // the design's access table: the keys-only pane's card when it next connects
      return { icon: 'key_off', title: 'Your access to ' + N + ' has expired.', body: 'Sign in to your account again to keep using it.', primary: 'Sign in again', primaryAct: 'signin', word: 'Access expired' };
    case 'access-removed':
      // 3d: removal ends the person's CLIs by default, and a "Let them run" grace ends them at its end;
      // either way the socket's close means this CLI is over (the design's 3d page retires 3b's interim words)
      return {
        icon: 'block',
        title: 'An admin removed your access to ' + N + (st.login ? ' · ' + st.login : '') + '.',
        body: 'This CLI has ended.',
        primary: 'Close',
        primaryAct: 'close',
        noDetails: true, // the design  (7): Close only
        word: 'Access removed', // the title bar's word
      };
    case 'closed':
      return { icon: 'link_off', title: 'The connection to ' + N + ' closed', body: 'ssh stopped with exit code ' + st.code + ". ssh's message is above.", primary: 'Reconnect', word: 'Disconnected' };
    case 'spawn-failed':
      return { icon: 'error', title: "Couldn't start " + (program || 'the shell') + ' on ' + N, body: "The program didn't start. Nothing is running in this pane.", primary: 'Try again', word: "Didn't start" };
    default:
      return null;
  }
}

// The title bar's status word: { text, kind: 'err' | 'quiet' } or null.
export function routeWord(st) {
  const w = routeWords(st);
  if (!w || w.noBar) {
    return null; // W3b (the design .2): the watching and in-control strips say it; no chip repeats them
  }
  return { text: w.bar || w.word, kind: w.quiet ? 'quiet' : w.info ? 'info' : w.calmBar ? 'neutral' : 'err' };
}

function detailRows(st) {
  const rows = [];
  rows.push(['Server', (st.serverName || 'This machine') + (st.login ? ' · ' + st.login : '')]);
  if (st.state === 'identity-mismatch' && st.identity) {
    // the design : what was expected and where; no "got" (the check returns a signature, not a key)
    rows.push(['Expected', (st.identity.expected || 'the key your account approved') + ' · from your account']);
    rows.push(['Address', st.identity.address || '']);
    rows.push(['Check', "The broker's answer wasn't signed by that key."]);
    rows.push(['When', new Date(st.since || Date.now()).toLocaleTimeString()]);
    return rows;
  }
  rows.push(['Route', st.route || 'local']);
  rows.push(['State', st.state + (st.message ? ': ' + st.message : '')]);
  if (st.program) {
    rows.push(['Program', st.program + (st.folder ? ' in ' + st.folder : '')]);
  }
  if (st.state === 'resume-not-found') {
    rows.push(['Folder searched', st.folder || '~']);
    if (st.banked) {
      rows.push(['Conversation', st.banked]);
    }
  }
  if (st.lastLines) {
    rows.push(['Last lines', st.lastLines]); // the last 20 lines of a CLI that stopped right after it started
  }
  if (st.code != null && st.route === 'broker') {
    rows.push(['Close', st.code + (CLOSE_NAMES[st.code] ? ' (' + CLOSE_NAMES[st.code] + ')' : '')]);
  } else if (st.code != null) {
    rows.push(['Exit', String(st.code)]);
  }
  const when = new Date(st.since || Date.now()).toLocaleTimeString();
  rows.push(['When', when + (st.attempt ? ' · attempt ' + st.attempt : '')]);
  if (st.brokerVersion) {
    rows.push(['Broker', String(st.brokerVersion)]);
  }
  if (st.protocol && st.protocol.mode) {
    rows.push(['Protocol', st.protocol.mode + ' ' + st.protocol.version + (st.protocol.need && st.protocol.need !== st.protocol.version ? ' (needs ' + st.protocol.need + ')' : '')]);
  } else if (st.protocol && st.protocol.version != null) {
    rows.push(['Protocol', 'version ' + st.protocol.version + (st.protocol.need ? ' (needs ' + st.protocol.need + ')' : '')]);
  }
  return rows;
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text != null) {
    e.textContent = text;
  }
  return e;
};

let idSeq = 0;

// Focus a card button and draw its ring (the design, step-1 review): the ring shows for keyboard focus
// and when focus lands by itself as the card opens, not only on :focus-visible, which a programmatic
// focus does not always trigger.
function ringFocus(root, btn) {
  for (const b of root.querySelectorAll('.rx-ring')) {
    b.classList.remove('rx-ring');
  }
  if (btn) {
    btn.classList.add('rx-ring');
    btn.focus();
  }
}

// One overlay per pane. `o` = { onRetry, onClose, onSignIn, onFocusTerminal, program: () => string }.
export function createRouteOverlay(o) {
  const root = el('div', 'rx');
  root.hidden = true;
  let st = null;
  let words = null;
  let shownKey = '';
  let detailsOpen = false;
  let small = false;
  let nudgeTimer = null;
  let tabArmed = false;
  let countdown = null;
  let typingTimer = null;
  let typingChip = null;
  let viewKey = '';

  function stopCountdown() {
    clearInterval(countdown);
    countdown = null;
  }

  function autoText() {
    if (!st || !st.nextTry) {
      return '';
    }
    const s = Math.ceil((st.nextTry - Date.now()) / 1000);
    return s > 0 ? 'Trying again in ' + s + ' s' : 'Trying again…';
  }

  function buttons(container, primaryLabel, withDetails) {
    // Material dialog order: text buttons first, the filled primary last (rightmost).
    if (withDetails && !(words && words.detailsLink)) {
      const d = el('button', 'rx-btn text', detailsOpen ? 'Hide details' : 'Details');
      d.dataset.rx = 'details';
      d.setAttribute('aria-expanded', String(detailsOpen));
      container.appendChild(d);
    }
    if (words && words.tertiary) {
      const tb = el('button', 'rx-btn text', words.tertiary); // 3e: [Change policy] for a server's managers
      tb.dataset.rx = 'tertiary';
      container.appendChild(tb);
    }
    if (words && words.secondary) {
      const sb = el('button', 'rx-btn text', words.secondary);
      sb.dataset.rx = 'secondary';
      container.appendChild(sb);
    }
    const p = el('button', 'rx-btn fill', primaryLabel);
    p.dataset.rx = 'primary';
    container.appendChild(p);
    return p;
  }

  function detailsBlock() {
    const box = el('div', 'rx-det');
    const dl = el('dl');
    for (const [k, v] of detailRows(st)) {
      dl.append(el('dt', null, k), el('dd', null, v));
    }
    const act = el('div', 'rx-act rx-act-det');
    const copy = el('button', 'rx-btn text');
    copy.dataset.rx = 'copy';
    copy.innerHTML = icon('content_copy');
    copy.appendChild(document.createTextNode('Copy details'));
    act.appendChild(copy);
    box.append(dl, act);
    return box;
  }

  function render(focus) {
    stopCountdown();
    root.textContent = '';
    root.className = 'rx';
    if (!words) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    if (words.quiet) {
      root.classList.add('is-quiet');
      if (words.done) {
        root.classList.add('is-done'); // an ended line: no progress line, the output stays readable
      }
      const chip = el('div', 'rx-chip' + (words.error ? ' is-error' : ''));
      chip.setAttribute('aria-live', 'polite');
      chip.innerHTML = icon(words.icon || 'sync');
      chip.appendChild(document.createTextNode(words.word));
      if (words.strip) {
        root.classList.add('is-strip'); // the host's --rx-strip (renderer syncStrip) moves the terminal down by its height
      }
      root.classList.toggle('tone-watch', words.tone === 'watch');
      root.classList.toggle('tone-control', words.tone === 'control');
      root.classList.toggle('tone-key', words.tone === 'key' || words.tone === 'key-done');
      if (words.tip) {
        chip.title = words.tip;
      }
      if (words.primary) {
        const b = el('button', 'rx-btn chip' + (words.pulse ? ' rx-pulse' : ''), words.primary);
        b.dataset.rx = 'primary';
        chip.appendChild(b);
      }
      if (words.secondary) {
        const b2 = el('button', 'rx-btn chip t', words.secondary);
        b2.dataset.rx = 'secondary';
        chip.appendChild(b2);
      }
      root.append(...(words.done || words.tone ? [] : [el('div', 'rx-prog')]), chip);
      if (typingChip) {
        root.appendChild(typingChip);
      }
      return;
    }
    const tid = 'rx-t-' + ++idSeq;
    let primary;
    if (small) {
      root.classList.add('is-small');
      const ban = el('div', 'rx-ban');
      ban.setAttribute('role', 'alert');
      ban.innerHTML = icon(words.icon);
      const t = el('span', 'grow', words.title);
      t.id = tid;
      ban.appendChild(t);
      primary = el('button', 'rx-btn ban', words.primary);
      primary.dataset.rx = 'primary';
      ban.appendChild(primary);
      if (st.inlineWatchPrompt && words.secondary) {
        const watch = el('button', 'rx-btn ban', words.secondary);
        watch.dataset.rx = 'secondary'; ban.appendChild(watch);
      }
      if (!words.noDetails) {
        const more = el('button', 'rx-more');
        more.dataset.rx = 'details';
        more.title = 'Details';
        more.setAttribute('aria-label', 'Details');
        more.setAttribute('aria-expanded', String(detailsOpen));
        more.innerHTML = icon('more_vert');
        ban.appendChild(more);
      }
      root.appendChild(ban);
      if (detailsOpen && !words.noDetails) {
        const pop = el('div', 'rx-banpop');
        pop.appendChild(detailsBlock());
        root.appendChild(pop);
      }
    } else {
      const scrim = el('div', 'rx-scrim' + (detailsOpen ? ' open' : ''));
      const card = el('div', 'rx-card' + (words.calm ? ' calm' : '')); // calm: the app's card color, not the pane's tint (the design .4)
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-live', 'polite');
      card.setAttribute('aria-labelledby', tid);
      const top = el('div', 'rx-top');
      const ic = el('div', 'rx-ic' + (words.choice ? ' choice' : '') + (words.info ? ' info' : '') + (words.neutral ? ' neutral' : ''));
      ic.innerHTML = icon(words.icon);
      const txt = el('div', 'rx-txt');
      const title = el('p', 'rx-t', words.title);
      title.id = tid;
      txt.append(title, el('p', 'rx-b', words.body));
      if (words.auto) {
        const a = el('p', 'rx-auto', autoText());
        a.dataset.rx = 'auto';
        txt.appendChild(a);
        countdown = setInterval(() => {
          a.textContent = autoText();
        }, 1000);
      }
      if (words.detailsLink && !words.noDetails) {
        // Details as the link under the line (the not-installed card, the design )
        const dl = el('button', 'rx-dlink', detailsOpen ? 'Hide details' : 'Details');
        dl.dataset.rx = 'details';
        dl.setAttribute('aria-expanded', String(detailsOpen));
        txt.appendChild(dl);
      }
      top.append(ic, txt);
      const act = el('div', 'rx-act');
      primary = buttons(act, words.primary, !words.noDetails);
      card.append(top, act);
      if (detailsOpen && !words.noDetails) {
        card.appendChild(detailsBlock());
      }
      scrim.appendChild(card);
      root.appendChild(scrim);
    }
    if (typingChip) {
      root.appendChild(typingChip);
    }
    if (focus && primary) {
      ringFocus(root, primary);
    }
  }

  function refreshInPlace() {
    const a = root.querySelector('[data-rx=auto]');
    if (a) {
      a.textContent = autoText();
    }
    const dl = root.querySelector('.rx-det dl');
    if (dl) {
      dl.textContent = '';
      for (const [k, v] of detailRows(st)) {
        dl.append(el('dt', null, k), el('dd', null, v));
      }
    }
  }

  function copyText() {
    return detailRows(st).map(([k, v]) => k + ': ' + v).join('\n');
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rx]');
    if (!b) {
      return;
    }
    e.stopPropagation();
    const act = b.dataset.rx;
    const named = (what) => {
      if (what === 'close') {
        o.onClose && o.onClose();
      } else if (what === 'signin') {
        o.onSignIn && o.onSignIn();
      } else if (what === 'edit') {
        o.onEdit && o.onEdit(st);
      } else if (what === 'home') {
        o.onHome && o.onHome();
      } else if (what === 'install') {
        o.onInstall && o.onInstall(st);
      } else if (what === 'show') {
        o.onShow && o.onShow(st); // 3d: Show them opens the rail at that group
      } else if (what === 'start-recipe') {
        o.onStartRecipe && o.onStartRecipe(st);
      } else if (what === 'restart') {
        o.onRestart && o.onRestart();
      } else if (what === 'nodejs') {
        o.onNode && o.onNode();
      } else if (what === 'key-shell') {
        o.onKeyShell && o.onKeyShell(st); // 5a: Done, a plain shell on the server that now takes the key
      } else if (what === 'take') {
        o.onTake && o.onTake(); // W3b: Take control (a deliberate click)
      } else if (what === 'watch') {
        o.onWatch && o.onWatch();
      } else if (what === 'stop') {
        o.onStop && o.onStop();
      } else if (what === 'wake') {
        o.onWake && o.onWake(st);
      } else if (what === 'shell') {
        o.onShell && o.onShell(st); // 3e: a plain shell on the same server · login
      } else if (what === 'policy') {
        o.onPolicy && o.onPolicy(st); // 3e: Servers › <server> › Recipes
      } else if (what === 'restore') {
        o.onRestore ? o.onRestore(st) : o.onRetry(); // step 4: Restore (an explicit launch, with a spawn permit)
      } else if (what === 'fresh') {
        o.onFresh && o.onFresh(st); // step 4: Start a new one, the same recipe without the old conversation
      } else if (what === 'again') {
        o.onRunAgain ? o.onRunAgain() : o.onRetry(); // Run again: an explicit launch, with a spawn permit
      } else {
        o.onRetry();
      }
    };
    if (act === 'primary') {
      named(words && words.primaryAct);
    } else if (act === 'secondary') {
      named(words && words.secondaryAct);
    } else if (act === 'tertiary') {
      named(words && words.tertiaryAct);
    } else if (act === 'details') {
      detailsOpen = !detailsOpen;
      viewKey = JSON.stringify([words, small, detailsOpen, !!typingChip]);
      render(false);
      const again = root.querySelector('[data-rx=details]');
      if (again) {
        again.focus();
      }
    } else if (act === 'copy') {
      navigator.clipboard.writeText(copyText()).catch(() => {});
    }
  });
  // Keep pointer presses on the card from reaching the terminal underneath.
  root.addEventListener('pointerdown', (e) => {
    ringFocus(root, null);
    if (e.target.closest('.rx-scrim, .rx-ban, .rx-banpop')) {
      e.stopPropagation();
    }
  });
  root.addEventListener('focusout', (e) => {
    if (e.target.classList && e.target.classList.contains('rx-ring') && e.relatedTarget) {
      e.target.classList.remove('rx-ring');
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      o.onFocusTerminal();
      return;
    }
    if (e.key === 'Tab') {
      const btns = [...root.querySelectorAll('button')];
      if (!btns.length) {
        return;
      }
      const i = btns.indexOf(document.activeElement);
      if (i < 0) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      ringFocus(root, btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length]);
    }
  });

  return {
    el: root,
    // active: this pane is the window's active pane (only then may the card take focus).
    update(next, { active, smallPane }) {
      const prevKey = shownKey;
      st = next && next.state ? next : null;
      words = routeWords(st, o.program());
      // W3b: the watching line's 3 s nudge goes back by itself; the next Tab after it reaches [Take control]
      clearTimeout(nudgeTimer);
      tabArmed = !!(words && words.tone === 'watch' && (tabArmed || words.pulse));
      if (words && words.pulse) {
        const again = next;
        nudgeTimer = setTimeout(() => this.update(again, { active, smallPane: small }), Math.max(0, words.pulse + 3000 - Date.now()) + 30);
      }
      small = !!smallPane;
      shownKey = words && !words.quiet ? st.state + ':' + (st.code == null ? '' : st.code) : '';
      if (shownKey !== prevKey) {
        detailsOpen = false;
      }
      // The same card with new numbers (the sweep's countdown, the attempt): refresh in place so a
      // focused button keeps the keyboard. Only a different card is drawn again.
      const key = JSON.stringify([words, small, detailsOpen, !!typingChip]);
      if (key === viewKey && shownKey === prevKey && root.firstChild) {
        refreshInPlace();
        return;
      }
      viewKey = key;
      // Focus only when a card newly appears on the active pane, never on a refresh.
      render(!!active && !!shownKey && shownKey !== prevKey);
    },
    resize(smallPane) {
      if (!!smallPane !== small && words && !words.quiet) {
        small = !!smallPane;
        viewKey = JSON.stringify([words, small, detailsOpen, !!typingChip]);
        const had = root.contains(document.activeElement);
        render(had);
      }
    },
    /** W3b: after a nudge, the next Tab in the pane focuses [Take control] (true: the key is used). */
    takeTab() {
      const b = tabArmed && root.querySelector('.rx-chip [data-rx=primary]');
      if (!b) {
        return false;
      }
      tabArmed = false;
      ringFocus(root, b);
      return true;
    },
    typingPaused() {
      clearTimeout(typingTimer);
      const N = (st && st.serverName) || 'This machine';
      typingChip = el('div', 'rx-chip rx-typing', 'Typing is paused until ' + N + ' is back');
      typingChip.setAttribute('aria-live', 'polite');
      root.hidden = false;
      const old = root.querySelector('.rx-typing');
      if (old) {
        old.remove();
      }
      root.appendChild(typingChip);
      typingTimer = setTimeout(() => {
        if (typingChip) {
          typingChip.remove();
          typingChip = null;
        }
        if (!words) {
          root.hidden = true;
        }
      }, 3000);
    },
    hasCard: () => !!shownKey,
    focusPrimary() {
      const b = root.querySelector('[data-rx=primary]');
      if (b) {
        ringFocus(root, b);
      }
    },
    dispose() {
      stopCountdown();
      clearTimeout(typingTimer);
      root.remove();
    },
  };
}
