/* web/brand.mjs — vendor -> the brand data the design system v21 chrome takes.
 * Pure rules only (node); the fetch/cache half is exercised by the browser. */
import { resolveBrand, brandColorFromHue } from '../web/brand.mjs';

let passed = 0;
let failed = 0;
const eq = (a, b, msg) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${good ? '  ok  ' : ' FAIL '} ${msg}${good ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);
  if (good) { passed += 1; } else { failed += 1; }
};

const BRANDS = [
  { vendor: 'claude-code', label: 'Claude Code', brandHue: 39, brandColor: '#d97757', brandMark: 'claude' },
  { vendor: 'codex-cli', label: 'OpenAI Codex CLI', brandHue: 164, brandColor: '#10a37f', brandMark: 'codex' },
  { vendor: 'cli-manager', label: 'Shell', brandColor: '#8a8f98', brandMark: 'generic' },
  { vendor: 'generic', label: 'Unbranded', brandColor: '#8a8f98', brandMark: 'generic' },
];

console.log('\n[the designed hue, never the literal vendor colour]');
eq(resolveBrand(BRANDS, 'claude-code').brandColor, 'oklch(.65 .13 39)', 'claude: brandHue 39 -> --brand-src carrier');
eq(resolveBrand(BRANDS, 'codex-cli').brandColor, 'oklch(.65 .13 164)', 'codex: hue, not its achromatic literal colour');
eq(resolveBrand(BRANDS, 'cli-manager').brandColor, undefined, 'no brandHue -> no colour (neutral plate)');
eq(brandColorFromHue(399), 'oklch(.65 .13 39)', 'hue wraps round the circle');
eq(brandColorFromHue(undefined), undefined, 'no hue, no colour');

console.log('\n[the mark key is Auriga\'s vocabulary]');
eq(resolveBrand(BRANDS, 'claude-code').brand, 'claude', 'claude-code -> claude');
eq(resolveBrand(BRANDS, 'cli-manager').brand, 'generic', 'a shell -> generic');

console.log('\n[never missing, never guessed]');
eq(resolveBrand(BRANDS, 'unknown').brand, 'generic', '"unknown" resolves to the mandatory generic entry');
eq(resolveBrand(BRANDS, 'gemini-cli').label, 'Unbranded', 'a vendor with no entry -> generic, labelled as such');
eq(resolveBrand(null, 'claude-code').brand, 'generic', 'before /api/brands lands every vendor is generic');
eq(resolveBrand(BRANDS, undefined).vendor, 'unknown', 'no vendor at all reads as unknown');

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
