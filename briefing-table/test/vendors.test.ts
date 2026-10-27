/**
 * THE VENDOR SEAM (contract §5.1) and vendor #2.
 *
 * What these assertions are actually defending, in order of how expensive the
 * failure is:
 *
 *  1. THE RULE THAT LOSES CONVERSATIONS. "Can this come back" existed in two
 *     copies — `end-state.ts` asking the claude module, and the boot-reconcile
 *     SQL spelling `vendor='claude-code'` by hand. The contract recorded that
 *     as the hazard for whoever added vendor #2, because when the copies
 *     disagree a restorable session is filed `killed` and never offered again.
 *     There is one copy now; these assertions are what keeps it one.
 *  2. THE REFACTOR THAT MUST NOT MOVE. claude-code's `vendorModule` is an
 *     ADAPTER over the functions that were already in production. If it ever
 *     stops being the same functions, the reference conformer is a rewrite.
 *  3. GEMINI'S COMMAND LINE, which is DRAFT (a real `gemini` now runs under the
 *     `gem-ops` account, but its home is unreadable by `svc-ops` — see
 *     the vendor module's header, ticket) and so is tested for the SHAPE the
 *     docs specify, not for a behaviour anyone has observed. Read
 *     `GEMINI_CLI_FLAGS_VERIFIED` before trusting any of it.
 *
 * Run with tsx (TS + the vendor modules).
 */
import { endStateFor } from '../src/engine/end-state.ts';
import {
  vendorFor,
  isResumableVendor,
  resumableVendors,
  vendorsWithModules,
} from '../src/engine/vendors/index.ts';
import * as claudeCode from '../src/engine/vendors/claude-code.ts';
import * as gemini from '../src/engine/vendors/gemini-cli.ts';
import { RECIPE_VENDORS, isRecipeVendor } from '../src/table/store.ts';
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
  ok(
    Object.is(actual, expected),
    `${msg} (got ${JSON.stringify(actual)}${Object.is(actual, expected) ? '' : `, wanted ${JSON.stringify(expected)}`})`,
  );
}

/** A recipe with only the fields a vendor invocation may read. */
function recipe(over: Partial<Recipe>): Recipe {
  return {
    id: 'r1',
    name: 'Test',
    target: 'local',
    projectDir: '/tmp/proj',
    vendor: 'cli-manager',
    agent: 'test-cli',
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

console.log('\n[the enum is CLOSED, and membership has one test]');
for (const v of ['claude-code', 'cli-manager', 'gemini-cli', 'codex-cli', 'ollama']) {
  ok(isRecipeVendor(v), `"${v}" is an enum member`);
}
ok(!isRecipeVendor('gemini'), 'the almost-right spelling "gemini" is NOT a member');
ok(!isRecipeVendor('claude'), '"claude" is NOT a member');
ok(!isRecipeVendor(''), 'empty string is not a member');
ok(!isRecipeVendor(undefined), 'undefined is not a member');
eq(RECIPE_VENDORS.length, 5, 'five values in the enum');
ok(
  RECIPE_VENDORS.every((v) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)),
  'every value obeys the naming rule (lowercase, single hyphens)',
);

console.log('\n[a value is a LABEL; a module is optional (contract §1.1 step 2)]');
ok(vendorFor('claude-code'), 'claude-code has a module');
ok(vendorFor('gemini-cli'), 'gemini-cli has a module');
ok(vendorFor('codex-cli'), 'codex-cli has a module (Codex vendor, 2026-10-03)');
eq(vendorFor('ollama'), undefined, 'ollama is an accepted value with NO module (class 2)');
eq(vendorFor('cli-manager'), undefined, 'cli-manager is the generic class and has no module');
eq(vendorFor(null), undefined, 'a null vendor has no module');
eq(vendorsWithModules().length, 3, 'exactly three modules today');

console.log('\n[ONE source of truth for "can this come back"]');
eq(isResumableVendor('claude-code'), true, 'claude-code is resumable');
eq(isResumableVendor('gemini-cli'), true, 'gemini-cli is resumable');
eq(isResumableVendor('cli-manager'), false, 'a bare shell is not');
eq(isResumableVendor('codex-cli'), true, 'codex-cli is resumable');
eq(isResumableVendor('ollama'), false, 'a value with no module is not resumable');
eq(isResumableVendor('unknown'), false, 'an unrecorded vendor is not resumable');
ok(
  resumableVendors().every((v) => vendorFor(v)!.resumable),
  'resumableVendors() only names modules that say they are resumable',
);
ok(
  vendorsWithModules()
    .filter((v) => vendorFor(v)!.resumable)
    .every((v) => resumableVendors().includes(v)),
  'and it names ALL of them — the boot sweep cannot silently omit a vendor',
);
ok(
  resumableVendors().every((v) => isRecipeVendor(v)),
  'every resumable vendor is also an enum member (or nothing could save a recipe for it)',
);

console.log('\n[end-state derives from the same rule]');
eq(endStateFor('reaped', 'gemini-cli'), 'dehydrated', 'a reaped gemini session is filed restorable');
eq(endStateFor('reaped', 'ollama'), 'killed', 'a reaped class-2 session is filed killed');
eq(endStateFor('user', 'gemini-cli'), 'killed', 'a deliberate end stays ended, whatever the brand');

console.log('\n[every module answers the REQUIRED half of the interface]');
for (const v of vendorsWithModules()) {
  const m = vendorFor(v)!;
  eq(m.vendor, v, `${v}: registry key matches the module's own vendor value`);
  eq(typeof m.invocation, 'function', `${v}: invocation() is required and present`);
  eq(typeof m.reconcile, 'function', `${v}: reconcile() is required and present`);
  eq(typeof m.resumable, 'boolean', `${v}: resumable is a boolean`);
  eq(
    m.reconcile(),
    m.resumable ? 'dehydrated' : 'killed',
    `${v}: reconcile() agrees with resumable (§5.2 — getting this wrong loses a conversation)`,
  );
}

console.log('\n[claude-code: the adapter IS the proven functions, not a rewrite]');
const cc = vendorFor('claude-code')!;
eq(cc.invocation, claudeCode.buildInvocation, 'invocation === buildInvocation');
eq(cc.mintSessionId, claudeCode.mintSessionId, 'mintSessionId === mintSessionId');
eq(cc.locate, claudeCode.locateCurrentSessionId, 'locate === locateCurrentSessionId');
eq(cc.transcriptPath, claudeCode.transcriptPath, 'transcriptPath === transcriptPath');
eq(cc.listSessions, claudeCode.listSessions, 'listSessions === listSessions');
eq(cc.ack, claudeCode.ackTranscript, 'ack === ackTranscript');
eq(cc.discoverSessionId, undefined, 'discoverSessionId is ABSENT — claude mints, so nothing races');

console.log('\n[claude-code invocation is unchanged by the refactor]');
const claudeRecipe = recipe({ vendor: 'claude-code', runClaude: 1 });
const fresh = cc.invocation(claudeRecipe, { remote: false })!;
ok(/^claude --session-id [0-9a-f-]{36}$/.test(fresh.cmd), `fresh mints an id: ${fresh.cmd}`);
eq(fresh.sessionId, fresh.cmd.split(' ').pop(), 'the minted id is the banked id');
const restored = cc.invocation(claudeRecipe, { remote: false, resumeSessionId: 'abc-123' })!;
eq(restored.cmd, 'claude --resume abc-123', 'uuid restore reopens that conversation');
eq(restored.sessionId, 'abc-123', 'and banks it again for the next crash');
const named = cc.invocation(claudeRecipe, { remote: false, resumeName: 'my session' })!;
eq(named.cmd, 'claude --resume "my session"', 'named resume, local quoting');
eq(named.sessionId, null, 'a named resume banks NO id — it is genuinely unknowable');
eq(
  cc.invocation(claudeRecipe, { remote: true, resumeName: 'my session' })!.cmd,
  "claude --resume 'my session'",
  'named resume, POSIX quoting for the remote side',
);
/* QUOTES ARE STRIPPED FROM A NAME BEFORE IT IS QUOTED, on both sides. Pinned
   because it is surprising and pre-dates this work: a session called `o'brien`
   resumes as `obrien`, which either matches a real session or fails visibly —
   it never injects. Gemini copies the rule deliberately, so two brands cannot
   disagree about what a name means. */
eq(
  cc.invocation(claudeRecipe, { remote: true, resumeName: "o'brien" })!.cmd,
  "claude --resume 'obrien'",
  'a quote inside a name is stripped, not escaped',
);
eq(cc.invocation(recipe({ vendor: 'cli-manager' }), { remote: false }), null,
  'a shell recipe is not claude-code\'s');

console.log('\n[gemini-cli: a draft, shaped by ONE fact — there is no --session-id]');
const g = vendorFor('gemini-cli')!;
eq(gemini.GEMINI_CLI_FLAGS_VERIFIED, true, 'flags verified against gemini 0.62.0 (ticket; --resume <uuid> still unconfirmed, see the module)');
const gRecipe = recipe({ vendor: 'gemini-cli' });
const gFresh = g.invocation(gRecipe, { autoApprove: 'on', remote: false })!;
eq(gFresh.cmd, 'gemini --approval-mode yolo', 'a fresh session is a bare launch, YOLO always on (ticket)');
eq(gFresh.sessionId, null, 'and banks NOTHING — gemini cannot be told its id');
eq(g.mintSessionId, undefined, 'mintSessionId is ABSENT: no flag to mint into');
eq(g.discoverSessionId, undefined, 'discoverSessionId is ABSENT: that is the librarian (§5.3)');
eq(g.locate, undefined, 'locate is ABSENT');
eq(g.transcriptPath, undefined, 'transcriptPath is ABSENT — the project_hash is undocumented, so we do NOT guess it');
eq(g.listSessions, undefined, 'listSessions is ABSENT: `gemini --list-sessions` output format is undocumented');
eq(g.ack, undefined, 'ack is ABSENT: nothing to look for, with no known path');
eq(
  g.invocation(recipe({ vendor: 'gemini-cli', model: 'flash' }), { autoApprove: 'on', remote: false })!.cmd,
  'gemini --approval-mode yolo --model flash',
  'the recipe model rides --model, and the VENDOR spells the flag, alongside YOLO',
);
const gRestore = g.invocation(gRecipe, { autoApprove: 'on', remote: false, resumeSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })!;
eq(gRestore.cmd, 'gemini --approval-mode yolo --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'resume by full uuid, YOLO still on');
eq(gRestore.sessionId, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'a uuid restore banks the uuid');
const gLatest = g.invocation(gRecipe, { autoApprove: 'on', remote: false, resumeName: 'latest' })!;
eq(gLatest.cmd, 'gemini --approval-mode yolo --resume "latest"', 'the named-resume flow is gemini\'s only working restore today, YOLO still on');
eq(gLatest.sessionId, null, 'and it banks NULL — "latest" is a POINTER, never an identity');
eq(
  g.invocation(gRecipe, { autoApprove: 'on', remote: true, resumeName: 'latest' })!.cmd,
  "gemini --approval-mode yolo --resume 'latest'",
  'POSIX quoting on the remote side',
);
eq(
  g.invocation(gRecipe, { autoApprove: 'on', remote: false, resumeName: '' })!.cmd,
  'gemini --approval-mode yolo',
  'an EMPTY name is a fresh session, not a silent "latest" — gemini has no picker flag',
);
eq(g.invocation(recipe({ vendor: 'claude-code', runClaude: 1 }), { autoApprove: 'on', remote: false }), null,
  'a claude recipe is not gemini\'s');
eq(
  g.invocation(gRecipe, { autoApprove: 'on', remote: true, resumeName: "o'brien" })!.cmd,
  "gemini --approval-mode yolo --resume 'obrien'",
  'gemini strips a quote from a name the same way claude does',
);

console.log('\n[gemini-cli: YOLO / auto-approve (ticket)]');
eq(
  gemini.buildInvocation(gRecipe, { autoApprove: 'on', remote: false })!.cmd.split(' ').slice(0, 3).join(' '),
  'gemini --approval-mode yolo',
  'YOLO is the modern, non-deprecated flag (`--approval-mode yolo`), not the deprecated `--yolo`/`-y`',
);
ok(
  !gemini.buildInvocation(gRecipe, { autoApprove: 'on', remote: false })!.cmd.includes('--yolo'),
  'the deprecated --yolo/-y spelling is never emitted',
);
ok(
  [
    gemini.buildInvocation(gRecipe, { autoApprove: 'on', remote: false })!,
    gemini.buildInvocation(recipe({ vendor: 'gemini-cli', model: 'pro' }), { autoApprove: 'on', remote: false })!,
    gemini.buildInvocation(gRecipe, { autoApprove: 'on', remote: false, resumeSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })!,
    gemini.buildInvocation(gRecipe, { autoApprove: 'on', remote: true, resumeName: 'latest' })!,
  ].every((inv) => inv.cmd.includes('--approval-mode yolo')),
  'YOLO rides EVERY invocation shape — fresh, model, uuid-resume, named-resume — never conditional',
);
eq(g.invocation(gRecipe, { remote: false })!.cmd, 'gemini', 'auto-approve defaults OFF: no yolo unless the recipe\'s effective value is on (H1)');
console.log('\n[precedence is the engine\'s and both modules honour it: uuid > name > fresh]');
for (const [label, m] of [['claude-code', cc], ['gemini-cli', g]] as const) {
  const both = m.invocation(recipe({ vendor: label, runClaude: label === 'claude-code' ? 1 : 0 }), {
    remote: false,
    resumeSessionId: 'uuid-wins',
    resumeName: 'name-loses',
  })!;
  ok(both.cmd.includes('uuid-wins') && !both.cmd.includes('name-loses'), `${label}: uuid beats name`);
}

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
