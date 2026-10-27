/* A treatment field the pane does not carry is inherited from the ART.
 * Absent vs explicitly-none is the whole point, so both are asserted. */
import {
  inheritArtTreatment, artColor, chooseArtColor, FORM_DEFAULT_COLOR, type ArtRow,
} from '../src/engine/art-treatment.ts';

let pass = 0;
let fail = 0;
const ok = (c: boolean, label: string, detail?: string) => {
  console.log(`  ${c ? '✓' : '✗'} ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  c ? pass++ : fail++;
};
const ART: ArtRow[] = [
  { id: 13, style: JSON.stringify({ line: 'halftone', washFrom: 'ur', backlit: false, scale: 80, opacity: 10 }) },
  { id: 99, style: null },
];
const art = () => ART;
const run = (o: unknown) => JSON.parse(inheritArtTreatment(JSON.stringify(o), art) || '{}');

console.log('\n[the pref predates the fields — inherit all three]');
let r = run({ key: 'lib:13', svg: '<svg/>', mono: 'white', opacity: 10, scale: 80 });
ok(r.line === 'halftone', 'line comes from the art', r.line);
ok(r.washFrom === 'ur', 'so does the wash origin', r.washFrom);
ok(r.backlit === false, '...including a FALSE backlit, which a truthiness test would drop', String(r.backlit));
ok(r.scale === 80 && r.opacity === 10, 'scale and opacity are untouched — the recipe owns those');

console.log('\n[an explicit value always wins]');
r = run({ key: 'lib:13', line: 'none', mono: 'white' });
ok(r.line === 'none', 'a deliberate flat fill survives art that says halftone', r.line);
ok(r.washFrom === 'ur', '...while the fields it did NOT mention still inherit', r.washFrom);

console.log('\n[nothing to inherit from]');
const same = (o: unknown) => { const j = JSON.stringify(o); return inheritArtTreatment(j, art) === j; };
ok(same({ key: 'harbor', mono: 'white' }), 'an design-system preset is returned unchanged');
ok(same({ svg: '<svg/>', mono: 'white' }), 'a pasted one-off with no key is unchanged');
ok(same({ key: 'lib:99', mono: 'white' }), 'art with no stored style is unchanged');
ok(same({ key: 'lib:404', mono: 'white' }), 'a key naming art that no longer exists is unchanged');
ok(same({ key: 'lib:13', line: 'hatch', washFrom: 'c', backlit: true }), 'a pref with all three is unchanged');

console.log('\n[hostile input cannot break a pane]');
ok(inheritArtTreatment(null, art) === null, 'null stays null');
/* '' IS THE CLEAR SENTINEL (2026-07-07): setPrefs uses COALESCE, so removing a
   logo needs an explicit empty string and turning it into null here would make
   a removal keep the old value. */
ok(inheritArtTreatment('', art) === '', 'the empty clear-sentinel survives as an empty string');
ok(inheritArtTreatment('not json', art) === 'not json', 'unparseable JSON passes through');
let called = 0;
inheritArtTreatment(JSON.stringify({ key: 'harbor' }), () => { called += 1; return ART; });
ok(called === 0, '...and never called for a preset');

console.log(String.fromCharCode(10) + '[the art owns the color - art wins, and only where it states one]');
const COLORED: ArtRow[] = [{ id: 13, style: JSON.stringify({ color: '#0dab49', line: 'halftone' }) }, { id: 99, style: '{}' }];
const col = () => COLORED;
ok(artColor(JSON.stringify({ key: 'lib:13' }), col) === '#0dab49', 'the art states it');
ok(artColor(JSON.stringify({ key: 'lib:99' }), col) === null, 'art with a style but no color states nothing');
ok(artColor(JSON.stringify({ key: 'harbor' }), col) === null,
  'an design-system preset can never carry a project color - it is shared installation-wide');
ok(artColor(null, col) === null, 'no logo, no color');
ok(artColor(JSON.stringify({ key: 'lib:13' }), () => [{ id: 13, style: JSON.stringify({ color: 'chartreuse' }) }]) === null,
  'a color that is not #rrggbb is refused, not passed to a pane');

console.log(String.fromCharCode(10) + '[seeding an art color from the recipes wearing it]');
ok(chooseArtColor([{ color: '#0dab49' }, { color: '#0dab49' }]) === '#0dab49',
  'recipes that agree need no judgement at all');
ok(chooseArtColor([{ color: '#0dab49' }, { color: '#0dab49' }, { color: '#ba0d0d' }]) === '#0dab49',
  'the most common wins - N recipes beat one row');
ok(chooseArtColor([{ color: FORM_DEFAULT_COLOR }, { color: '#ba0d0d' }]) === '#ba0d0d',
  'on a tie the NON-default wins, because the default may mean nobody chose');
ok(chooseArtColor([{ color: '#111111', updated_at: 10 }, { color: '#222222', updated_at: 99 }]) === '#222222',
  'still tied -> the most recently updated recipe');
ok(chooseArtColor([]) === null, 'nothing wearing it seeds nothing');
ok(chooseArtColor([{ color: null }, { color: 'nonsense' }]) === null, 'unusable colors seed nothing');
ok(chooseArtColor([{ color: '#0DAB49' }, { color: '#0dab49' }]) === '#0dab49',
  'case does not split a vote');

console.log(`\nPASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
