/**
 * AGENT COMMS settings [agent comms] (Owner 2026-10-07): the validator and the lenient
 * reader (engine/agent-comms.ts), GET/PATCH /api/agent-comms (server/chatter.ts: any
 * credential reads, a person's window writes), and the report keeping watched counts
 * apart from enforced refusals. The doors are tested per mode in chatter-rooms.test.ts,
 * fabric-send.test.mjs and room-typer.test.ts. No server, no pty. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-agent-comms-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
delete process.env.HARBOR_WB_DM_BUDGET_PER_HOUR;

const ac = await import('../src/engine/agent-comms.ts');
const chatter = await import('../src/engine/chatter.ts');
const routes = await import('../src/server/chatter.ts');
const { table } = await import('../src/table/endpoint.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => {
  if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); }
};
const eq = (a: unknown, b: unknown, m: string): void => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);
const throwsField = (fn: () => unknown, field: string, m: string): void => {
  try {
    fn();
    ok(false, `${m} (did not throw)`);
  } catch (e) {
    ok(e instanceof ac.AgentCommsError && e.field === field, `${m} (field ${(e as any).field})`);
  }
};

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
async function call(method: string, body?: unknown, human = true): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const r = {
    writeHead(s: number) { out.status = s; },
    setHeader() {},
    end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
  };
  await routes.handle(req(method, '/api/agent-comms', body), r as any, '/api/agent-comms', { human, log: () => {} });
  return out;
}

try {
  console.log('\n[defaults: monitor-only]');
  eq(ac.AGENT_COMMS_DEFAULTS, { ackOnly: 'enforce', leadEcho: 'enforce', dmBudget: 'enforce', dmRepeat: 'enforce', dmPerHour: 6, quietEnabled: true, leadRules: false, codexOneQueued: true, codexSteerControl: true, digestOver: 4, unaddressedToLead: true, personWakes: true, personWakeScope: 'all', replyInherits: true }, 'four rules enforce (M7), 6/h, quiet on, lead rules off, codex one-queued + steer on, digest 4, unaddressed to the lead');
  eq(ac.agentComms(), ac.AGENT_COMMS_DEFAULTS, 'nothing stored: the defaults');

  console.log('\n[validator: strict]');
  eq(ac.validAgentCommsPatch({ ackOnly: 'enforce', dmPerHour: 12, leadRules: true }), { ackOnly: 'enforce', dmPerHour: 12, leadRules: true }, 'known keys pass');
  eq(ac.validAgentCommsPatch({ codexSteerControl: false }), { codexSteerControl: false }, 'the codex steer switch is a known key');
  throwsField(() => ac.validAgentCommsPatch({ codexSteerControl: 'no' }), 'codexSteerControl', '...and a boolean');
  eq(ac.validAgentCommsPatch({ digestOver: 0 }), { digestOver: 0 }, 'digestOver 0 (off) passes');
  throwsField(() => ac.validAgentCommsPatch({ digestOver: 101 }), 'digestOver', 'digestOver <= 100');
  throwsField(() => ac.validAgentCommsPatch({ digestOver: 2.5 }), 'digestOver', 'digestOver is whole');
  throwsField(() => ac.validAgentCommsPatch({ ackOnly: 'block' }), 'ackOnly', 'a mode is off/watch/enforce');
  eq(ac.validAgentCommsPatch({ personWakeScope: 'auto' }), { personWakeScope: 'auto' }, 'the wake scope is a known key: all or auto');
  throwsField(() => ac.validAgentCommsPatch({ personWakeScope: 'some' }), 'personWakeScope', '...and nothing else');
  throwsField(() => ac.validAgentCommsPatch({ dmPerHour: 0 }), 'dmPerHour', 'dmPerHour >= 1');
  throwsField(() => ac.validAgentCommsPatch({ dmPerHour: 1001 }), 'dmPerHour', 'dmPerHour <= 1000');
  throwsField(() => ac.validAgentCommsPatch({ dmPerHour: 2.5 }), 'dmPerHour', 'dmPerHour is whole');
  throwsField(() => ac.validAgentCommsPatch({ quietEnabled: 'yes' }), 'quietEnabled', 'a switch is a boolean');
  eq(ac.validAgentCommsPatch({ unaddressedToLead: false }), { unaddressedToLead: false }, '[address only] unaddressedToLead is a switch');
  throwsField(() => ac.validAgentCommsPatch({ unaddressedToLead: 'no' }), 'unaddressedToLead', '...a boolean');
  eq(ac.agentCommsFrom({ unaddressedToLead: 'nope' }).unaddressedToLead, true, '...read leniently: default on');
  throwsField(() => ac.validAgentCommsPatch({ loud: true }), 'loud', 'an unknown key is refused');
  throwsField(() => ac.validAgentCommsPatch({}), 'body', 'an empty patch is refused');
  throwsField(() => ac.validAgentCommsPatch([1]), 'body', 'an array is refused');

  console.log('\n[reader: lenient]');
  eq(ac.agentCommsFrom({ ackOnly: 'enforce', leadEcho: 'nonsense', dmPerHour: -3, leadRules: 'yes', codexOneQueued: false, codexSteerControl: 'off', digestOver: -2 }),
    { ...ac.AGENT_COMMS_DEFAULTS, ackOnly: 'enforce', codexOneQueued: false }, 'bad values fall to the default, good ones stand');
  eq(ac.agentCommsFrom('garbage'), ac.AGENT_COMMS_DEFAULTS, 'an unreadable value: defaults');
  process.env.HARBOR_WB_DM_BUDGET_PER_HOUR = '9';
  eq(ac.agentCommsFrom({}).dmPerHour, 9, 'nothing stored: the env budget is the fallback');
  eq(ac.agentCommsFrom({ dmPerHour: 4 }).dmPerHour, 4, '...and the setting wins over it');
  delete process.env.HARBOR_WB_DM_BUDGET_PER_HOUR;

  console.log('\n[route: GET any credential, PATCH a person only]');
  let r = await call('GET', undefined, false);
  eq([r.status, r.body?.ackOnly], [200, 'enforce'], 'GET answers a bearer');
  r = await call('PATCH', { ackOnly: 'enforce' }, false);
  eq(r.status, 403, 'a bearer cannot PATCH');
  r = await call('PATCH', { ackOnly: 'watch', dmPerHour: 3 });
  eq([r.status, r.body?.ackOnly, r.body?.dmPerHour, r.body?.leadEcho], [200, 'watch', 3, 'enforce'], 'a person PATCHes; the rest is kept');
  eq(ac.agentComms().ackOnly, 'watch', '...stored');
  r = await call('PATCH', { dmPerHour: 'lots' });
  eq([r.status, r.body?.field], [400, 'dmPerHour'], 'a bad value is a 400 naming the field');
  eq(ac.agentComms().dmPerHour, 3, '...and nothing changed');
  r = await call('DELETE');
  eq(r.status, 405, 'other methods: 405');

  console.log('\n[report: watched apart from refused]');
  const T0 = 1_000_000_000;
  const rep = chatter.report({
    lines: [], xposts: [], fabricTurns: [],
    events: [
      { ts: T0, kind: 'watch_ack_only', paneid: 'p1', slug: 'operator', from_slug: null, env_id: null },
      { ts: T0, kind: 'watch_ack_only', paneid: 'p1', slug: 'operator', from_slug: null, env_id: null },
      { ts: T0, kind: 'ack_only', paneid: 'p1', slug: 'operator', from_slug: null, env_id: null },
      { ts: T0, kind: 'watch_dm_budget', paneid: 'p3', slug: 'video-to-3d', from_slug: 'studio', env_id: null },
      { ts: T0, kind: 'watch_lead_echo', paneid: 'p2', slug: 'studio', from_slug: null, env_id: '5322' },
    ],
  }, { hours: 24 });
  eq(rep.watched, { ack_only: { operator: 2 }, dm_budget: { studio: 1 }, lead_echo: { studio: 1 } }, 'watched: per rule, per who');
  eq(rep.refused, { ack_only: { operator: 1 } }, 'refused: only the enforced one');
  ok(rep.findings.some((f: any) => f.kind === 'watched' && f.seat === 'studio' && f.examples.includes('5322')), 'a watched finding names the earlier line');
} catch (e) {
  failed++;
  console.log(`  X  threw: ${(e as Error).stack}`);
} finally {
  table.setEngineSetting('agentComms', null);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows: the store's own handle still holds the db open (EPERM); the temp dir is left behind */
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
