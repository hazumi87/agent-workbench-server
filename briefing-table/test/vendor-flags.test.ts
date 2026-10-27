/**
 * Codex recipe checkboxes (Owner 2026-10-09): parse/validate, command-line order, the HTML
 * checkbox ids pinned to the engine catalogue, and a store round trip on a scratch table.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HARBOR_WB_TABLE = join(mkdtempSync(join(tmpdir(), 'wb-vflags-')), 'm.db');
const { parseVendorFlags, flagArgsFor, CODEX_FLAGS, readStoredVendorFlags } = await import('../src/engine/vendor-flags.ts');
const codex = await import('../src/engine/vendors/codex-cli.ts');
const { upsertRecipe, getRecipe } = await import('../src/table/store.ts');

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

function ok(c: unknown, m: string): void {
  checks++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
}
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`}`);

eq(parseVendorFlags(['network', 'auto-review', 'network'], 'codex-cli'), { ok: true, flags: ['network', 'auto-review'] }, 'known ids, de-duplicated');
eq(parseVendorFlags([], 'codex-cli'), { ok: true, flags: null }, 'empty = none');
eq(parseVendorFlags(undefined, 'codex-cli'), { ok: true, flags: null }, 'absent = none');
ok(parseVendorFlags(['bogus'], 'codex-cli').ok === false, 'an unknown id is refused');
ok(parseVendorFlags(['network'], 'claude-code').ok === false, 'another vendor has no flags: refused');
ok(parseVendorFlags('network', 'codex-cli').ok === false, 'not a list: refused');
eq(readStoredVendorFlags('["network"]'), ['network'], 'stored JSON reads back');
eq(readStoredVendorFlags('garbage'), null, 'malformed reads as none');
eq(flagArgsFor('codex-cli', ['auto-review', 'network']), ['-c', 'sandbox_workspace_write.network_access=true', '-c', 'approvals_reviewer="auto_review"'], 'catalogue order, whatever order they were ticked');
eq(flagArgsFor('claude-code', ['network']), [], 'a vendor with no catalogue yields nothing');

const base: any = { id: 'x', name: 'n', target: 't', projectDir: '/p', vendor: 'codex-cli', agent: 'a', model: null, effort: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null };
const cmd = (over: any, target?: any) => codex.buildInvocation({ ...base, ...over }, { remote: false, target })?.cmd ?? '';
const DEF = `-c 'sandbox_mode="workspace-write"' -c 'approval_policy="on-request"'`;
ok(!cmd({}).includes('network_access'), 'nothing ticked: no extra arguments');
const c = cmd({ vendorFlags: ['network', 'auto-review'], vendorArgs: ['-c', 'sandbox_workspace_write.network_access=false'] }, { args: ['-c', 'x.y=1'] });
const at = (t: string) => c.indexOf(t);
ok(at(DEF) < at("'x.y=1'") && at("'x.y=1'") < at("'sandbox_workspace_write.network_access=true'") && at("'sandbox_workspace_write.network_access=true'") < at("'approvals_reviewer=\"auto_review\"'") && at("'approvals_reviewer=\"auto_review\"'") < at('sandbox_workspace_write.network_access=false'), 'order: defaults, target, ticked boxes, then Extra arguments last (they win)');

const saved = upsertRecipe({ ...base, vendorFlags: ['auto-review'] });
eq(saved.vendorFlags, ['auto-review'], 'store round trip');
eq(getRecipe('x')?.vendorFlags, ['auto-review'], 'and reads back');
eq(upsertRecipe({ ...base, vendorFlags: null }).vendorFlags, null, 'null clears');
eq(upsertRecipe({ ...base, vendorFlags: ['bogus'] as any }).vendorFlags, null, 'the store never persists an unknown id');

const html = readFileSync(new URL('../web/manager.html', import.meta.url), 'utf8');
const ids = [...html.matchAll(/data-flag="([^"]+)"/g)].map((m) => m[1]);
eq(ids, CODEX_FLAGS.map((f) => f.id), 'manager checkboxes == engine catalogue');
console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
