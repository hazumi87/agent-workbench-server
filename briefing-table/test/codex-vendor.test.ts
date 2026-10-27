/**
 * The Codex vendor (Owner 2026-10-03), pure halves: the command line, the hooks
 * file merge, the hook sink's handler and its auth exemption, the per-vendor
 * effort vocabulary, recipe vendorArgs validation, the shared UI list source and
 * the room-typer guard. Payloads are shaped exactly like the live ones recorded
 * from codex-cli 0.160.0 (KB design-notes-id). No Codex is launched.
 * Run with tsx.
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as codex from '../src/engine/vendors/codex-cli.ts';
import { vendorFor, isResumableVendor, resumableVendors } from '../src/engine/vendors/index.ts';
import { buildLaunch, type Target } from '../src/engine/launch.ts';
import { mergeHooks, ensureHooksFile, hookCommand, HOOK_EVENTS, HOOK_MARKER } from '../src/engine/codex-hooks.ts';
import { handleAgentHook } from '../src/engine/agent-hook.ts';
import { isLocalHookDelivery } from '../src/server/auth.ts';
import { RECIPE_EFFORTS, CODEX_EFFORTS, EFFORTS_BY_VENDOR, isEffortFor, effortsFor, applyLaunchOverrides, resolveLaunchProfile } from '../src/engine/effort.ts';
import { parseVendorArgs, readStoredVendorArgs } from '../src/engine/vendor-args.ts';
import { blockReason } from '../src/engine/room-typer.ts';
import * as claudeCode from '../src/engine/vendors/claude-code.ts';
import * as ui from '../web/vendor-profile.mjs';
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
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${msg} (got ${a}${a === b ? '' : `, wanted ${b}`})`);
}
function recipe(over: Partial<Recipe>): Recipe {
  return {
    id: 'r1', name: 'Asset operator', target: 'homebase-chat-ops', projectDir: '/srv/agents/other-builder',
    vendor: 'codex-cli', agent: 'asset-worker', runClaude: 0, model: null, effort: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null,
    fontSize: null, logo: null, created_at: 0, updated_at: 0, last_launched_at: null,
    ...over,
  } as Recipe;
}
const DIR = '/srv/agents/other-builder';
const TRUST = `-c 'projects."${DIR}".trust_level="trusted"'`;
const DEFAULTS = `--no-alt-screen --dangerously-bypass-hook-trust -c 'sandbox_mode="workspace-write"' -c 'approval_policy="on-request"' ${TRUST}`;
const SID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b';

console.log('[registry]');
ok(vendorFor('codex-cli') === codex.vendorModule, 'codex-cli is registered');
ok(isResumableVendor('codex-cli'), 'resumable');
ok(resumableVendors().includes('codex-cli'), 'the boot-reconcile SQL list includes it');
eq(codex.vendorModule.reconcile(), 'dehydrated', 'a stale live row reconciles to dehydrated');
ok(!codex.vendorModule.mintSessionId && !codex.vendorModule.locate && !codex.vendorModule.listSessions, 'no mint / locate / listing (the id arrives by hook)');

console.log('\n[command line]');
eq(codex.buildInvocation(recipe({}), { remote: false }), { cmd: `codex ${DEFAULTS}`, sessionId: null }, 'fresh, no model, no effort: defaults only, session id null');
eq(codex.buildInvocation(recipe({ model: 'gpt-6-luna', effort: 'low' }), { remote: false })?.cmd,
  `codex --model gpt-6-luna -c 'model_reasoning_effort="low"' ${DEFAULTS}`, 'fresh with model + effort');
eq(codex.buildInvocation(recipe({ model: 'gpt-5.6-terra' }), { remote: false })?.cmd, `codex --model gpt-5.6-terra ${DEFAULTS}`, 'model only; dots need no quoting');
{
  const L = 'cd /srv/agents/other-builder && ~/.local/bin/codex-mcp-env.sh codex';
  eq(codex.buildInvocation(recipe({ initCmd: L }), { remote: false })?.cmd, `${L} ${DEFAULTS}`, 'an initCmd ending in codex is the launcher prefix');
  eq(codex.buildInvocation(recipe({ initCmd: L }), { remote: false, resumeSessionId: '01a104e2-f503-7113-891f-f2ba73e6f026' })?.cmd.startsWith(`${L} resume 01a104e2-f503-7113-891f-f2ba73e6f026 `), true, 'resume goes through the launcher');
  eq(codex.buildInvocation(recipe({ initCmd: 'echo hi' }), { remote: false })?.cmd, `codex ${DEFAULTS}`, 'any other initCmd is ignored');
}
eq(codex.buildInvocation(recipe({ effort: 'max' }), { remote: false })?.cmd, `codex -c 'model_reasoning_effort="max"' ${DEFAULTS}`, 'effort only');
eq(codex.buildInvocation(recipe({ effort: 'ultracode' }), { remote: false })?.cmd, `codex ${DEFAULTS}`, "claude's effort word never reaches a codex line");
eq(codex.buildInvocation(recipe({ model: 'gpt-6-luna', effort: 'low' }), { remote: false, resumeSessionId: SID }),
  { cmd: `codex resume ${SID} --model gpt-6-luna -c 'model_reasoning_effort="low"' ${DEFAULTS}`, sessionId: SID }, 'resume by id: same flags, id kept');
eq(codex.buildInvocation(recipe({}), { remote: false, resumeName: 'plan' }), { cmd: `codex resume "plan" ${DEFAULTS}`, sessionId: null }, 'named resume (local)');
eq(codex.buildInvocation(recipe({}), { remote: true, resumeName: "it's" })?.cmd, `codex resume 'its' ${DEFAULTS}`, 'named resume (remote): quotes stripped, POSIX-quoted');
eq(codex.buildInvocation(recipe({}), { remote: false, resumeName: '' })?.cmd, `codex ${DEFAULTS}`, 'an empty resume name is a fresh session (no picker form)');
eq(codex.buildInvocation(recipe({}), { remote: false, resumeSessionId: SID, resumeName: 'plan' })?.cmd.startsWith(`codex resume ${SID} `), true, 'uuid beats name');
eq(codex.buildInvocation(recipe({ projectDir: null }), { remote: false })?.cmd, 'codex --no-alt-screen --dangerously-bypass-hook-trust -c \'sandbox_mode="workspace-write"\' -c \'approval_policy="on-request"\'', 'no project dir: nothing to trust');
ok(!codex.buildInvocation(recipe({ projectDir: '/tmp/a"b' }), { remote: false })?.cmd.includes('trust_level'), 'a dir that cannot be written as a TOML string is not trusted (never mis-escaped)');
ok(!codex.buildInvocation(recipe({ projectDir: 'C:\\code\\x' }), { remote: false })?.cmd.includes('trust_level'), 'a backslash dir is not trusted either');
eq(codex.buildInvocation(recipe({ vendor: 'claude-code' }), { remote: false }), null, 'not a codex recipe: no invocation');

console.log('\n[vendorArgs: appended AFTER the defaults, so a later -c wins]');
const va = ['-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'sandbox_workspace_write.writable_roots=["/tmp"]', '--add-dir', '/srv/code/tools/image-studio/status'];
const withArgs = codex.buildInvocation(recipe({ vendorArgs: va }), { remote: false })!.cmd;
ok(withArgs.indexOf("'approval_policy=\"on-request\"'") < withArgs.indexOf("'approval_policy=\"never\"'"), 'approval override comes after the default');
ok(withArgs.endsWith(`-c 'sandbox_workspace_write.writable_roots=["/tmp"]' --add-dir /srv/code/tools/image-studio/status`), 'writable_roots survives as ONE quoted argument; a plain path is bare');
ok(withArgs.includes('-c sandbox_workspace_write.network_access=true'), 'a safe token is left bare');
ok(codex.buildInvocation(recipe({ vendorArgs: ["it's a value"] }), { remote: false })!.cmd.endsWith(`'it'\\''s a value'`), 'a value with a quote is POSIX-escaped');
ok(codex.buildInvocation(recipe({ vendorArgs: ['--x'] }), { remote: false, resumeSessionId: SID })!.cmd.endsWith('--x'), 'vendorArgs ride a resume too');
ok(!claudeCode.buildInvocation(recipe({ vendor: 'claude-code', runClaude: 1, vendorArgs: ['--x'] }), { remote: false })!.cmd.includes('--x'), 'a claude line never carries vendorArgs');

console.log('\n[launch plumbing: a vendor with an invocation is launched, not typed]');
const broker: Target = { id: 'homebase-chat-ops', label: 'x', kind: 'local', broker: 'chatgpt', node: 'homebase' };
const spec = buildLaunch(recipe({ model: 'gpt-6-luna', initCmd: 'echo not-this' }), broker, null, null, { paneid: 'recipe:r1' });
ok(spec.inject?.startsWith('codex --model gpt-6-luna') && !spec.inject.includes('not-this'), 'broker-resident: the invocation is injected, initCmd ignored');
eq([spec.vendor, spec.claudeSessionId, spec.descriptor.env?.HARBOR_WB_PANEID, spec.descriptor.env?.HARBOR_WB_VENDOR], ['codex-cli', null, 'recipe:r1', 'codex-cli'], 'vendor, no banked id, pane id + vendor in the pane env');
const sshT: Target = { id: 'x', label: 'x', kind: 'ssh', sshAlias: 'homeserver-chat-ops', broker: 'local' };
const sshSpec = buildLaunch(recipe({}), sshT, null, null, { paneid: 'p' });
ok(sshSpec.descriptor.args[2].includes("$SHELL -lic 'codex "), 'ssh: through the interactive login shell like the others');

console.log('\n[hooks file merge]');
const fresh = mergeHooks(null, 8201) as any;
eq(Object.keys(fresh.hooks), [...HOOK_EVENTS], 'every event gets an entry');
ok(HOOK_EVENTS.includes('SessionStart' as any) && HOOK_EVENTS.includes('PermissionRequest' as any) && HOOK_EVENTS.includes('Stop' as any) && HOOK_EVENTS.includes('UserPromptSubmit' as any), 'the events the sink acts on are subscribed');
eq(fresh.hooks.Stop, [{ hooks: [{ type: 'command', command: hookCommand(8201) }] }], 'Codex schema: {hooks:{Event:[{hooks:[{type,command}]}]}}');
ok(hookCommand(8201).includes(`http://127.0.0.1:8201/api/agent-hook?vendor=codex-cli&paneid=$(printf '%s' "$HARBOR_WB_PANEID" | sed 's/#/%23/g')`) && hookCommand(8201).endsWith('|| true'), 'posts to the engine port with the pane id ENCODED for transport (a fresh pane\'s # is not a fragment), never fails the hook');
ok(hookCommand(8201).includes('--data-binary @-'), 'forwards stdin');
eq(mergeHooks(fresh, 8201), fresh, 'idempotent');
const foreign = { hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'notify-send done' }] }], Custom: [{ hooks: [] }] }, other: 1 };
const merged = mergeHooks(foreign, 8201) as any;
ok(merged.hooks.Stop.length === 2 && merged.hooks.Stop[0].hooks[0].command === 'notify-send done', 'a foreign hook is kept, ours is added');
eq([merged.other, merged.hooks.Custom], [1, [{ hooks: [] }]], 'unknown keys and foreign events survive');
const moved = mergeHooks(merged, 8300) as any;
ok(moved.hooks.Stop.length === 2 && moved.hooks.Stop[1].hooks[0].command.includes(':8300/') && !JSON.stringify(moved).includes(':8201/'), 'a port change replaces ours and nothing else');
ok(JSON.stringify(moved).split(HOOK_MARKER).length - 1 === HOOK_EVENTS.length, 'exactly one of ours per event');
const tmp = mkdtempSync(join(tmpdir(), 'codex-hooks-'));
try {
  const r1 = ensureHooksFile(tmp, 8201);
  eq(r1.status, 'written', 'first call writes');
  ok(existsSync(join(tmp, '.codex', 'hooks.json')), '.codex/hooks.json exists');
  eq(ensureHooksFile(tmp, 8201).status, 'unchanged', 'second call changes nothing');
  writeFileSync(join(tmp, '.codex', 'hooks.json'), '{ not json');
  const bad = ensureHooksFile(tmp, 8201);
  ok(bad.status === 'skipped' && readFileSync(join(tmp, '.codex', 'hooks.json'), 'utf8') === '{ not json', 'an unparseable file is left alone, with a reason');
  const nope = ensureHooksFile(join(tmp, 'missing', 'deep'), 8201);
  ok(nope.status === 'written' || nope.status === 'skipped', 'a missing dir never throws');
  mkdirSync(join(tmp, 'ro'), { recursive: true });
  chmodSync(join(tmp, 'ro'), 0o500);
  const blocked = ensureHooksFile(join(tmp, 'ro'), 8201);
  ok(blocked.status === 'skipped' || process.getuid?.() === 0 || process.platform === 'win32', 'an unwritable dir is skipped, not thrown (chmod cannot make a dir unwritable on Windows)');
  chmodSync(join(tmp, 'ro'), 0o700);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[hook sink handler]');
const rows: Record<string, any> = {
  'recipe:r1': { vendor: 'codex-cli', state: 'live', session_id: null },
  'claude:1': { vendor: 'claude-code', state: 'live', session_id: 'x' },
  'recipe:dead': { vendor: 'codex-cli', state: 'dehydrated', session_id: SID },
};
const calls: string[] = [];
const deps = {
  get: (id: string) => rows[id],
  adoptSessionId: (id: string, sid: string) => { calls.push(`adopt:${id}:${sid}`); rows[id].session_id = sid; },
  activity: {
    onTurnStart: (id: string) => calls.push(`turn:${id}`),
    onResponseDone: (id: string) => calls.push(`done:${id}`),
    onQuestion: (id: string) => calls.push(`question:${id}`),
  },
  log: (l: string) => calls.push(`log:${l}`),
};
const base = { session_id: SID, transcript_path: '/home/chat-ops/.codex/sessions/2026/10/03/rollout-x.jsonl', cwd: DIR, model: 'gpt-6-luna', permission_mode: 'default' };
const q = { vendor: 'codex-cli', paneid: 'recipe:r1' };
let r = handleAgentHook(q, { ...base, hook_event_name: 'SessionStart', source: 'startup' }, deps);
eq([r.matched, r.did, calls.filter((c) => !c.startsWith('log:'))], ['recipe:r1', ['session_id'], [`adopt:recipe:r1:${SID}`]], 'SessionStart banks the session id, moves no ring');
ok(calls.some((c) => c.startsWith('log:') && c.includes(SID.slice(0, 8)) && !c.includes(SID)), 'the bank is logged with a short id only');
calls.length = 0;
r = handleAgentHook(q, { ...base, hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'SECRET PROMPT TEXT' }, deps);
eq(calls, [`turn:recipe:r1`], 'UserPromptSubmit -> onTurnStart (same id: no re-bank)');
ok(!JSON.stringify(calls).includes('SECRET'), 'prompt text never reaches a call or log');
calls.length = 0;
handleAgentHook(q, { ...base, hook_event_name: 'Stop', turn_id: 't1', last_assistant_message: 'x' }, deps);
eq(calls, ['done:recipe:r1'], 'Stop -> onResponseDone');
calls.length = 0;
handleAgentHook(q, { ...base, hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { command: 'ls' } }, deps);
eq(calls, ['question:recipe:r1'], 'PermissionRequest -> onQuestion (needs you)');
calls.length = 0;
handleAgentHook(q, { ...base, hook_event_name: 'Interrupt' }, deps);
eq(calls, ['done:recipe:r1'], 'Interrupt -> onResponseDone');
calls.length = 0;
for (const ev of ['PreToolUse', 'PostToolUse', 'SessionEnd']) {
  handleAgentHook(q, { ...base, hook_event_name: ev, tool_name: 'shell', tool_input: {}, tool_use_id: 'u', tool_response: 'out' }, deps);
}
eq(calls, [], 'tool and end events change nothing');
calls.length = 0;
handleAgentHook(q, { ...base, session_id: '019a1b2c-ffff-7f50-8a6b-000000000000', hook_event_name: 'PostToolUse' }, deps);
ok(calls[0]?.startsWith('adopt:recipe:r1:019a1b2c-ffff'), 'a CHANGED session id (compaction / resume elsewhere) is re-banked');
calls.length = 0;
eq(handleAgentHook({ vendor: 'codex-cli', paneid: 'claude:1' }, { ...base, hook_event_name: 'Stop' }, deps).matched, null, "a pane whose vendor is not codex: no-op");
eq(handleAgentHook({ vendor: 'codex-cli', paneid: 'recipe:dead' }, { ...base, hook_event_name: 'Stop' }, deps).matched, null, 'a pane that is not live: no-op');
eq(handleAgentHook({ vendor: 'codex-cli', paneid: 'nope' }, { ...base, hook_event_name: 'Stop' }, deps).matched, null, 'an unknown pane: no-op');
eq(handleAgentHook({ vendor: 'claude-code', paneid: 'claude:1' }, { ...base, hook_event_name: 'Stop' }, deps).matched, null, 'a vendor the sink does not serve: no-op');
eq(handleAgentHook({ vendor: null, paneid: 'recipe:r1' }, { ...base, hook_event_name: 'Stop' }, deps).matched, null, 'no vendor: no-op');
eq(handleAgentHook({ vendor: 'codex-cli', paneid: null }, { ...base, hook_event_name: 'Stop' }, deps).matched, null, 'no pane id: no-op');
handleAgentHook(q, { session_id: "x'; DROP TABLE sessions;--", hook_event_name: 'SessionStart' }, deps);
ok(!calls.some((c) => c.startsWith('adopt')), 'a malformed session id is never banked');
eq(calls, [], 'nothing else happened');

console.log('\n[auth: the exemption is loopback + no forwarding + POST, for the two hook sinks only]');
const req = (method: string, ip: string, headers: Record<string, string> = {}) => ({ method, headers, socket: { remoteAddress: ip } }) as any;
ok(isLocalHookDelivery(req('POST', '127.0.0.1'), '/api/agent-hook'), 'agent-hook: loopback POST');
ok(isLocalHookDelivery(req('POST', '::ffff:127.0.0.1'), '/api/agent-hook'), 'agent-hook: mapped loopback');
ok(isLocalHookDelivery(req('POST', '127.0.0.1'), '/api/claude-hook'), 'claude-hook: unchanged');
ok(!isLocalHookDelivery(req('POST', '127.0.0.1', { 'x-forwarded-for': '100.1.2.3' }), '/api/agent-hook'), 'agent-hook: behind Serve (XFF) is NOT exempt');
ok(!isLocalHookDelivery(req('POST', '127.0.0.1', { 'x-forwarded-host': 'h' }), '/api/agent-hook'), 'agent-hook: forwarded host is NOT exempt');
ok(!isLocalHookDelivery(req('POST', '100.64.0.9'), '/api/agent-hook'), 'agent-hook: a remote address is NOT exempt');
ok(!isLocalHookDelivery(req('GET', '127.0.0.1'), '/api/agent-hook'), 'agent-hook: GET is NOT exempt');
for (const p of ['/api/agent-hook/x', '/api/handoff', '/api/url-offer', '/api/fabric/inbound', '/api/table', '/api/agent-hooks']) {
  ok(!isLocalHookDelivery(req('POST', '127.0.0.1'), p), `${p}: NOT exempt (the exemption did not grow)`);
}

console.log('\n[effort vocabulary per vendor]');
eq(effortsFor('codex-cli'), [...CODEX_EFFORTS], 'codex list');
ok(CODEX_EFFORTS.join() === 'low,medium,high,xhigh,max', 'low..max (codex debug models, Owner 2026-10-05)');
ok(isEffortFor('codex-cli', 'xhigh') && isEffortFor('codex-cli', 'max') && !isEffortFor('codex-cli', 'minimal') && !isEffortFor('codex-cli', 'ultracode') && !isEffortFor('codex-cli', 'bogus'), 'codex accepts low..max only (Owner 2026-10-05), not minimal nor claude-only words');
ok(isEffortFor('claude-code', 'ultracode') && !isEffortFor('claude-code', 'minimal'), 'claude unchanged');
ok(isEffortFor(undefined, 'high') && isEffortFor('cli-manager', 'max'), 'no vendor / shell = the historical claude list');
ok(!isEffortFor('gemini-cli', 'high') && !isEffortFor('ollama', 'low'), 'a vendor with no vocabulary accepts none');
eq(effortsFor('gemini-cli'), [], 'and lists none');
const saved = recipe({ model: 'gpt-5.5', effort: 'low' });
eq(applyLaunchOverrides(saved, { effort: 'xhigh' }).effort, 'xhigh', 'a codex launch override takes a codex word');
eq(applyLaunchOverrides(saved, { effort: 'ultracode' }).effort, 'low', "...and ignores claude's");
eq(applyLaunchOverrides(recipe({ vendor: 'claude-code', effort: 'low' }), { effort: 'ultracode' }).effort, 'ultracode', 'claude launch override unchanged');
eq(resolveLaunchProfile(undefined, saved, { effort: 'high' }), { model: 'gpt-5.5', effort: 'high', write: true }, 'the stored profile flows through unchanged (new mint)');
eq(resolveLaunchProfile({ state: 'live', profile_model: 'gpt-6-luna', profile_effort: 'high' }, saved, { effort: 'low' }), { model: 'gpt-6-luna', effort: 'high', write: false }, '...and an existing profile still wins');

console.log('\n[recipe vendorArgs validation]');
eq(parseVendorArgs(undefined), { ok: true, args: null }, 'absent = none');
eq(parseVendorArgs(''), { ok: true, args: null }, 'empty = none');
eq(parseVendorArgs(['-c', 'a=b']), { ok: true, args: ['-c', 'a=b'] }, 'an array of strings');
eq(parseVendorArgs('-c\n  \nsandbox_mode="read-only"\r\n'), { ok: true, args: ['-c', 'sandbox_mode="read-only"'] }, 'a string is one argument per line; blank lines dropped');
ok(!(parseVendorArgs(['ok', 3] as any) as any).ok, 'non-strings refused');
ok(!(parseVendorArgs({ a: 1 }) as any).ok, 'an object refused');
ok(!(parseVendorArgs(['a\nb']) as any).ok, 'a newline inside an entry refused');
ok(!(parseVendorArgs(['a\u001bb']) as any).ok, 'a control character refused');
ok(!(parseVendorArgs(['x'.repeat(501)]) as any).ok, 'an over-long entry refused');
ok(!(parseVendorArgs(Array(41).fill('x')) as any).ok, 'too many entries refused');
ok(!(parseVendorArgs(['']) as any).ok, 'an empty array entry refused');
eq(readStoredVendorArgs('["-c","a=b"]'), ['-c', 'a=b'], 'stored JSON reads back as a list');
eq([readStoredVendorArgs(null), readStoredVendorArgs('nonsense'), readStoredVendorArgs('[1]')], [null, null, null], 'malformed stored values read as none');

console.log('\n[UI lists: one place, per vendor, matching the engine]');
eq(ui.effortsFor('claude-code'), [...RECIPE_EFFORTS], 'claude efforts equal the engine list');
eq(ui.effortsFor('codex-cli'), [...CODEX_EFFORTS], 'codex efforts equal the engine list');
eq(ui.effortsFor(undefined), [...RECIPE_EFFORTS], 'no vendor = claude');
for (const v of Object.keys(EFFORTS_BY_VENDOR)) {
  eq(ui.effortsFor(v), [...EFFORTS_BY_VENDOR[v]], `${v}: every UI effort is one the engine validates`);
}
eq(ui.modelsFor('claude-code'), ['sonnet', 'opus', 'fable'], 'claude models, manager / room order');
eq(ui.cardModelsFor('claude-code'), ['opus', 'sonnet', 'fable'], 'claude models, profile-card order (as it was)');
eq(ui.modelsFor('codex-cli'), ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'], 'codex models (codex debug models 2026-10-05)');
eq(ui.cardModelsFor('codex-cli'), ui.modelsFor('codex-cli'), 'card falls back to the model list');
eq([ui.modelsFor('cli-manager'), ui.effortsFor('ollama')], [[], []], 'a vendor with no entry has no lists');
eq(ui.effortsFor('gemini-cli'), effortsFor('gemini-cli') as any, 'gemini: none on both sides');
const m = ui.modelsFor('claude-code');
m.push('x');
eq(ui.modelsFor('claude-code').length, 3, 'callers get a copy');

console.log('\n[typed delivery guard]');
const g = { enabled: true, live: true, vendor: 'codex-cli', claude: true, startup: false, blocked: null, state: 'idle', busy: false, draft: 'clean', now: 10_000, lastOutputAt: 0, settleMs: 500, awaitingIdle: false } as any;
eq(blockReason(g), null, 'idle codex pane: typeable');
eq(blockReason({ ...g, state: 'codex:busy' }), 'not-idle', 'mid-turn: held (only idle is typed)');
eq(blockReason({ ...g, state: 'codex:busy', busy: true }), 'not-idle', 'a pending approval: held');
eq(blockReason({ ...g, state: 'idle', busy: true }), 'busy', 'a dialog up: held');
eq(blockReason({ ...g, draft: 'draft' }), 'draft', 'a draft: held');
eq(blockReason({ ...g, vendor: 'ollama' }), 'vendor', 'other vendors still badge-only');

/* ---- [codex update] pre-launch helper (ticket) ---- */
{
  const H = '/srv/workbench/scripts/codex-update.sh';
  const UPD = { launcher: '~/.local/bin/codex-mcp-env.sh', preLaunch: H };
  const c = codex.buildInvocation(recipe({}), { remote: false, target: UPD })?.cmd ?? '';
  ok(c.startsWith(`CODEX_SEL=$(${H}) && PATH="\${CODEX_SEL:+$CODEX_SEL:}$PATH" ~/.local/bin/codex-mcp-env.sh codex `), 'update mode: the helper runs first, then the launcher, joined by && (no runnable codex = no launch)');
  ok(c.includes("-c 'check_for_update_on_startup=false'"), 'update mode turns off the in-TUI update prompt');
  const chk = codex.buildInvocation(recipe({}), { remote: false, target: { ...UPD, preLaunch: `${H} --check` } })?.cmd ?? '';
  ok(chk.startsWith(`CODEX_SEL=$(${H} --check) && `) && chk.includes("-c 'check_for_update_on_startup=false'"), '--check (dry run) ALSO turns the modal off: a launch must never wait on an update prompt');
  for (const mode of ['--rollback', '--unpin', '']) {
    const c2 = codex.buildInvocation(recipe({}), { remote: false, target: { ...UPD, preLaunch: `${H} ${mode}`.trim() } })?.cmd ?? '';
    ok(c2.includes("-c 'check_for_update_on_startup=false'"), `every managed mode suppresses the modal (${mode || 'update'})`);
  }
  const ovr = codex.buildInvocation(recipe({ vendorArgs: ['-c', 'check_for_update_on_startup=true'] }), { remote: false, target: UPD })?.cmd ?? '';
  ok(ovr.indexOf('check_for_update_on_startup=false') < ovr.indexOf('check_for_update_on_startup=true'), "a recipe's own Extra arguments come AFTER, so an explicit override is the recipe's choice");
  ok(!(codex.buildInvocation(recipe({}), { remote: false, target: { launcher: '~/.local/bin/codex-mcp-env.sh' } })?.cmd ?? '').includes('check_for_update_on_startup'), 'an UNMANAGED launch (no preLaunch) is unchanged');
  ok(!(codex.buildInvocation(recipe({}), { remote: false })?.cmd ?? '').includes('CODEX_SEL'), 'no preLaunch: unchanged');
  const rid = '01a104e2-f503-7113-891f-f2ba73e6f026';
  ok((codex.buildInvocation(recipe({}), { remote: false, resumeSessionId: rid, target: UPD })?.cmd ?? '').includes(` codex resume ${rid} `), 'resume keeps its form behind the helper');
  ok((codex.buildInvocation(recipe({}), { remote: true, target: UPD })?.cmd ?? '').startsWith('CODEX_SEL=$('), 'the ssh form carries it too');
  for (const bad of ['a; rm -rf /', '$(x)', '/p --a --b', '/p `x`']) {
    let threw = false;
    try { codex.buildInvocation(recipe({}), { remote: false, target: { preLaunch: bad } }); } catch { threw = true; }
    ok(threw, `a bad preLaunch is refused: ${JSON.stringify(bad)}`);
  }
  const spec = buildLaunch(recipe({}), { id: 'homebase-chat-ops', label: 'x', kind: 'local', broker: 'chatgpt', codex: UPD } as Target);
  ok(spec.inject?.startsWith('CODEX_SEL=$('), 'the broker-resident branch carries the helper');
  const other = buildLaunch(recipe({ vendor: 'claude-code', runClaude: 1 }), { id: 'homebase-chat-ops', label: 'x', kind: 'local', broker: 'chatgpt', codex: UPD } as Target);
  ok(!(other.inject ?? '').includes('CODEX_SEL'), 'another vendor on that target never sees it');
}

/* ---- [codex target] target launcher + shared defaults (ticket) ---- */
{
  const T = { launcher: '~/.local/bin/codex-mcp-env.sh', args: ['-c', 'sandbox_workspace_write.network_access=true', '-c', 'approvals_reviewer="auto_review"'] };
  const WRAP = '~/.local/bin/codex-mcp-env.sh codex';
  eq(codex.buildInvocation(recipe({}), { remote: false, target: { launcher: T.launcher } })?.cmd, `${WRAP} ${DEFAULTS}`, 'target launcher: a recipe with NO initCmd runs through the wrapper');
  eq(codex.buildInvocation(recipe({}), { remote: false })?.cmd, `codex ${DEFAULTS}`, 'no target config: unchanged (bare codex)');
  eq(codex.buildInvocation(recipe({ initCmd: 'cd /x && ~/other.sh codex' }), { remote: false, target: { launcher: T.launcher } })?.cmd, `cd /x && ~/other.sh codex ${DEFAULTS}`, "the recipe's own launcher wins over the target's");
  const rid = '01a104e2-f503-7113-891f-f2ba73e6f026';
  eq(codex.buildInvocation(recipe({}), { remote: false, resumeSessionId: rid, target: { launcher: T.launcher } })?.cmd.startsWith(`${WRAP} resume ${rid} `), true, 'resume by id goes through the target launcher');
  eq(codex.buildInvocation(recipe({}), { remote: true, resumeName: 'my chat', target: { launcher: T.launcher } })?.cmd.startsWith(`${WRAP} resume 'my chat' `), true, 'resume by name (remote quoting) goes through it too');
  const withArgs = codex.buildInvocation(recipe({ vendorArgs: ['-c', 'sandbox_workspace_write.network_access=false'] }), { remote: false, target: T })?.cmd ?? '';
  const iDef = withArgs.indexOf("-c 'approvals_reviewer=\"auto_review\"'");
  const iTgt = withArgs.indexOf("-c 'sandbox_workspace_write.network_access=true'");
  const iRec = withArgs.indexOf('sandbox_workspace_write.network_access=false');
  ok(withArgs.indexOf("'approval_policy=\"on-request\"'") < iTgt && iTgt < iDef && iDef < iRec, 'order: vendor defaults, then target defaults, then the recipe args last (so the recipe wins)');
}
for (const bad of [{ launcher: 'a; rm -rf /' }, { launcher: '$(x)' }, { args: ['--model', 'x'] }, { args: ['-c'] }, { args: ['-c', 'novalue'] }]) {
  let threw = false;
  try {
    codex.buildInvocation(recipe({}), { remote: false, target: bad });
  } catch {
    threw = true;
  }
  ok(threw, `a bad target config is refused, never a bare codex: ${JSON.stringify(bad)}`);
}
{
  const tgt = (over: Partial<Target>): Target => ({ id: 'homebase-chat-ops', label: 'x', kind: 'local', broker: 'chatgpt', ...over } as Target);
  const cfg = { launcher: '~/.local/bin/codex-mcp-env.sh', args: ['-c', 'sandbox_workspace_write.network_access=true'] };
  const brokerSpec = buildLaunch(recipe({}), tgt({ codex: cfg }));
  ok(brokerSpec.inject?.startsWith('~/.local/bin/codex-mcp-env.sh codex ') && brokerSpec.inject.includes("-c 'sandbox_workspace_write.network_access=true'"), 'broker-resident branch carries the target launcher + defaults');
  const localSpec = buildLaunch(recipe({}), tgt({ broker: 'local', codex: cfg }));
  ok(localSpec.inject?.startsWith('~/.local/bin/codex-mcp-env.sh codex '), 'local branch carries it');
  const sshSpec = buildLaunch(recipe({}), tgt({ kind: 'ssh', sshAlias: 'h', broker: 'local', codex: cfg }));
  ok(JSON.stringify(sshSpec.descriptor.args).includes('~/.local/bin/codex-mcp-env.sh codex '), 'ssh branch carries it');
  ok(!buildLaunch(recipe({}), tgt({})).inject?.includes('codex-mcp-env'), 'a target with no codex block is unchanged');
  const other = buildLaunch(recipe({ vendor: 'claude-code', runClaude: 1 }), tgt({ codex: cfg }));
  ok(!(other.inject ?? '').includes('codex-mcp-env') && !(other.inject ?? '').includes('network_access'), 'another vendor on the same target never sees the codex block');
}

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
