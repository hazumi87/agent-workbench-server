/**
 * BRAND IDENTITY (contract §9) — the committed table, and the rules that keep
 * it legible.
 *
 * WHY THE RULES ARE TESTED AT ALL, since none of them can crash anything: their
 * failure mode is that two brands simply LOOK THE SAME, forever, and nobody
 * files that. A hue collision is not an error anyone encounters — it is an
 * absence of information, discovered months later by someone clicking the wrong
 * pane. This file is the only thing that would ever notice.
 *
 * The separation numbers are the design system (relay auriga--briefing-table
 * 2026-09-17), not invented here; the engine's job is to hold the
 * data to them.
 */
import { validateBrands, loadBrands, GENERIC_VENDOR, type BrandIdentity } from '../src/engine/brands.ts';
import { RECIPE_VENDORS } from '../src/table/store.ts';

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
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}
/** A validator run must produce a problem MENTIONING this text — matching on
 *  the message rather than a count, so an unrelated new rule firing at the same
 *  time cannot make a case pass for the wrong reason. */
function complains(brands: BrandIdentity[], needle: string, msg: string): void {
  const problems = validateBrands(brands);
  ok(
    problems.some((p) => p.includes(needle)),
    `${msg} — ${problems.length ? problems.join(' | ') : 'NO problems reported'}`,
  );
}

const base = (over: Partial<BrandIdentity>): BrandIdentity => ({
  vendor: 'x',
  label: 'X',
  brandColor: '#112233',
  brandMark: 'generic',
  ...over,
});
/** A minimal VALID table: the mandatory generic plus one real brand. */
const minimal = (extra: BrandIdentity[] = []): BrandIdentity[] => [
  base({ vendor: GENERIC_VENDOR, label: 'Unbranded' }),
  ...RECIPE_VENDORS.map((v, i) => base({ vendor: v, label: v, brandHue: i * 45, brandMark: 'generic' })),
  ...extra,
];

console.log('\n[the COMMITTED table is valid — this is the one that ships]');
const shipped = loadBrands();
const problems = validateBrands(shipped);
eq(problems.length, 0, `web/brands.json passes every rule${problems.length ? `: ${problems.join(' | ')}` : ''}`);

console.log('\n[every vendor a session can carry has somewhere to look up its brand]');
for (const v of RECIPE_VENDORS) {
  ok(shipped.some((b) => b.vendor === v), `enum vendor "${v}" has a brand entry`);
}
ok(
  shipped.some((b) => b.vendor === GENERIC_VENDOR),
  'the mandatory "generic" entry exists — an unknown vendor always resolves to something drawable',
);
eq(
  shipped.find((b) => b.vendor === 'cli-manager')?.brandMark,
  'generic',
  'shell-only sessions wear the generic mark (Auriga\'s vocabulary, not a brand-* key)',
);
ok(
  shipped.every((b) => !('brandMarkDark' in b)),
  'NO brandMarkDark anywhere — a currentColor silhouette inverts for free',
);
ok(
  shipped.every((b) => /^[a-z0-9-]{1,24}$/.test(b.brandMark)),
  'every brandMark is a built-in mark key',
);
ok(
  ['claude', 'gemini', 'codex', 'ollama', 'generic'].every((k) =>
    shipped.some((b) => b.brandMark === k),
  ),
  'the five design-system mark keys are all in use',
);

console.log('\n[hue is a DESIGNED value, and it is what tells brands apart]');
eq(shipped.find((b) => b.vendor === 'claude-code')?.brandHue, 39, 'claude-code hue 39');
eq(shipped.find((b) => b.vendor === 'gemini-cli')?.brandHue, 260, 'gemini-cli hue 260');
eq(shipped.find((b) => b.vendor === 'codex-cli')?.brandHue, 164, 'codex-cli hue 164');
eq(shipped.find((b) => b.vendor === 'ollama')?.brandHue, 122, 'ollama hue 122');
ok(
  shipped.every((b) => b.brandColor && /^#[0-9a-f]{6}$/i.test(b.brandColor)),
  'every brand keeps its LITERAL colour too (large/About surfaces)',
);

console.log('\n[the rules refuse what would be invisible]');
complains(
  minimal([base({ vendor: 'a', label: 'A', brandHue: 10 }), base({ vendor: 'b', label: 'B', brandHue: 30 })]),
  'only 20° apart',
  'two brands 20° apart are refused',
);
complains(
  minimal([base({ vendor: 'a', label: 'A', brandHue: 350 }), base({ vendor: 'b', label: 'B', brandHue: 10 })]),
  'apart',
  'the WRAP-AROUND collision is caught (350 and 10 are 20° apart, not 340)',
);
ok(
  validateBrands([
    base({ vendor: GENERIC_VENDOR }),
    ...RECIPE_VENDORS.map((v, i) => base({ vendor: v, label: v, brandHue: i * 45 })),
    base({ vendor: 'a', label: 'A', brandHue: 225 }),
  ]).every((p) => !p.includes('apart')),
  'and a legitimate 45° spread is left alone (the rule is a floor, not a grudge)',
);
complains(
  [
    base({ vendor: GENERIC_VENDOR }),
    ...RECIPE_VENDORS.map((v) => base({ vendor: v, label: v, brandHue: 0 })),
  ].filter((b, i) => i === 0 || i === 1),
  'has no brand entry',
  'a vendor missing from the table is reported by name',
);
complains(
  RECIPE_VENDORS.map((v, i) => base({ vendor: v, label: v, brandHue: i * 45 })),
  'no "generic" entry',
  'a table with no generic entry is refused',
);
complains(
  minimal([
    base({ vendor: 'a', label: 'A' }),
    base({ vendor: 'b', label: 'B' }),
  ]),
  'at most ONE achromatic brand',
  'two achromatic brands are refused (they would be the same grey field)',
);
complains(minimal([base({ vendor: 'a', label: 'A', brandMark: 'brand-a', brandHue: 300 })]),
  'invented brand-* prefix',
  'a `brand-*` key is refused: the vocabulary belongs to the design system, and a key we invent resolves to nothing');
complains(minimal([base({ vendor: 'a', label: 'A', brandMark: 'Claude Mark', brandHue: 300 })]),
  'must be a built-in mark key', 'a key with spaces and capitals is refused');
complains(minimal([base({ vendor: 'a', label: 'A', brandColor: 'red', brandHue: 300 })]),
  'brandColor must be', 'a non-hex brandColor is refused');
complains(minimal([base({ vendor: 'a', label: 'A', brandHue: 400 })]),
  'brandHue must be', 'a hue outside 0-359 is refused');
complains(minimal([base({ vendor: 'a', label: 'A', brandHue: 33.5 })]),
  'brandHue must be', 'a fractional hue is refused (it is an integer by contract)');
complains(minimal([base({ vendor: 'claude-code', label: 'dupe', brandHue: 300 })]),
  'duplicate brand entry', 'a duplicate vendor row is refused');
complains(
  [
    base({ vendor: GENERIC_VENDOR }),
    ...RECIPE_VENDORS.map((v, i) => base({ vendor: v, label: v, brandHue: i * 41 })),
    ...[300, 341, 22, 63].map((h, i) => base({ vendor: `x${i}`, label: `X${i}`, brandHue: h })),
  ],
  'chromatic brands fit',
  'more than seven chromatic brands is refused — the scheme runs out of circle',
);

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
