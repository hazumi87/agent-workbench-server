/* AGENT COMMS settings, web half [agent comms] Owner 2026-10-07: the pure parts of
 * web/settings-agent-comms.mjs, its place in the Settings menu, its route, 16px
 * inputs on a phone, and the chatter group's findings showing watched counts. No DOM. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const M = await import(pathToFileURL(join(W, 'settings-agent-comms.mjs')).href);
const src0 = readFileSync(join(W, 'settings-agent-comms.mjs'), 'utf8');
const C = await import(pathToFileURL(join(W, 'settings-chatter.mjs')).href);
let passed = 0;
let failed = 0;
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`  ok ${m}`);
  } else {
    failed++;
    console.log(`  X  ${m}`);
  }
};
const same = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

same(M.DEFAULTS, { ackOnly: 'watch', leadEcho: 'watch', dmBudget: 'watch', dmRepeat: 'watch', dmPerHour: 6, quietEnabled: true, leadRules: false, codexOneQueued: true, codexSteerControl: true, digestOver: 4, unaddressedToLead: true, personWakes: true, personWakeScope: 'all', replyInherits: true }, 'defaults match the engine: monitor-only');
same(M.MODES.map((m) => m[0]), ['off', 'watch', 'enforce'], 'three modes');
same(M.RULES.map((r) => r[0]), ['ackOnly', 'leadEcho', 'dmBudget', 'dmRepeat'], 'four rules');
ok(M.RULES.every((r) => r[2].length > 20 && !r[2].includes('\n')), 'each rule has one plain line');
same(M.toPatch({ ...M.DEFAULTS, ackOnly: 'enforce', dmPerHour: '12' }), { dmPerHour: 12, digestOver: 4, personWakeScope: 'all', ackOnly: 'enforce', leadEcho: 'watch', dmBudget: 'watch', dmRepeat: 'watch', quietEnabled: true, leadRules: false, codexOneQueued: true, codexSteerControl: true, unaddressedToLead: true, personWakes: true, replyInherits: true }, 'the draft as a PATCH (a typed number counts)');
same(M.FLAGS, ['quietEnabled', 'leadRules', 'codexOneQueued', 'codexSteerControl', 'unaddressedToLead', 'personWakes', 'replyInherits'], 'seven switches, the Codex steer one after one-at-a-time, person-wakes then reply-inherits last [reply route]');
same(M.toPatch({ ...M.DEFAULTS, codexSteerControl: false }).codexSteerControl, false, 'the steer switch rides the PATCH');
ok(src0.indexOf("flag('codexOneQueued'") < src0.indexOf("flag('codexSteerControl'"), 'the steer switch sits next to the one-at-a-time switch');
same(M.toPatch({ ...M.DEFAULTS, digestOver: '0' }).digestOver, 0, 'digest 0 = off is allowed');
ok(typeof M.toPatch({ ...M.DEFAULTS, digestOver: '-1' }) === 'string' && typeof M.toPatch({ ...M.DEFAULTS, digestOver: '101' }) === 'string', 'digest outside 0..100 is refused');
ok(M.DIGEST_HINT.length > 20 && !M.DIGEST_HINT.includes(String.fromCharCode(10)) && src0.includes('acs-digestOver'), 'the digest number has its one-line explanation');
ok(typeof M.toPatch({ ...M.DEFAULTS, dmPerHour: '0' }) === 'string', 'zero per hour is refused before sending');
ok(typeof M.toPatch({ ...M.DEFAULTS, dmPerHour: '2.5' }) === 'string', 'a fraction is refused');
ok(typeof M.toPatch({ ...M.DEFAULTS, dmPerHour: '' }) === 'string', 'empty is refused');

const settings = readFileSync(join(W, 'settings.mjs'), 'utf8');
ok(settings.includes("{ id: 'agent-comms', title: 'Agent comms', module: '/settings-agent-comms.mjs', export: 'mountAgentCommsSettings'"), 'the Settings menu mounts it');
ok(settings.indexOf("id: 'idle-rest'") < settings.indexOf("id: 'agent-comms'") && settings.indexOf("id: 'agent-comms'") < settings.indexOf("id: 'chatter'"), '...after idle rest, before Agents · chatter');
const src = readFileSync(join(W, 'settings-agent-comms.mjs'), 'utf8');
ok(src.includes("fetch('/api/agent-comms'") && src.includes("call('PATCH', patch)") && src.includes("call('GET')"), 'reads and writes /api/agent-comms');
const css = readFileSync(join(W, 'settings-agent-comms.css'), 'utf8');
ok(/@media \(max-width: 600px\) \{\s*\.acs-sel, \.acs-num \{ font-size: 16px; \}/.test(css), '16px select and number on a phone');

ok(C.findingLine({ kind: 'watched', seat: 'other-builder', value: 7, threshold: 0, examples: ['ack_only'] }) === '@other-builder: would have stopped 7 (acknowledgement-only lines)', 'a watched finding reads "would have stopped N"');
ok(C.findingLine({ kind: 'refused', seat: 'studio', value: 2, threshold: 0, examples: ['dm_budget'] }) === '@studio: stopped 2 (over the direct-message budget)', 'an enforced one reads "stopped N"');
ok(M.SWITCHES.includes('unaddressedToLead') && src.includes("flag('unaddressedToLead', 'Lines that name nobody go to the lead'"), '[address only] the unaddressed-to-lead switch, with its line');
console.log(`PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
