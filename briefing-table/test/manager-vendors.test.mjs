/**
 * The Workbench page's agent-vendor list stays equal to the chat code's list
 * (Owner 2026-10-07: a closed Codex session was missing from Recently closed).
 * web/manager.js keeps its own AGENT_VENDORS (it asks "is this an agent card /
 * a recoverable row"), and it had silently lost codex-cli. This slices the
 * SHIPPED list and compares it with agent-chat-core's, so the next vendor added
 * there cannot be forgotten here. No engine, no ports.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'web', 'manager.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const core = await import(pathToFileURL(join(ROOT, 'web', 'agent-chat-core.mjs')).href);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  + ${msg}`); } else { failed++; console.log(`  X ${msg}`); }
}

const marker = 'const AGENT_VENDORS = [';
const at = src.indexOf(marker);
ok(at >= 0, 'manager.js declares AGENT_VENDORS');
const end = src.indexOf('];', at);
const list = src.slice(at + marker.length, end).split(',').map((s) => s.trim().split(String.fromCharCode(39)).join('')).filter(Boolean);

console.log('\n[the list]');
ok(list.includes('codex-cli'), 'codex-cli is an agent vendor on the Workbench page');
ok(JSON.stringify([...list].sort()) === JSON.stringify([...core.AGENT_VENDORS].sort()),
  `equals agent-chat-core's list (${list.join(',')} vs ${core.AGENT_VENDORS.join(',')})`);

console.log('\n[the consumers use it]');
const recent = src.slice(src.indexOf('function renderRecent('));
ok(recent.slice(0, 4000).includes('AGENT_VENDORS.includes(row.vendor) && row.state !== ' + String.fromCharCode(39) + 'live' + String.fromCharCode(39)),
  'Recently closed filters on AGENT_VENDORS and not-live (a killed Codex row with a banked session is listed)');
ok(src.includes('function isAgentRecipe(r)'), 'isAgentRecipe is the card test (Resume button, agents group)');

console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
