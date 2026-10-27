/**
 * THE CLI PROMPT THROUGH THE SCREEN MODEL (vscreen.cliPromptOf; the design notes): the fixtures are drawn into a real headless
 * terminal and the reading asserted. Three outcomes, never two: a NAME, "startup has cleared" (null), and "cannot tell" ('unknown' + reason).
 * SAFETY: temp db before any import; no broker, no pty, no port.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'wb-cli-prompt-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_VSCREEN_SETTLE_MS = '50';
process.env.HARBOR_WB_VSCREEN = 'shadow';
delete process.env.HARBOR_WB_PROMPT_UNKNOWN_S;
const vs = await import('../src/engine/vscreen.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-prompts');
const bytes = (name: string): string => '\x1b[2J\x1b[H' + readFileSync(join(fx, `${name}.txt`), 'utf8').replace(/\n/g, '\r\n');
const NB = String.fromCharCode(0xa0);
const RULE = '─'.repeat(60);
const composer = `\x1b[2J\x1b[H\r\n${RULE}\r\n❯${NB}\r\n${RULE}\r\n  ? for shortcuts\x1b[3;3H`;
let n = 0;
async function launch(vendor = 'claude-code', origin: 'spawn' | 'adopt' = 'spawn'): Promise<string> {
  const id = `p${++n}`;
  vs.create(id, { origin, link: 'homebase', hostKind: 'pty', vendor, cols: 100, rows: 40 } as never);
  return id;
}
async function draw(id: string, data: string): Promise<void> {
  vs.feed(id, data);
  await vs._settle(id);
}

console.log('\n[a known prompt is named]');
for (const [file, name] of [['theme', 'theme'], ['login', 'login'], ['api-key', 'apiKey'], ['security', 'security'], ['trust', 'trust'], ['mcp', 'mcp']] as const) {
  const id = await launch();
  await draw(id, bytes(file));
  const r = vs.cliPromptOf(id);
  ok(r?.prompt === name && r.reason === null, `${file}: ${name}`);
}

console.log('\n[startup has cleared: null, and a later dialog is not a first-run prompt]');
const a = await launch();
await draw(a, composer);
ok(vs.cliPromptOf(a)?.prompt === null && vs.cliPromptOf(a)?.reason === null, 'the composer is on screen: null / no reason');
await draw(a, bytes('unmatched-dialog'));
ok(vs.cliPromptOf(a)?.prompt === null, 'after startup cleared, an ordinary dialog is not reported as a first-run prompt');
const quoted = await launch();
await draw(quoted, '\x1b[2J\x1b[H' + readFileSync(join(fx, 'repl-mentions-trust.txt'), 'utf8').replace(/\n/g, '\r\n'));
ok(vs.cliPromptOf(quoted)?.prompt !== 'trust' && vs.cliPromptOf(quoted)?.prompt !== 'login', 'a conversation that quotes the trust and login prompts is not a prompt');

console.log('\n[cannot tell: unknown, with a reason, never a silent null]');
const u = await launch();
await draw(u, bytes('unmatched-dialog'));
ok(vs.cliPromptOf(u)?.prompt === 'unknown' && vs.cliPromptOf(u)?.reason === 'starting', 'an unrecognised screen early in a launch: unknown / starting (a normal state, not a claim)');
ok(vs.cliPromptOf(u, Date.now() + 25_000)?.prompt === 'unknown' && vs.cliPromptOf(u, Date.now() + 25_000)?.reason === 'unmatched', 'the same screen past the 20 s deadline: unknown / unmatched (the claim)');
const adopted = await launch('claude-code', 'adopt');
ok(vs.cliPromptOf(adopted)?.prompt === 'unknown' && ['not-synced', 'no-screen'].includes(vs.cliPromptOf(adopted)?.reason ?? ''), 'a pane adopted after an engine restart is not synced yet: unknown / not-synced (or no-screen if its size is unknown)');
const other = await launch('cli-manager');
await draw(other, bytes('theme'));
ok(vs.cliPromptOf(other)?.prompt === 'unknown' && vs.cliPromptOf(other)?.reason === 'no-screen', 'a vendor with no screen signature: unknown / no-screen');
ok(vs.cliPromptOf('never-created') === null, 'a pane with no record: null (the caller says no-screen)');

console.log('\n[a bare shell: "starting" first, then its own state, never "an unknown CLI prompt"]');
const sh = await launch();
await draw(sh, '\x1b[2J\x1b[HWindows PowerShell\r\n\r\nPS C:\\Users\\Owner\\agents\\lead> ');
ok(vs.cliPromptOf(sh)?.prompt === 'unknown' && vs.cliPromptOf(sh)?.reason === 'starting', 'right after the launch a prompt on screen is still "starting" (the typed claude line may be about to run)');
const later = vs.cliPromptOf(sh, Date.now() + 9_000);
ok(later?.prompt === 'shell' && later.reason === null, 'after 8 s it is `shell`: no agent is running in this terminal');
ok(vs.cliPromptOf(sh, Date.now() + 25_000)?.prompt === 'shell', '...and stays `shell` past the unknown deadline (it is NOT turned into "unmatched")');
const sh2 = await launch();
await draw(sh2, bytes('unmatched-dialog'));
ok(vs.cliPromptOf(sh2, Date.now() + 25_000)?.reason === 'unmatched', 'a real unrecognised dialog is still `unmatched`, not `shell`');
const sh3 = await launch();
await draw(sh3, '\x1b[2J\x1b[HPS C:\\x> ');
await draw(sh3, composer);
ok(vs.cliPromptOf(sh3, Date.now() + 25_000)?.prompt === null, 'once the Claude composer has been up, it is null (startup cleared), whatever the screen shows later');

console.log('\n[the screen model is ON by default in local mode, and the usual switches still win]');
const saved = { v: process.env.HARBOR_WB_VSCREEN, m: process.env.HARBOR_WB_MODE };
delete process.env.HARBOR_WB_VSCREEN;
delete process.env.HARBOR_WB_MODE;
ok(vs._refreshMode() === 'off', 'server mode, nothing set: off (unchanged)');
process.env.HARBOR_WB_MODE = 'local';
ok(vs._refreshMode() === 'shadow', 'local mode, nothing set: shadow, so cliPrompt is real without an env var');
process.env.HARBOR_WB_VSCREEN = 'off';
ok(vs._refreshMode() === 'off', 'local mode with HARBOR_WB_VSCREEN=off: off (the env var wins)');
if (saved.v === undefined) delete process.env.HARBOR_WB_VSCREEN; else process.env.HARBOR_WB_VSCREEN = saved.v;
if (saved.m === undefined) delete process.env.HARBOR_WB_MODE; else process.env.HARBOR_WB_MODE = saved.m;
vs._refreshMode();

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
