/* THE ENGINE-SERVED ROOM TOOLS: POST /mcp, MCP server name `bt` (the design notes §2.1/§3.5, the design notes).
 * Stateless streamable HTTP, JSON only: no session id, no SSE (GET and DELETE are 405), so an engine restart in the middle of a session is invisible to the client.
 * The PANE TOKEN is the only credential (a cookie or the shared bearer is the same as none). Every tool is the SAME code path as the HTTP agent door
 * (rooms.handleAgent), called with a synthetic request, so scope, the room_post rate and the byte-identical `not_seated` cannot differ between the two doors.
 * No tool takes from/author/handle: identity is derived from the token. Refusals are data: an `isError` result, never a later HTTP 401 (it can send a client into OAuth discovery). */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as paneTokens from '../engine/pane-tokens.ts';
import * as btTools from '../engine/bt-tools.ts';
import * as handbook from '../engine/handbook.ts';
import { ALL_TOOLS, toolsOf } from '../engine/bt-profiles.ts';
import { isLocalMode } from '../engine/local-mode.ts';
import { table } from '../table/endpoint.ts';
import { handleAgent, resolveSeatedRoom, seatedRooms, notSeated, type RoomRouteDeps } from './rooms.ts';

export const BT_VERSION = 'bt/1';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 256 * 1024;

/** ON in local mode and on a HOSTED engine, OFF on other servers (=1 turns it on there); =0 is off everywhere. It also needs pane tokens, its only credential. */
export function enabled(env: Record<string, string | undefined> = process.env): boolean {
  if (!paneTokens.enabled(env)) return false;
  if (env.HARBOR_WB_BT_MCP === '0') return false;
  if (env.HARBOR_WB_BT_MCP === '1') return true;
  return isLocalMode(env) || env.HARBOR_WB_HOSTED === '1';
}

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
}
const roomArg = { type: 'string', description: 'The room: its id or name. Leave it out when you hold a seat in only one room.' };
const TOOLS: Tool[] = [
  {
    name: 'handbook',
    description: 'Read the product handbook: how the product works, in short topics. Call it with no topic for the list, then with a topic name.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'A topic name from the list. Leave it out to get the list.' } }, additionalProperties: false },
  },
  { name: 'room_list_mine', description: 'The rooms you hold a seat in, with your own seat in each.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'room_read',
    description: 'Read lines of a room you are seated in. Pass `since` (a line id) to read only newer lines.',
    inputSchema: { type: 'object', properties: { room: roomArg, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
  },
  {
    name: 'room_post',
    description: 'Say something in a room you are seated in. Start with @handle to address a seat, or @user to reach the person. A line starting with / is a room command.',
    inputSchema: { type: 'object', properties: { room: roomArg, text: { type: 'string', minLength: 1 }, confirm: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  { name: 'room_roster', description: 'Who holds a seat in the room and what each is doing.', inputSchema: { type: 'object', properties: { room: roomArg }, additionalProperties: false } },
  { name: 'session_whoami', description: 'Who you are to the engine: your pane, your seats and the tool version. Call it first if unsure.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
/* The tools and who may call them: engine/bt-profiles.ts (read the rule there before adding one). */
export const TOOL_NAMES: readonly string[] = ALL_TOOLS;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, text ? { 'content-type': 'application/json' } : {});
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The result of a tool call: the JSON the HTTP door would have sent, as text content. */
function toolResult(body: unknown, isError: boolean): Json {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError };
}
const refusal = (error: string, message: string, extra: Json = {}): Json => toolResult({ ok: false, error, message, ...extra }, true);

/** Run one request through the HTTP agent door in-process and capture its answer. */
async function viaAgentDoor(method: string, path: string, body: Json | undefined, paneid: string, deps: RoomRouteDeps): Promise<{ status: number; body: any } | null> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessage & Record<string, unknown>;
  req.method = method;
  req.url = path;
  req.headers = { 'content-type': 'application/json' };
  const out = { status: 0, body: null as unknown };
  const res = {
    writeHead(s: number) { out.status = s; },
    setHeader() {},
    end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
  } as unknown as ServerResponse;
  const handled = await handleAgent(req, res, path.split('?')[0], paneid, deps);
  return handled ? (out as { status: number; body: any }) : null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

async function callTool(name: string, args: Json, a: paneTokens.AgentPrincipal, deps: RoomRouteDeps): Promise<Json> {
  const paneid = a.paneid;
  /* THE ENGINE'S PROFILE, not the client's approval setting, decides (design review [ref]): a known tool outside this token's profile is refused here. */
  if (ALL_TOOLS.includes(name) && !toolsOf(a.profile).includes(name)) {
    return refusal('tool_not_in_profile', `this token is not allowed to call ${name}`);
  }
  if (name === 'handbook') {
    if (!handbook.handbookOn()) return refusal('handbook_disabled', 'the handbook is switched off on this server');
    const topic = str(args.topic);
    if (topic === undefined) return toolResult({ topics: handbook.topics() }, false);
    const hit = handbook.read(topic);
    return hit ? toolResult(hit, false) : refusal('not_found', 'there is no handbook topic with that name', { topics: handbook.topics() });
  }
  if (name === 'room_list_mine') {
    const rooms = seatedRooms(paneid).map((h) => ({
      id: h.room.id,
      name: h.room.name,
      state: h.room.state,
      you: { seat_id: h.seat.id, handle: h.seat.handle, lead: h.room.lead_seat === h.seat.id },
    }));
    return toolResult({ rooms }, false);
  }
  if (name === 'session_whoami') {
    const row = table.get(paneid);
    return toolResult(
      {
        paneid,
        generation: a.generation,
        slug: row?.agent ?? null,
        vendor: row?.vendor ?? null,
        seats: seatedRooms(paneid).map((h) => ({ room: h.room.id, handle: h.seat.handle, lead: h.room.lead_seat === h.seat.id })),
        token: { origin: a.origin, minted_at: new Date(a.mintedAt).toISOString() },
        engine: { bt_version: BT_VERSION },
      },
      false,
    );
  }
  if (name !== 'room_read' && name !== 'room_post' && name !== 'room_roster') {
    return refusal('unknown_tool', `there is no tool called ${name}`);
  }
  if (name === 'room_post' && !str(args.text)) {
    return refusal('invalid_argument', 'room_post needs `text`', { field: 'text' });
  }
  const ref = str(args.room);
  const found = resolveSeatedRoom(paneid, ref ?? null);
  let target: string;
  if (found.ok) {
    target = found.room.id;
  } else if (name === 'room_post' && ref && (found.body as Json).error === 'not_seated') {
    target = ref; // the HTTP door's own family-escalate rule decides (post-only); anything else it answers not_seated
  } else {
    return toolResult(found.body, true);
  }
  const base = `/api/rooms/${encodeURIComponent(target)}`;
  let r: { status: number; body: any } | null;
  if (name === 'room_read') {
    const q = new URLSearchParams({ for: 'me' });
    const since = int(args.since);
    if (since !== undefined) q.set('since', String(since));
    q.set('limit', String(Math.min(200, Math.max(1, int(args.limit) ?? 50))));
    r = await viaAgentDoor('GET', `${base}/line?${q}`, undefined, paneid, deps);
    if (r && r.status < 400) r.body = { room: target, ...r.body };
  } else if (name === 'room_post') {
    r = await viaAgentDoor('POST', `${base}/line`, { text: args.text, ...(str(args.confirm) ? { confirm: args.confirm } : {}) }, paneid, deps);
  } else {
    r = await viaAgentDoor('GET', base, undefined, paneid, deps);
    if (r && r.status < 400) {
      const you = found.ok ? found.seat.id : null;
      const leadId = found.ok ? found.room.lead_seat : null;
      const seats = ((r.body.seats ?? []) as any[]).map((s) => ({
        handle: s.handle,
        lead: s.id === leadId,
        you: s.id === you,
        occupant: s.occupant ? { state: s.occupant.state, activity: s.occupant.activity ?? null, vendor: s.occupant.vendor ?? null, title: s.occupant.title ?? null, tools: s.occupant.tools ?? null } : null,
      }));
      r.body = { room: target, seats };
    }
  }
  if (!r) {
    return toolResult(notSeated(paneid), true);
  }
  return toolResult(r.body, r.status >= 400);
}

export async function handle(req: IncomingMessage, res: ServerResponse, deps: RoomRouteDeps): Promise<void> {
  if (!enabled()) {
    send(res, 404, { ok: false, error: 'mcp_disabled' });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return;
  }
  const text = await readBody(req);
  if (text === null) {
    send(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'the request is too large' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const auth = paneTokens.resolve(req);
  if (auth && auth.ok) {
    btTools.noteCall(auth.principal.paneid); // the pane HAS its room tools (roster tools: room)
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const isBatch = Array.isArray(parsed);
  const answers: unknown[] = [];
  let listed = false;
  for (const item of items) {
    const m = item as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: any };
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
      answers.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
      continue;
    }
    const hasId = m.id !== undefined && m.id !== null;
    const reply = (result: unknown): void => {
      if (hasId) answers.push({ jsonrpc: '2.0', id: m.id, result });
    };
    if (m.method === 'initialize') {
      if (!auth || !auth.ok) {
        send(res, 401, { ok: false, error: auth && !auth.ok ? auth.code : 'token_invalid' }); // the ONLY HTTP 401
        return;
      }
      const asked = m.params?.protocolVersion;
      reply({
        protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'bt', version: BT_VERSION },
      });
    } else if (m.method.startsWith('notifications/')) {
      continue;
    } else if (m.method === 'ping') {
      reply({});
    } else if (m.method === 'tools/list') {
      /* a valid token sees ONLY its profile's tools; any other caller sees the default static list (names are not secret, section 3.5) */
      const allowed = toolsOf(auth && auth.ok ? auth.principal.profile : 'default');
      reply({ tools: TOOLS.filter((t) => allowed.includes(t.name) && (t.name !== 'handbook' || handbook.handbookOn())) });
      listed ||= hasId && !!auth?.ok;
    } else if (m.method === 'tools/call') {
      if (!auth || !auth.ok) {
        reply(refusal(auth && !auth.ok ? auth.code : 'token_invalid', 'this pane token cannot be used'));
      } else {
        const name = String(m.params?.name ?? '');
        const args = m.params?.arguments && typeof m.params.arguments === 'object' && !Array.isArray(m.params.arguments) ? (m.params.arguments as Json) : {};
        try {
          reply(await callTool(name, args, auth.principal, deps));
        } catch (e) {
          deps.log(`bt mcp ${name}: threw: ${(e as Error)?.stack ?? String(e)}`); // our defect: logged, never sent
          reply(refusal('internal_error', 'the engine could not do that'));
        }
      }
    } else if (hasId) {
      answers.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  }
  if (answers.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }
  send(res, 200, isBatch ? answers : answers[0]);
  if (listed && auth?.ok) btTools.noteListed(auth.principal.paneid, auth.principal.generation);
}
