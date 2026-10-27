/* Stored Codex efforts the current models refuse are mapped at boot (Owner 2026-10-05). In-memory db. */
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HARBOR_WB_TABLE = join(mkdtempSync(join(tmpdir(), 'wb-cxeff-')), 'm.db');
const { normalizeCodexEfforts } = await import('../src/table/store.ts');
let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const d = new Database(':memory:');
d.exec(`CREATE TABLE recipes (id TEXT, vendor TEXT, effort TEXT); CREATE TABLE sessions (paneid TEXT, vendor TEXT, profile_effort TEXT);`);
const ins = d.prepare('INSERT INTO recipes VALUES (?,?,?)');
for (const [id, v, e] of [['a', 'codex-cli', 'minimal'], ['b', 'codex-cli', 'none'], ['c', 'codex-cli', 'ultra'], ['d', 'codex-cli', 'persistent'], ['e', 'codex-cli', 'xhigh'], ['f', 'claude-code', 'max'], ['g', 'codex-cli', null]]) ins.run(id, v, e);
d.prepare('INSERT INTO sessions VALUES (?,?,?)').run('p1', 'codex-cli', 'minimal');
d.prepare('INSERT INTO sessions VALUES (?,?,?)').run('p2', 'claude-code', 'low');
normalizeCodexEfforts(d);
normalizeCodexEfforts(d); // idempotent
const eff = (id: string) => (d.prepare('SELECT effort FROM recipes WHERE id=?').get(id) as { effort: string | null }).effort;
ok(eff('a') === 'low' && eff('b') === 'low', 'minimal and none -> low');
ok(eff('c') === 'max' && eff('d') === 'max', 'ultra and persistent -> max');
ok(eff('e') === 'xhigh' && eff('f') === 'max' && eff('g') === null, 'supported, claude and empty rows untouched');
ok((d.prepare("SELECT profile_effort FROM sessions WHERE paneid='p1'").get() as { profile_effort: string }).profile_effort === 'low', 'a codex seat profile is mapped too');
ok((d.prepare("SELECT profile_effort FROM sessions WHERE paneid='p2'").get() as { profile_effort: string }).profile_effort === 'low', 'a claude seat is untouched');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
