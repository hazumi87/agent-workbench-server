/**
 * PANEL SURFACE (ticket seam, web/room-cells.mjs withSurface): a non-rail
 * frame's initial URL carries ?surface=<kind> (or &surface= when it already
 * has a query), before any #fragment; a rail frame, or an unknown kind, is
 * unchanged. Reads the SHIPPED code: SURFACES + withSurface are lifted from
 * web/room-cells.mjs (the page module imports /app-status.mjs by an absolute
 * URL, so it cannot be imported under node).
 * Nothing listens, nothing spawns.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
function eq(actual, expected, msg) {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  }
}

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room-cells.mjs'), 'utf8').replace(/\r\n/g, '\n'); // a Windows (autocrlf) checkout has CRLF (vrpc1 r43)
const start = src.indexOf('export const SURFACES');
const fn = src.indexOf('export function withSurface(url, kind) {');
const end = src.indexOf('\n}\n', fn) + 3;
const body = src.slice(start, end).replace(/^export /gm, '');
const { SURFACES, withSurface } = new Function(`${body}; return { SURFACES, withSurface };`)();

console.log('\n[the vocabulary]');
eq(SURFACES.join(','), 'rail,preview,large,dialog,window', 'rail, preview, large, dialog, window (pinned)');

console.log('\n[rail frames carry nothing]');
const F = '/api/rooms/r1/panels/p1/frame/t/tok/view';
eq(withSurface(F, 'rail'), F, 'rail: unchanged');
eq(withSurface(F, 'nope'), F, 'an unknown kind: unchanged');
eq(withSurface(F, undefined), F, 'no kind: unchanged');

console.log('\n[every other surface]');
for (const k of ['preview', 'large', 'dialog', 'window']) {
  eq(withSurface(F, k), `${F}?surface=${k}`, `${k}: ?surface=${k}`);
}
eq(withSurface(`${F}/review/2?v=1`, 'large'), `${F}/review/2?v=1&surface=large`, 'an existing query: &surface=');
eq(withSurface(`${F}?`, 'preview'), `${F}?surface=preview`, 'a bare trailing ?: no stray separator');
eq(withSurface(`${F}?a=1&`, 'preview'), `${F}?a=1&surface=preview`, 'a trailing &: no doubled separator');
eq(withSurface(`${F}/review/2#top`, 'dialog'), `${F}/review/2?surface=dialog#top`, 'before the #fragment');
eq(withSurface(`${F}?x=1#h`, 'large'), `${F}?x=1&surface=large#h`, 'query + fragment');
eq(withSurface('https://h.example/p?q=1', 'preview'), 'https://h.example/p?q=1&surface=preview', 'an absolute URL');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
