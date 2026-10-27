/**
 * TOOL LINES (rooms.ts postToolLine, Owner 2026-09-28): POST .../line with
 * `tool: {slug, for}` from the resident's seat.
 *   - for "user": addressed to the author's own seat, meta {tool, for:"user"},
 *     typed into nobody's pane;
 *   - for another seat: addressed to it, meta.for = that seat's id;
 *   - for the resident itself: its own seat, no recipients;
 *   - never parsed: a leading / or @ is text, not a command or an address;
 *   - refused: from the user (no seat), a bad slug, a `for` that is no seat here.
 *   - the room page's "to me" rule (web/room.js matchesWho) reads meta.for.
 *
 * SAFETY: a temp table set BEFORE any import; fabric off. Nothing listens,
 * nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-tool-lines-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  return r;
}
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const r = {
    writeHead(s: number) {
      out.status = s;
    },
    setHeader() {},
    end(x?: unknown) {
      try {
        out.body = JSON.parse(String(x ?? ''));
      } catch {
        out.body = null;
      }
    },
  };
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {} });
  return out;
}
const meta = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta);

/* The page's rule, lifted from web/room.js so the test reads the SHIPPED code. */
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room.js'), 'utf8');
const body = src.slice(src.indexOf('function matchesWho(d, who) {'), src.indexOf('function whoLabel('));
const { isToMe } = await import('../web/to-me.mjs');
const { factIsToMe } = await import('../web/fact-mentions.mjs');
const matchesWho = new Function('state', 'isToMe', 'factIsToMe', `${body}; return matchesWho;`)({ seats: [] }, isToMe, factIsToMe) as (d: any, who: string) => boolean;
const dataset = (e: any) => {
  const m = meta(e);
  return {
    author: e.author ?? '', authorSeat: e.author_seat ?? '', targetSeat: e.target_seat ?? '', target: e.target ?? '',
    ...(m && typeof m.tool === 'string' ? { tool: m.tool, for: String(m.for ?? '') } : {}),
  };
};

try {
  for (const [id, agent] of [['rec-r', 'resident'], ['rec-o', 'other']]) {
    table.upsertRecipe({
      id, name: agent, target: 'local', projectDir: `/x/${agent}`, vendor: 'claude-code', agent, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
    table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent, session_id: null, state: 'live', generation: 1 } as never);
  }
  const R = table.createRoom({ name: 'Tool room' }, { actor: 'user' }).result;
  const res = table.addSeat(R.id, { recipe_id: 'rec-r', occupant: 'recipe:rec-r' }, { actor: 'user' }).result;
  const oth = table.addSeat(R.id, { recipe_id: 'rec-o', occupant: 'recipe:rec-o' }, { actor: 'user' }).result;
  const url = `/api/rooms/${R.id}/line`;
  const from = { paneid: 'recipe:rec-r' };

  console.log('\n[for the user]');
  const u = await call('POST', url, { text: '4 drafts ready', from, tool: { slug: 'image-studio', for: 'user' } });
  eq(u.status, 200, '200');
  const ue = u.body?.entries?.[0];
  eq(ue?.kind, 'chat', 'a chat line');
  eq(ue?.author_seat, res.id, "written as the resident's seat");
  eq(ue?.target_seat, res.id, "addressed to the author's own seat (typed into nobody's pane)");
  eq(u.body?.deliveries?.length, 0, 'no deliveries');
  eq(meta(ue)?.tool, 'image-studio', 'meta.tool');
  eq(meta(ue)?.for, 'user', 'meta.for = "user"');
  eq(matchesWho(dataset(ue), 'me'), true, '"to me" shows it');

  console.log('\n[for another agent]');
  const o = await call('POST', url, { text: 'your render is done', from, tool: { slug: 'image-studio', for: '@other' } });
  const oe = o.body?.entries?.[0];
  eq(oe?.target_seat, oth.id, 'addressed to the initiating seat');
  eq(meta(oe)?.for, oth.id, 'meta.for = its seat id');
  eq(o.body?.deliveries?.length, 1, 'delivered to that seat');
  eq(o.body?.deliveries?.[0]?.handle, 'other', '...@other');
  eq(matchesWho(dataset(oe), 'me'), false, '"to me" hides it');
  eq(matchesWho(dataset(oe), 'agents'), true, '"between agents" shows it');
  eq(matchesWho(dataset(oe), oth.id), true, "the initiator's seat filter shows it");

  console.log('\n[for the resident itself]');
  const s = await call('POST', url, { text: '/archive and @other are just text', from, tool: { slug: 'image-studio', for: 'resident' } });
  const se = s.body?.entries?.[0];
  eq(se?.kind, 'chat', 'a leading / is not a command');
  eq(se?.body, '/archive and @other are just text', 'the text is verbatim');
  eq(se?.target_seat, res.id, 'addressed to its own seat');
  eq(s.body?.deliveries?.length, 0, 'no deliveries (not even to @other named in the text)');
  eq(matchesWho(dataset(se), 'me'), false, '"to me" hides it (the unaddressed-lead rule does not apply)');
  eq(table.getRoom(R.id)?.state, 'open', 'the room was not archived');

  console.log('\n[plain lines unchanged]');
  const p = await call('POST', url, { text: 'hello', from });
  eq(meta(p.body?.entries?.[0])?.tool, undefined, 'no tool meta');
  eq(matchesWho(dataset(p.body?.entries?.[0]), 'me'), true, "the lead's unaddressed line is still to me");

  console.log('\n[refused]');
  const noSeat = await call('POST', url, { text: 'x', tool: { slug: 'image-studio', for: 'user' } });
  eq(noSeat.status, 403, 'no from on a bearer: the existing 403');
  eq((await call('POST', url, { text: 'x', from, tool: { slug: 'Image Studio', for: 'user' } })).body?.field, 'tool.slug', 'a bad slug');
  eq((await call('POST', url, { text: 'x', from, tool: { slug: 'image-studio', for: '@nobody' } })).body?.field, 'tool.for', 'a for that is no seat here');
  eq((await call('POST', url, { text: 'x', from, tool: { slug: 'image-studio' } })).body?.field, 'tool.for', 'a missing for');
  eq((await call('POST', url, { text: 'x', from, tool: 'image-studio' })).body?.field, 'tool', 'tool not an object');
} catch (e) {
  failed++;
  console.log(`  ✗ threw: ${(e as Error).stack}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM) */ }
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
