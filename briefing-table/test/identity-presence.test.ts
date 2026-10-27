/**
 * The one identity key, and what the engine says about it on the pulse plane.
 *
 * Two things are tested here because they are two halves of one fact: a slug
 * that is not a legal slug is not a naming inconvenience, it is a NATS subject
 * that publishes somewhere nobody is listening. `agent.<slug>.state` puts the
 * slug INSIDE subject syntax, where `.`, `*` and `>` mean something, so the
 * normaliser's output alphabet is the only thing standing between a typed
 * project name and a silently wrong subject.
 *
 * Run with tsx.
 */
process.env.HARBOR_WB_NATS_URL = ''; // never touch the network from a test

const slug = await import('../src/engine/agent-slug.ts');
const presence = await import('../src/engine/presence.ts');
const telemetry = await import('../src/engine/telemetry.ts');

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

console.log('\n[normalise: whatever a human typed becomes a legal slug]');
eq(slug.normalizeSlug('Briefing Table'), 'briefing-table', 'spaces and case');
eq(slug.normalizeSlug('  HomeHub-2  '), 'homehub-2', 'trims and lowercases');
eq(slug.normalizeSlug('--platform--'), 'platform', 'strips leading/trailing hyphens');
eq(slug.normalizeSlug('a//b\\\\c'), 'a-b-c', 'a run of junk collapses to ONE hyphen');
eq(slug.normalizeSlug(''), null, 'empty is null, never an empty slug');
eq(slug.normalizeSlug('!!!'), null, 'nothing usable is null');
eq(slug.normalizeSlug(42), null, 'a non-string is null');

console.log('\n[the output alphabet is the NATS subject guard, not a style rule]');
/* `.` splits a subject, `*` and `>` are wildcards. Any of them surviving here
   would publish `agent.a.b.state` or subscribe the world. */
for (const evil of ['agent.state', 'proj*', 'proj>', 'a.b.c']) {
  const out = slug.normalizeSlug(evil);
  eq(out !== null && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(out), true, `"${evil}" cannot carry subject syntax`);
}
eq(slug.isSlug('briefing-table'), true, 'isSlug accepts a legal slug');
eq(slug.isSlug('Briefing-Table'), false, 'isSlug does NOT coerce — uppercase is refused');
eq(slug.isSlug('a..b'), false, 'isSlug refuses subject syntax');

console.log('\n[basename: both separator conventions, because both paths are real]');
eq(slug.projectBasename('/srv/code/auriga'), 'auriga', 'posix');
eq(slug.projectBasename('C:\\Code\\briefing-table'), 'briefing-table', 'windows');
/* The 2026-09-13 bug, one layer down: a trailing separator must not yield an
   EMPTY basename. That one character cost Kiosk its name for days. */
eq(slug.projectBasename('/srv/code/kiosk/'), 'kiosk', 'trailing separator');
eq(slug.projectBasename('C:\\Code\\thing\\\\'), 'thing', 'trailing separators, windows');

console.log('\n[derive: the default a recipe gets when the field is left empty]');
/* SUPERSEDES the `-cli` default (2026-09-17): the registry's node ids are the
   bare project name, and the fabric rejects a role-suffixed slug it does not
   know. The default is now the bare, normalised basename — no suffix. */
eq(slug.deriveSlug({ vendor: 'claude-code', projectDir: '/srv/code/auriga' }), 'auriga', 'bare basename, no role suffix');
eq(slug.deriveSlug({ vendor: 'claude-code', projectDir: 'C:\\Code\\briefing-table' }), 'briefing-table', 'windows path');
eq(slug.deriveSlug({ vendor: 'claude-code', projectDir: null, name: 'Home Hub' }), 'home-hub', 'falls back to the name');
eq(slug.deriveSlug({ vendor: 'claude-code', projectDir: null, name: null }), null, 'nothing to derive from → NO slug, never a made-up one');
/* A folder that already looks like a role-suffixed name is not special-cased
   any more — there is no suffix to stack or dedupe. */
eq(slug.deriveSlug({ vendor: 'claude-code', projectDir: '/srv/code/auriga-cli' }), 'auriga-cli', 'basename is taken as-is');

console.log('\n[resolve: typed wins, empty derives]');
eq(slug.resolveSlug('Platform Opus', { vendor: 'claude-code', projectDir: '/x/y' }), 'platform-opus', 'typed value is normalised');
eq(slug.resolveSlug('', { vendor: 'claude-code', projectDir: '/x/y' }), 'y', 'empty derives');
eq(slug.resolveSlug(null, { vendor: 'claude-code', projectDir: '/x/y' }), 'y', 'null derives');
eq(slug.resolveSlug('   ', { vendor: 'claude-code', projectDir: '/x/y' }), 'y', 'whitespace derives');

console.log('\n[presence: the subject and the payload that reach the pulse plane]');
const sent: Array<{ subject: string; body: any }> = [];
telemetry.setPublisher((subject, body) => sent.push({ subject, body: JSON.parse(body) }));
presence.reset();

presence.publish({
  slug: 'briefing-table-cli',
  vendor: 'claude-code',
  node: 'vrpc',
  paneid: 'recipe:abc',
  state: 'streaming',
  attached: true,
  project: 'C:\\Code\\briefing-table',
  ts: '2026-09-17T00:00:00.000Z',
});
eq(sent.length, 1, 'a state change publishes');
eq(sent[0].subject, 'agent.briefing-table-cli.state', 'subject is agent.<slug>.state');
eq(sent[0].body.slug, 'briefing-table-cli', 'payload carries the slug');
eq(sent[0].body.vendor, 'claude-code', 'payload carries the vendor');
eq(sent[0].body.node, 'vrpc', 'payload carries the node');
eq(sent[0].body.paneid, 'recipe:abc', 'payload carries the paneid as lineage');
eq(sent[0].body.state, 'streaming', 'payload carries the state');
eq(sent[0].body.attached, true, 'payload carries attached');
eq(sent[0].body.project, 'C:\\Code\\briefing-table', 'payload carries the project');
eq(typeof sent[0].body.ts, 'string', 'payload carries a ts');

console.log('\n[presence: unchanged state is not republished]');
presence.publish({
  slug: 'briefing-table-cli', vendor: 'claude-code', node: 'vrpc', paneid: 'recipe:abc',
  state: 'streaming', attached: true, ts: '2026-09-17T00:00:01.000Z',
});
eq(sent.length, 1, 'a duplicate is dropped (the pulse plane is already noisy)');
presence.publish({
  slug: 'briefing-table-cli', vendor: 'claude-code', node: 'vrpc', paneid: 'recipe:abc',
  state: 'streaming', attached: false, ts: '2026-09-17T00:00:02.000Z',
});
eq(sent.length, 2, 'attached is part of presence — parking republishes');

console.log('\n[presence: two panes on one slug do not silence each other]');
presence.publish({
  slug: 'briefing-table-cli', vendor: 'claude-code', node: 'vrpc', paneid: 'recipe:abc#2',
  state: 'streaming', attached: true, ts: '2026-09-17T00:00:03.000Z',
});
eq(sent.length, 3, 'the second pane publishes its own identical state');

console.log('\n[presence: ended, and a relaunch is not deduped against a dead state]');
presence.end({
  slug: 'briefing-table-cli', vendor: 'claude-code', node: 'vrpc', paneid: 'recipe:abc',
  ts: '2026-09-17T00:00:04.000Z',
});
eq(sent[sent.length - 1].body.state, 'ended', 'end publishes state=ended');
eq(sent[sent.length - 1].body.attached, false, 'and attached=false');
const beforeRelaunch = sent.length;
presence.publish({
  slug: 'briefing-table-cli', vendor: 'claude-code', node: 'vrpc', paneid: 'recipe:abc',
  state: 'idle', attached: true, ts: '2026-09-17T00:00:05.000Z',
});
eq(sent.length, beforeRelaunch + 1, 'the relaunch publishes');

console.log('\n[presence: an illegal slug is DROPPED, never sanitised into a subject]');
const before = sent.length;
const out = presence.publish({
  slug: 'Not A Slug.*', vendor: 'cli-manager', node: 'homebase', paneid: 'p',
  state: 'idle', attached: true, ts: '2026-09-17T00:00:06.000Z',
});
eq(out, false, 'publish reports it did not go out');
eq(sent.length, before, 'and nothing reached the wire');

console.log('\n[presence: the activity word -> contract §3 (waiting-seen folds, ticket)]');
eq(presence.presenceStateOf('waiting-seen'), 'waiting', 'seen-but-unanswered is still `waiting` on the fabric');
for (const w of ['streaming', 'background', 'idle', 'waiting', 'disconnected']) {
  eq(presence.presenceStateOf(w), w, `${w} passes through unchanged`);
}

console.log('\n[diag: the last payload per slug, for /api/diag/presence]');
const dumped = presence.dump();
eq(dumped.subject, 'agent.<slug>.state', 'diag states the subject shape');
eq(dumped.agents.length, 1, 'one slug tracked');
eq(dumped.agents[0].state, 'idle', 'and it holds the LAST payload emitted');

telemetry.setPublisher(null);
console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
