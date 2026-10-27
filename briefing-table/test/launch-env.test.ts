/**
 * `buildLaunch` — how identity (R11) and a vendor's command line reach a
 * session, on all three spawn shapes.
 *
 * The engine test proves the LOCAL path end to end by echoing the variables out
 * of a real pty. It cannot prove the ssh path: that needs a reachable host, a
 * key and a remote shell, so the remote half is asserted HERE, on the command
 * string the engine actually sends.
 *
 * THE SSH MECHANISM, and why it is a command-line `export` rather than
 * `ssh -o SendEnv`: SendEnv is refused unless the REMOTE sshd lists each
 * variable in `AcceptEnv`, which is root-owned config on every host we would
 * want this on. A launch feature that needs a sudo edit on the far side is a
 * launch feature that silently does nothing — the exact shape of the 401'ing
 * hooks and the 401'ing `offer-url` skill, twice. The command line is also
 * already the proven channel: `claude --session-id <uuid>` has been riding it
 * through the same quoting since M6.
 */
import { buildLaunch, sessionEnv, type Target } from '../src/engine/launch.ts';
import type { Recipe } from '../src/table/store.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}

function recipe(over: Partial<Recipe>): Recipe {
  return {
    id: 'r1',
    name: 'Test',
    target: 'local',
    projectDir: '/srv/code/thing',
    vendor: 'cli-manager',
    agent: 'thing-cli',
    runClaude: 0,
    model: null,
    resume: 0,
    resumeName: null,
    initCmd: null,
    closeOnCleanExit: 0,
    statusPath: null,
    color: null,
    fg: null,
    bg: null,
    watermark: null,
    fontSize: null,
    logo: null,
    created_at: 0,
    updated_at: 0,
    last_launched_at: null,
    ...over,
  } as Recipe;
}
const LOCAL: Target = { id: 'local', label: 'Local', kind: 'local', broker: 'local' };
const SSH: Target = { id: 'homebase', label: 'server', kind: 'ssh', sshAlias: 'homebase-alias', broker: 'local' };
const RESIDENT: Target = { id: 'homebase-res', label: 'server resident', kind: 'ssh', sshAlias: 'homebase-alias', broker: 'homebase' };
const ID = { paneid: 'recipe:abc#1' };

console.log('\n[sessionEnv: a value that is not known is OMITTED, never empty]');
eq(Object.keys(sessionEnv({})).length, 0, 'nothing known, nothing exported');
eq(
  JSON.stringify(sessionEnv({ paneid: 'p1', slug: 's1', vendor: 'v1' })),
  JSON.stringify({ HARBOR_WB_SLUG: 's1', HARBOR_WB_PANEID: 'p1', HARBOR_WB_VENDOR: 'v1' }),
  'all three, when all three are known',
);
eq(
  sessionEnv({ paneid: 'p1', slug: null, vendor: 'v1' }).HARBOR_WB_SLUG,
  undefined,
  'a null slug is ABSENT — "$HARBOR_WB_SLUG" expanding to "" would claim the session has no identity, which is a different thing from nobody having told it',
);

console.log('\n[local: identity rides the descriptor env]');
const loc = buildLaunch(recipe({}), LOCAL, null, null, ID);
eq(loc.descriptor.env?.HARBOR_WB_SLUG, 'thing-cli', 'slug');
eq(loc.descriptor.env?.HARBOR_WB_PANEID, 'recipe:abc#1', 'paneid');
eq(loc.descriptor.env?.HARBOR_WB_VENDOR, 'cli-manager', 'vendor');

console.log('\n[broker-resident: the same, because the broker layers env overrides]');
const res = buildLaunch(recipe({}), RESIDENT, null, null, ID);
eq(res.descriptor.env?.HARBOR_WB_PANEID, 'recipe:abc#1', 'paneid reaches a remote broker spawn');
eq(res.brokerHost, 'homebase', 'and it is still routed to that broker');

console.log('\n[ssh: identity rides the COMMAND LINE, like the session id already does]');
const ssh = buildLaunch(recipe({ initCmd: 'htop' }), SSH, null, null, ID);
const remote = ssh.descriptor.args![2];
ok(
  remote.startsWith("export HARBOR_WB_SLUG='thing-cli' HARBOR_WB_PANEID='recipe:abc#1' HARBOR_WB_VENDOR='cli-manager'; "),
  `the export is FIRST, before the cd and before the CLI: ${remote}`,
);
ok(remote.includes("cd '/srv/code/thing'"), 'and the cd still happens');
ok(
  remote.indexOf('export ') < remote.indexOf('$SHELL -lic'),
  'set before the -lic shell that runs the CLI...',
);
ok(
  remote.endsWith('exec $SHELL -l'),
  '...and `export` (not a VAR=x prefix) so it survives into the after-exit shell too',
);
eq(ssh.descriptor.env?.HARBOR_WB_PANEID, 'recipe:abc#1', 'the ssh CLIENT carries it as well, so no pty is an exception');

console.log('\n[quoting: a shell metacharacter in a slug cannot escape]');
const nasty = buildLaunch(recipe({ agent: "a'b;rm -rf /" }), SSH, null, null, ID);
const nastyCmd = nasty.descriptor.args![2];
ok(
  nastyCmd.startsWith("export HARBOR_WB_SLUG='a'" + String.fromCharCode(92) + "''b;rm -rf /'"),
  `POSIX-quoted, single quote escaped: ${nastyCmd.slice(0, 60)}`,
);

console.log('\n[the vendor supplies the COMMAND LINE; the engine supplies the shell]');
const claudeSsh = buildLaunch(
  recipe({ vendor: 'claude-code', runClaude: 1, model: 'opus' }),
  SSH,
  null,
  null,
  ID,
);
ok(
  /\$SHELL -lic 'claude --model opus --session-id [0-9a-f-]{36}'/.test(claudeSsh.descriptor.args![2]),
  'claude over ssh: the -lic wrapper (2026-07-07) still wraps the vendor line',
);
eq(claudeSsh.vendor, 'claude-code', 'and the row records the brand');
const gemSsh = buildLaunch(recipe({ vendor: 'gemini-cli', model: 'flash', autoApprove: 'on' } as never), SSH, null, null, ID);
ok(
  gemSsh.descriptor.args![2].includes("$SHELL -lic 'gemini --approval-mode yolo --model flash'"),
  'GEMINI over ssh gets the SAME -lic wrapper — the rule is about the HOST, not the brand — and YOLO rides along (ticket)',
);
eq(gemSsh.vendor, 'gemini-cli', 'the row records gemini-cli');
eq(gemSsh.claudeSessionId, null, 'and banks no session id, because gemini cannot be told one');
const gemLocal = buildLaunch(recipe({ vendor: 'gemini-cli', autoApprove: 'on' } as never), LOCAL, null, null, ID);
eq(gemLocal.inject, 'gemini --approval-mode yolo', 'locally the vendor line is TYPED into the shell (debug transparency), YOLO on when the recipe says on');

console.log('\n[a vendor with no module is class 2: its initCmd, not a guess]');
for (const v of ['ollama', 'cli-manager']) {
  const c2 = buildLaunch(recipe({ vendor: v, initCmd: 'my-cli --go' }), LOCAL, null, null, ID);
  eq(c2.inject, 'my-cli --go', `${v}: launches from initCmd`);
  eq(c2.vendor, v, `${v}: and the row still records the brand label`);
  const c2ssh = buildLaunch(recipe({ vendor: v, initCmd: 'my-cli --go' }), SSH, null, null, ID);
  ok(c2ssh.descriptor.args![2].includes("$SHELL -lic 'my-cli --go'"), `${v}: over ssh too`);
}

console.log('\n[codex-cli has a module: its invocation is launched, never the initCmd]');
const cx = buildLaunch(recipe({ vendor: 'codex-cli', initCmd: 'my-cli --go' }), LOCAL, null, null, ID);
ok(cx.inject?.startsWith('codex --no-alt-screen') && !cx.inject.includes('my-cli'), 'locally the codex line is typed, initCmd ignored');
eq(cx.vendor, 'codex-cli', 'the row records the brand');
eq(cx.claudeSessionId, null, 'and banks no id (the first hook does)');
const cxSsh = buildLaunch(recipe({ vendor: 'codex-cli', initCmd: 'my-cli --go' }), SSH, null, null, ID);
ok(cxSsh.descriptor.args![2].includes("$SHELL -lic 'codex --no-alt-screen") && !cxSsh.descriptor.args![2].includes('my-cli'), 'over ssh: the same -lic wrapper, invocation not initCmd');

console.log('\n[no paneid = no claim about one]');
const anon = buildLaunch(recipe({}), LOCAL);
eq(anon.descriptor.env?.HARBOR_WB_PANEID, undefined, 'an unidentified launch exports no pane id rather than a wrong one');
eq(anon.descriptor.env?.HARBOR_WB_SLUG, 'thing-cli', 'but the slug is a recipe fact and is still known');

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
