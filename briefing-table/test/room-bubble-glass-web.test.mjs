/* BUBBLE GLASS [bubble glass] Owner 2026-10-05, web half: the formulas (the module is pure
 * apart from applyGlass, which gets a stub DOM), and source-slice checks. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const rd = (f) => readFileSync(join(W, f), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

const mk = () => {
  const props = new Map();
  return {
    props,
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    dataset: {},
  };
};
globalThis.document = { body: mk(), documentElement: mk() };
const { glassValues, applyGlass, glassReadout } = await import(pathToFileURL(join(W, 'room-glass.mjs')).href);
const body = () => document.body;
const html = () => document.documentElement;

/* defaults: a room with no override writes NOTHING */
applyGlass(null);
ok(body().props.size === 0 && Object.keys(body().dataset).length === 0 && Object.keys(html().dataset).length === 0, 'null writes nothing');
applyGlass(100);
ok(body().props.size === 0 && Object.keys(body().dataset).length === 0, '100 writes nothing (= the defaults)');
applyGlass(undefined);
ok(body().props.size === 0, 'undefined (no such field on an old reply) writes nothing');
let v = glassValues(null);
ok(v.pc === 25 && v.blur === 5 && v.phone === 50, 'null = 25% / 5px / phone 50%');

/* the formulas (the design system sec 1.J: PC min(50, 25m), blur 5(2-m) clamped 0-5, phone min(80, 50m)) */
v = glassValues(160);
ok(v.pc === 40 && v.blur === 2 && v.phone === 80, 'm=160: PC 40%, 2px, phone 80%');
ok(glassReadout(160) === '160% \u00b7 PC 40% / 2px \u00b7 phone 80%', 'readout "160% . PC 40% / 2px . phone 80%"');
v = glassValues(200);
ok(v.pc === 50 && v.blur === 0 && v.phone === 80, 'm=200: PC capped at 50%, blur 0, phone capped at 80%');
v = glassValues(50);
ok(v.pc === 12.5 && v.blur === 5 && v.phone === 25, 'm=50: PC 12.5%, blur clamps at 5px, phone 25%');
ok(glassValues(10).m === 50 && glassValues(999).m === 200, 'a magnitude clamps to 50-200');
/* small-text pills (Owner 2026-10-05): 20% x m, capped at 40%, always more solid than the PC bubbles */
ok(glassValues(null).pill === 20 && glassValues(160).pill === 32 && glassValues(200).pill === 40 && glassValues(50).pill === 10, 'pills: 20% default, 32% at 160, capped 40% at 200, 10% at 50');
ok([50, 80, 100, 130, 160, 200].every((m) => glassValues(m).pill < glassValues(m).pc), 'pills always stay more solid than the PC bubbles');

/* writes + the lift follows the computed value */
applyGlass(160);
ok(body().props.get('--bubble-alpha') === '40%' && body().props.get('--bubble-blur') === '2px' && body().props.get('--phone-bubble-alpha') === '80%', 'm=160 writes the three properties');
ok('bubbleSeeThrough' in body().dataset, 'm=160: PC clear 40% sets body[data-bubble-see-through]');
applyGlass(150);
ok(!('bubbleSeeThrough' in body().dataset), 'm=150: PC 37.5% is under 40: no lift');
applyGlass(null);
ok(body().props.size === 0 && !('bubbleSeeThrough' in body().dataset), 'Reset clears every property and the flag');

/* source */
const css = rd('room-bubbles.css');
ok(!/data-bubble-phone-flat/.test(css), 'the phone lift is unchanged (no flag)');
ok(/body\[data-bubble-see-through\] \.entry:is/.test(css), 'the PC lift is still keyed on body[data-bubble-see-through]');
ok(/--bubble-alpha, 25%/.test(css) && /--phone-bubble-alpha, 50%/.test(css) && /--bubble-blur, 5px/.test(css), 'the stylesheet defaults are unchanged');
const writers = ['room.js', 'room-character.mjs', 'room-art-settings.mjs', 'room-wash.mjs', 'room-display.mjs'].filter((f) => { try { return /--bubble-alpha|--bubble-blur|--phone-bubble-alpha/.test(rd(f)); } catch { return false; } });
ok(writers.length === 0, `room-glass.mjs is the only script naming the bubble properties (${writers})`);
ok(/applyGlass\(room && room\.bubble_glass\)/.test(rd('room-character.mjs')), 'paintRoomCharacter applies the room value (null when absent)');
ok(/'wash_at', 'bubble_glass', 'pal'/.test(rd('room.js')), 'saveSettings keeps bubble_glass from the reply');
const set = rd('room-art-settings.mjs');
ok(/washNote, glassHost, glassMsg\)/.test(set), 'the slider sits below Spot | Edge in Art');
ok(/o\.save\(\{ bubble_glass: g \}, glassMsg\)/.test(set), 'it saves through the settings PATCH');
const g = rd('room-glass.mjs');
ok(/addEventListener\('input'[\s\S]*applyGlass\(g\)/.test(g) && /addEventListener\('change', \(\) => void commit/.test(g), 'live on input, save on release');
ok(/applyGlass\(null\);\s*void commit\(null\)/.test(g), 'Reset saves null');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
