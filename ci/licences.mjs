#!/usr/bin/env node
// Judges `license-checker --json` output (stdin) against the allowlist. Exit 1 on any production dependency whose licence
// expression is not satisfied. An OR expression passes if ANY alternative is allowed; an AND expression needs ALL of them.
// A licence the checker only GUESSED (a trailing `*`) is judged as written but listed, so a human can look.
import { readFileSync } from 'node:fs';

const ALLOW = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'CC-BY-4.0',
  'Unlicense', 'Python-2.0', 'OFL-1.1', 'MIT-0', 'Zlib', 'MPL-2.0',
]);
// Named exceptions: a package pattern, the one licence it may carry, and why that is acceptable. Keep this list short.
const EXCEPTIONS = [
  {
    name: /^@img\/sharp-libvips-/,
    licence: 'LGPL-3.0-or-later',
    reason: 'sharp ships libvips as an unmodified prebuilt shared library that is loaded dynamically; LGPL permits that use.',
  },
];

function satisfied(expr) {
  const e = expr.replace(/\*/g, '').trim();
  const strip = (s) => s.trim().replace(/^\((.*)\)$/, '$1').trim();
  const alts = strip(e).split(/\s+OR\s+/);
  return alts.some((alt) => strip(alt).split(/\s+AND\s+/).every((id) => ALLOW.has(strip(id).replace(/[()]/g, ''))));
}

const data = JSON.parse(readFileSync(0, 'utf8'));
const bad = [];
const guessed = [];
for (const [pkg, info] of Object.entries(data)) {
  const lic = Array.isArray(info.licenses) ? info.licenses.join(' AND ') : String(info.licenses ?? 'UNKNOWN');
  if (lic.includes('*')) {
    guessed.push(`${pkg} ${lic}`);
  }
  const exc = EXCEPTIONS.find((x) => x.name.test(pkg) && x.licence === lic);
  if (!satisfied(lic) && !exc) {
    bad.push(`${pkg}  ${lic}`);
  }
}
console.log(`${Object.keys(data).length} production packages checked`);
if (guessed.length) {
  console.log(`licence guessed from a file (review):\n  ${guessed.join('\n  ')}`);
}
if (bad.length) {
  console.error(`NOT ALLOWED (${bad.length}):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
