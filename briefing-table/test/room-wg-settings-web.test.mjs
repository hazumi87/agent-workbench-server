// [wg settings] source slices: Room settings -> Workgroups (main room only) and the agent-chat avatar.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const room = rd('room.js');
const mod = rd('room-workgroups-settings.mjs');
const chat = rd('agent-chat.mjs');
const css = rd('agent-chat.css');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
const body = room.slice(room.indexOf('function settingsBody'), room.indexOf('function inheritGroup'));
ok(/state\.room\?\.parent_id \|\| isBasic\(\) \? null : workgroupsGroup\(/.test(body), 'the section is built for a MAIN room only (a workgroup has none), and not at all in Basic');
ok(/family\?\.workgroups \?\? \[\]\)\.filter\(\(w\) => w\.state !== 'archived'\)/.test(body), 'lists family.workgroups, archived left out');
ok(/wrap\.append\(g1, \.\.\.\(wgs \? \[wgs\.el\] : \[\]\), \.\.\.\(follow \? \[follow\.el\] : \[\]\), \.\.\.inh,/.test(body), 'placed after the default feed in Room settings (then the Follow-the-room switch, a workgroup\'s From-the-main-room rows)');
ok(/paintWgs\?\.\(\)/.test(room.slice(room.indexOf('function paintRoomColor'), room.indexOf('let preview'))), 'repaints from the room read (rename / color land)');
ok(/\{ method: 'PATCH', json: \{ name: v \} \}/.test(mod) && !/alias:/.test(mod.replace(/w\.alias/g, '')), 'name saves PATCH /api/rooms/<id> {name} only; the alias is never sent');
ok(/openRoomColor\(\{ room: w, swatches: c\.swatches/.test(mod) && /from '\/room-color-room\.mjs'/.test(mod), 'the swatch opens the same Color… picker (room-color-room.mjs)');
ok(/Not saved: \$\{r\.body\?\.error/.test(mod), "the engine's refusal is shown inline");
ok(/fontSize = '16px'/.test(mod) && /if \(editing && rows\.contains\(document\.activeElement\)\)/.test(mod), '16px field; a poll never tears out a name being typed');
ok(/'Rename\\u2026'[\s\S]{0,120}'Color\\u2026'/.test(room), 'the rows keep their ⋯ Rename… / Color…');
ok(/import \{ youGlyph \} from '\/you-settings\.mjs'/.test(chat), 'agent chat imports the room\'s own youGlyph');
ok(/glyph\.append\(mine \? youGlyph\(me\) : o\.agentGlyph\(\)\)/.test(chat) && /glyph\.append\(youGlyph\(me\)\)/.test(chat), 'sent and pending bubbles use it');
ok(/me = \{ name: m\.name, picture: m\.picture \}/.test(chat), 'the picture comes from GET /api/rooms/me');
ok(!/svg\(PERSON/.test(chat) && /\.ac \.you \.you-person/.test(css), 'person icon only as youGlyph\'s fallback; its styles ship in agent-chat.css');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
