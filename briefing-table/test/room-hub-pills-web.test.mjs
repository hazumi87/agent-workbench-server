/* SMALL TEXT ON TILED ART [hub-v2 sec 1.H], source-slice checks (no browser). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const rd = (f) => readFileSync(join(W, f), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

const css = rd('room-hub.css');
const i = css.indexOf('SMALL TEXT ON TILED ART');
ok(i > 0, 'the pill section exists in room-hub.css');
const rules = css.slice(css.lastIndexOf('/*', i)).replace(/\/\*[\s\S]*?\*\//g, '');
const sels = [...rules.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith('@'));
ok(sels.length > 0 && sels.every((s) => s.replace(/:is\([^)]*\)/g, '').split(',').every((p) => p.trim().startsWith('.rm-line.rc-tiled'))), 'every selector is gated on .rm-line.rc-tiled (no tile = nothing matches)');
ok(['.entry.by-room', '.entry-reads', '.entry-files', '.entry-vnotes', '.rm-start'].every((t) => rules.includes(t)), 'all five targets are pilled');
const web = rd('room.css') + rd('room-attach.css') + rd('room-voice.mjs');
ok(/\.entry\.by-room \{/.test(web) && /\.entry-reads \{/.test(web) && /\.rm-start \{/.test(web) && /entry-files/.test(web) && /entry-vnotes/.test(web), 'the target selectors exist in web/');
ok(/width: fit-content/.test(rules) && /padding: 2px 10px/.test(rules) && /border-radius: 12px/.test(rules), 'fit-content, 2px 10px, radius 12');
ok(/\.entry\.by-room:not\(\[data-side\]\) \{ padding: 3px 12px/.test(rules), 'a centered fact: 3px 12px');
ok(/var\(--surface\), transparent var\(--pill-clear, 20%\)\)/.test(rules) && /blur\(5px\)/.test(rules), 'PC: 20% clear by default (rides --pill-clear) + blur 5px');
const mq = /@media \(max-width: 600px\) \{([\s\S]*)\}\s*$/.exec(rules);
ok(mq && /transparent var\(--pill-clear, 20%\)/.test(mq[1]) && /backdrop-filter: none/.test(mq[1]), 'phone: 20% clear by default (rides --pill-clear), no blur');
ok(!/[^-]color:/.test(rules), 'text color untouched (stays --dim)');
ok(/text-shadow: none !important/.test(rules), 'halo off inside the pill');
ok(/justify-self: start/.test(rules) && /\.entry\.by-user > [^{]*\{ justify-self: end/.test(rules), 'read line / files hug their bubble side');
ok(/\.rm-start \{ margin-left: auto; margin-right: auto/.test(rules), '.rm-start centered');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(rules), 'no hex values');
const halo = rd('room-line-halo.css');
ok(/\.rm-line\.wm-pane :is\(/.test(halo) && !/rc-tiled|backdrop|background/.test(halo.replace(/\/\*[\s\S]*?\*\//g, '')), 'room-line-halo.css: still only the wm-pane halo, no tile rule, no backing box');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
