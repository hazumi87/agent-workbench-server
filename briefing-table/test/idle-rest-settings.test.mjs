/**
 * The Settings page group "Rooms - idle rest" (Owner 2026-10-04, note
 * eee9ca063154 item 6): the pure unit helpers of web/settings-idle-rest.mjs and
 * the wiring (registered in settings.mjs GROUPS, talks to GET/PATCH
 * /api/rooms/idle-rest, one line of explanation per setting, 16px inputs on a
 * phone). A source test, no browser. Run with node.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const m = await import('../web/settings-idle-rest.mjs');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}
const same = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

console.log('\n[hours <-> value + unit]');
same(m.splitHours(null), { on: false, value: 24, unit: 'h' }, 'off shows 24 h ready to switch on');
same(m.splitHours(24), { on: true, value: 24, unit: 'h' }, '24 h stays hours');
same(m.splitHours(168), { on: true, value: 7, unit: 'd' }, '168 h reads as 7 days');
same(m.splitHours(36), { on: true, value: 36, unit: 'h' }, '36 h stays hours');
same(m.toHours({ on: false, value: 5, unit: 'd' }), null, 'off -> null');
same(m.toHours({ on: true, value: 7, unit: 'd' }), 168, '7 days -> 168');
same(m.toHours({ on: true, value: '12', unit: 'h' }), 12, 'a typed string counts');
ok(Number.isNaN(m.toHours({ on: true, value: '', unit: 'h' })), 'an empty value is unusable');
ok(Number.isNaN(m.toHours({ on: true, value: 0, unit: 'h' })), 'zero is unusable');
same(m.DEFAULTS, { restEnabled: false, restMinutes: 15, memberHours: null, leadHours: null, leadsWakeMembers: false, roomsWakeLeads: false, backgroundGuard: false }, 'defaults: everything off, rest at 15 min when switched on');
same([m.toMinutes('15'), m.toMinutes(1440)], [15, 1440], 'rest minutes: typed or numeric, up to a day');
ok([0, 1441, 2.5, ''].every((v) => Number.isNaN(m.toMinutes(v))), 'rest minutes: 0, over a day, a fraction, empty are unusable');
ok(m.REST_LINE === 'Parks an idle agent with no background work; any message wakes it; it comes back in 10-20 s at its old size.', 'the Rest line in plain words');

console.log('\n[wiring]');
const page = read('settings.mjs');
ok(/id: 'idle-rest'[^}]*settings-idle-rest\.mjs[^}]*mountIdleRestSettings/.test(page), 'registered in the page GROUPS');
ok(page.includes("title: 'Agents · rest'"), 'titled "Agents · rest" [agent rest]');
const mod = read('settings-idle-rest.mjs');
ok(mod.includes("'/api/rooms/idle-rest'") && mod.includes('PATCH'), 'reads and writes /api/rooms/idle-rest');
for (const k of ['restEnabled', 'restMinutes', 'memberHours', 'leadHours', 'leadsWakeMembers', 'roomsWakeLeads']) {
  ok(mod.includes(k), `carries ${k}`);
}
ok(/Leads can wake members/.test(mod) && /Rooms can wake other rooms' leads/.test(mod), 'both toggles are labelled as Owner named them');
ok((mod.match(/is disconnected|A resting agent|While active|A message from another room|any message wakes it/g) ?? []).length >= 5, 'each setting has its explaining line');
ok(/@media \(max-width: 600px\)[^}]*font-size: 16px/.test(read('settings-idle-rest.css')), 'phone inputs are 16px');
ok(/try\s*\{[\s\S]*Not saved/.test(mod), 'the save handler catches and shows the error inline');

console.log('\n[background guard switch]');
ok(/Keep working seats awake/.test(mod) && mod.includes("backgroundGuard: want"), 'labelled and PATCHes {backgroundGuard}');
ok(m.GUARD_LINE === "A seat whose screen shows a background command or sub-agent still running is never put to sleep (capped at 6 hours). Needs the engine's screen reading (on).", 'help line in Owner\'s words');
ok(/gb\.checked = !want/.test(mod) && /Not saved: /.test(mod), 'a refusal reverts the switch and shows the error inline');
ok(/\.irs-guard \{ min-height: 44px/.test(read('settings-idle-rest.css')), 'the control is at least 44px tall');

console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
