/**
 * Codex startup screens in the prompt detector (the design notes §3
 * item 6), from the OBSERVED fixtures in test/fixtures/codex-screens/ (Codex
 * 0.162.1, captured by Owner's Codex seat): the trust screen reads "needs you:
 * permission", the login screen "needs you: login", as CURRENT dialogs, tolerant
 * of wrapping, whitespace and the selection marker; split chunks; a quiet dialog
 * outlasting the settle time; clearing once later output has drawn; never a lone
 * "Sign in"; never a stale scrollback match. A non-Codex pane is unchanged.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pb from '../src/engine/prompt-block.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-screens');
const trust = readFileSync(join(FIX, 'trust.txt'), 'utf8').replace('<absolute project path>', '/home/kid/dev/code/hello-world');
const login = readFileSync(join(FIX, 'login.txt'), 'utf8');
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);

let checks = 0;
let failed = 0;
const ok = (c: unknown, m: string) => {
  checks++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
};
let n = 0;
const pane = (vendor = 'codex-cli') => {
  const id = `p${++n}`;
  pb.arm(id, vendor);
  return id;
};
const reason = (id: string) => pb.get(id)?.reason ?? null;
/** a TUI writes with cursor moves and CRLF; the detector reads through them */
const asTui = (s: string) => ESC + '[2J' + ESC + '[H' + s.split(NL).join(CR + NL + ESC + '[K');

console.log('\n[the two screens]');
let p = pane();
pb.onPtyData(p, asTui(trust));
ok(reason(p) === 'permission', 'the trust screen: needs you (permission)');
p = pane();
pb.onPtyData(p, asTui(login));
ok(reason(p) === 'login', 'the login screen: needs you (login)');

console.log('\n[wrapping, whitespace, selection marker, split chunks]');
p = pane();
const rewrapped = trust.replace('Codex can read, edit,', 'Codex can read,' + NL + '   edit,').replace(String.fromCharCode(0x203a) + ' 1.', '> 1.');
pb.onPtyData(p, asTui(rewrapped));
ok(reason(p) === 'permission', 're-wrapped at another width with the other marker: still the trust screen');
p = pane();
const t = asTui(login);
for (let i = 0; i < t.length; i += 7) {
  pb.onPtyData(p, t.slice(i, i + 7)); // seven bytes at a time: every marker straddles chunks, escapes split too
}
ok(reason(p) === 'login', 'fed seven bytes at a time: still the login screen');

console.log('\n[a quiet dialog outlasts the settle time; it clears once it is gone]');
p = pane();
pb.onPtyData(p, asTui(trust), 1_000);
pb.sync(p, 600_000);
ok(reason(p) === 'permission', 'ten minutes with no output: still blocked');
pb.onPtyData(p, asTui('> ' + 'x'.repeat(2500)), 600_100);
ok(reason(p) === null, 'after a full screen of later output the trust screen is no longer current');
p = pane();
pb.onPtyData(p, asTui(trust));
pb.onPtyData(p, asTui(login));
ok(reason(p) === 'login', 'trust answered, then the login screen: the newest screen wins');

console.log('\n[no false matches]');
p = pane();
pb.onPtyData(p, asTui('Tip: Sign in to sync your settings. ' + 'Sign in ' + 'later.'));
ok(reason(p) === null, 'a lone "Sign in" is not the login screen');
p = pane();
pb.onPtyData(p, asTui(login));
pb.onPtyData(p, asTui('Logged in. ' + 'y'.repeat(2600) + ' > ready for your prompt'));
ok(reason(p) === null, 'an old login screen far back in scrollback does not block a ready composer');
p = pane('claude-code');
pb.onPtyData(p, asTui(trust + login));
ok(reason(p) === null, 'a Claude pane is not read with Codex rules (its own markers are unchanged)');
p = pane('cli-manager');
pb.onPtyData(p, asTui(trust));
ok(reason(p) === null, 'a shell is never armed');

console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
