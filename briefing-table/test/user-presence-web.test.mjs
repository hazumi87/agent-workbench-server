/* USER DEVICE PRESENCE, the page half, by source [room [ref]]: which pages report, which fields leave the browser. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const src = (f) => readFileSync(join(W, f), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok  ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

const mod = src('device-report.mjs');
const body = mod.slice(mod.indexOf('export function descriptor'), mod.indexOf('let lastSent'));
const fields = [...body.matchAll(/^\s{4}(\w+)[:,]/gm)].map((m) => m[1]);
ok(JSON.stringify(fields) === JSON.stringify(['device', 'instance', 'class', 'surface', 'page', 'browser', 'os', 'viewport', 'standalone', 'visible', 'label']),
  `the descriptor sends exactly: ${fields.join(', ')}`);
ok(!/navigator\.userAgent[^;]*\bbody\b|userAgent:/.test(body) && !/\bip\b/i.test(body), 'no raw user-agent field, no IP in the body');
ok(!/'laptop'/.test(body.replace(/\/\*[\s\S]*?\*\//g, '')) && !/return 'laptop'/.test(mod), "'laptop' is never sent");
ok(/hwb\.device\.id/.test(mod) && /catch/.test(mod.slice(mod.indexOf('export function deviceId'))), 'device id in localStorage `hwb.device.id` with a try/catch per-tab fallback');
ok(/\/api\/presence\/device/.test(mod), 'posts to /api/presence/device');
ok(/EVERY_MS = 60000/.test(mod), 'about every 60 s');
ok(/onVisibility/.test(mod) && /pagehide/.test(mod), 'on visibility change and on pagehide');

ok(/tickDeviceReport\('room'\)/.test(src('room.js')) && !/startDeviceReport/.test(src('room.js')), "room: rides the page's existing poll (no second timer)");
ok(/tickDeviceReport\('manager'\)/.test(src('manager.js')) && !/startDeviceReport/.test(src('manager.js')), "manager: rides the page's existing poll");
ok(/startDeviceReport\('solo'\)/.test(src('solo.js')), 'solo: reports (owns the one timer)');
ok(/startDeviceReport\('workbench'\)/.test(src('workbench.js')), 'workbench: reports');
ok(/import \{ deviceLabel, startDeviceReport \} from '\/device-report\.mjs'/.test(src('solo.js')) && !/function deviceLabel/.test(src('solo.js')), 'solo reuses ONE deviceLabel (the CLIENT_LABEL derivation)');
console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
