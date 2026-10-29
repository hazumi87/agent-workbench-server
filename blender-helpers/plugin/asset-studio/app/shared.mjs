/*
 * What every Asset Studio domain shares (images, models, reviews): the error type, input checks,
 * the Library client, room lines and room assets. No state lives here.
 */
import { readBinding, readConfig, readEngine } from './config.mjs';

export class AppError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const ROOM_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;
export const ASSET_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const RASTER = /^image\/(png|jpeg|webp)$/;
export const libUrl = (id, what) => `${readConfig().libraryUrl}/assets/${encodeURIComponent(id)}/${what}`;

/* Who a room line is FOR (briefing-table tool-residents §2.8, a tool's
   message goes to whoever INITIATED the action). "user" = the user asked for it directly (it
   shows under their "to me"); a handle = the agent that asked (your own when you're working
   on your own). Default: the bound agent — autonomous work never lands in the user's lap. */
const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function initiator(b, dflt) {
  const f = b.for === undefined ? dflt ?? readBinding()?.agent ?? 'user' : b.for;
  if (typeof f !== 'string' || !(f === 'user' || (f.length <= 64 && HANDLE.test(f)))) throw new AppError(400, 'for must be "user" or an agent handle');
  return f;
}

export const str = (v, max, name) => {
  if (typeof v !== 'string') throw new AppError(400, `${name} must be a string`);
  if (v.length > max) throw new AppError(400, `${name} is over ${max} characters`);
  return v;
};
export const num = (v, lo, hi, name, int = false) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) throw new AppError(400, `${name} must be ${int ? 'an integer' : 'a number'} ${lo}–${hi}`);
  return n;
};


export async function lib(p, opts = {}) {
  const r = await fetch(`${readConfig().libraryUrl}${p}`, {
    method: opts.method || 'GET', signal: AbortSignal.timeout(20000),
    ...(opts.body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}


/* A room line as the resident's seat (the engine records a line with no `from` as the user).
   links: [{tool, ref}] — link chips into this tool's views (tool.json `links`). */
export async function postLine(roomId, text, forWho, links) {
  const e = engine();
  const paneid = readBinding()?.paneid;
  if (!paneid) throw new Error('no paneid in the binding');
  const r = await fetch(`${e.url}/api/rooms/${encodeURIComponent(roomId)}/line`, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { ...e.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text, from: { paneid }, tool: { slug: 'asset-studio', for: forWho || readBinding()?.agent || 'user' }, ...(links && { links }) }),
  });
  if (!r.ok) throw new Error(`room line → HTTP ${r.status}`);
}

export function engine() {
  const e = readEngine();
  if (e.error) throw new AppError(503, `room assets unavailable: ${e.error}`, { reason: 'engine-not-configured' });
  return e;
}
export const assetsPath = (roomId) => `/api/rooms/${encodeURIComponent(roomId)}/assets`;


export async function listRoomAssets(roomId) {
  const e = engine();
  let r;
  try {
    r = await fetch(e.url + assetsPath(roomId), { headers: e.headers, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new AppError(503, `briefing-table unreachable (${err.cause?.code || err.name})`);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new AppError(502, `room assets → HTTP ${r.status}${j?.error ? `: ${j.error}` : ''}`);
  return j.assets || [];
}


/* The room FAMILY (briefing-table an app belongs to the root room and its workgroups share it). A
   workgroup's id resolves to its head (the engine's room.parent_id), once, cached; every domain keys its state
   and its binding check by the head, while room lines still post in the room the call came from. */
const familyHeads = new Map();
export async function resolveFamily(roomId) {
  const b = readBinding();
  if (!b || roomId === b.room_id || familyHeads.has(roomId) || !/^[0-9a-f][0-9a-f-]{7,63}$/i.test(roomId)) return;
  const e = readEngine();
  if (e.error) return;
  try {
    const r = await fetch(`${e.url}/api/rooms/${encodeURIComponent(roomId)}`, { headers: e.headers, signal: AbortSignal.timeout(5000) });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.room) familyHeads.set(roomId, j.room.parent_id || j.room.id);
  } catch { /* the engine is down: the room stays unknown (refused as another room) */ }
}
export const familyKey = (roomId) => familyHeads.get(roomId) ?? roomId;
export function _setFamilyHead(roomId, head) { familyHeads.set(roomId, head); } // tests
