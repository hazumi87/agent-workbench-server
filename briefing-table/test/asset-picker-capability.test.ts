/**
 * The asset picker's HOST CAPABILITY declaration [asset picker, Owner 2026-10-05]:
 * tool.json `host_capabilities: ["pick"]` is read from the PINNED copy, unknown
 * names are ignored, and adding or dropping one shows in the approval diff
 * (so a changed tool.json that asks for the picker holds the app until a
 * person approves it, and the diff names it).
 *
 * SAFETY: a temp table set BEFORE any import; no engine, no ports.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-pick-cap-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_NATS_URL = '';
const apps = await import('../src/engine/apps.ts');

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string, detail?: unknown) => {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  }
};

ok(JSON.stringify(apps.hostCapabilitiesOf({ host_capabilities: ['pick'] })) === '["pick"]', 'pick is read');
ok(apps.hostCapabilitiesOf({}).length === 0, 'none declared: none');
ok(apps.hostCapabilitiesOf({ host_capabilities: 'pick' }).length === 0, 'not an array: none');
ok(JSON.stringify(apps.hostCapabilitiesOf({ host_capabilities: ['pick', 'root', 7, null] })) === '["pick"]', 'unknown names and junk are ignored');
ok(JSON.stringify(apps.hostCapabilitiesOf({ host_capabilities: ['pick', 'pick'] })) === '["pick"]', 'a repeat counts once');

const pinned = (tool_json: string | null) => apps.pinnedHostCapabilities({ tool_json } as any);
ok(JSON.stringify(pinned('{"host_capabilities":["pick"]}')) === '["pick"]', 'the PINNED copy decides');
ok(pinned(null).length === 0, 'no pinned copy: none');
ok(pinned('{not json').length === 0, 'an unparseable pinned copy: none');
ok(apps.pinnedHostCapabilities(undefined).length === 0, 'no registration: none');

const base = { name: 'x', verbs: [], panels: [] };
const d = apps.toolDiff(base, { ...base, host_capabilities: ['pick'] });
ok(JSON.stringify(d.host) === '{"added":["pick"],"removed":[]}', 'adding it shows in the diff', d.host);
ok(!d.other.includes('host_capabilities'), 'and is not buried under "also changed"', d.other);
const d2 = apps.toolDiff({ ...base, host_capabilities: ['pick'] }, base);
ok(JSON.stringify(d2.host) === '{"added":[],"removed":["pick"]}', 'dropping it shows too', d2.host);
const d3 = apps.toolDiff({ ...base, host_capabilities: ['pick'] }, { ...base, host_capabilities: ['pick'], version: '2' });
ok(d3.host.added.length === 0 && d3.host.removed.length === 0, 'unchanged: nothing', d3.host);

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* the store holds the db */
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
