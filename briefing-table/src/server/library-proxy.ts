/**
 * LIBRARY PROXY for the host asset picker [asset picker, Owner 2026-10-05].
 *
 *   GET /api/library/images?offset=N   {assets:[{id,label,created_at,...}], total, limit, offset}
 *   GET /api/library/thumb/:id         the JPEG thumbnail
 *
 * The browser cannot reach the alpha-platform gateway (loopback), so the
 * engine reads it for the room page. THIS IS NOT A GENERIC PROXY: exactly two
 * upstream paths exist, both GET, the id is a plain token, and the page size
 * is fixed at 9 (the picker's 3x3 grid; the library holds ~20,900 images, so
 * it always pages). The caller is authenticated before this runs (index.ts
 * calls it below the auth gates, on both the person door and the pane-token
 * door). An upstream failure answers 502 with words, never an empty list,
 * which would read as "the library has no images".
 *
 * Base URL: env HARBOR_WB_LIBRARY_URL, default the gateway on loopback.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http-util.ts';

const DEFAULT_BASE = 'http://127.0.0.1:8260/asset-management/library';
const TIMEOUT_MS = 5000;
export const LIBRARY_PAGE = 9;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const THUMB_MAX = 2 * 1024 * 1024;

function base(): string {
  return (process.env.HARBOR_WB_LIBRARY_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

class Upstream extends Error {}

async function fetchUp(path: string): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`${base()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: '*/*' } });
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
    throw new Upstream(timedOut ? `the asset library did not answer within ${TIMEOUT_MS / 1000} s` : `the asset library is not reachable (${(e as Error).message})`);
  }
  if (!r.ok) {
    await r.arrayBuffer().catch(() => null);
    throw new Upstream(`the asset library answered ${r.status}`);
  }
  return r;
}

/** True when answered. Anything that is not one of the two paths returns false. */
export async function handle(req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> {
  if (!route.startsWith('/api/library/')) {
    return false;
  }
  const method = req.method ?? 'GET';
  const u = new URL(req.url ?? '/', 'http://x');
  if (route === '/api/library/images') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'GET only', field: 'method' });
      return true;
    }
    const raw = u.searchParams.get('offset') ?? '0';
    if (!/^\d{1,7}$/.test(raw)) {
      sendJson(res, 400, { error: 'offset is a whole number', field: 'offset' });
      return true;
    }
    const offset = Number(raw);
    try {
      const r = await fetchUp(`/api/assets?category=image&limit=${LIBRARY_PAGE}&offset=${offset}`);
      const j: any = await r.json().catch(() => null);
      if (!j || !Array.isArray(j.assets)) {
        throw new Upstream('the asset library answered something that is not a list');
      }
      /* only what the picker draws, and only well-formed ids (a thumb URL is built from it) */
      const assets = j.assets
        .filter((a: any) => a && typeof a.id === 'string' && ID_RE.test(a.id))
        .map((a: any) => ({ id: a.id, label: typeof a.label === 'string' ? a.label.slice(0, 200) : '', created_at: a.created_at ?? null, category: 'image' }));
      sendJson(res, 200, { assets, total: Number.isFinite(j.total) ? j.total : null, limit: LIBRARY_PAGE, offset });
    } catch (e) {
      sendJson(res, 502, { error: (e as Error).message, field: 'library' });
    }
    return true;
  }
  const m = /^\/api\/library\/thumb\/([^/]*)$/.exec(route);
  if (m) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'GET only', field: 'method' });
      return true;
    }
    let id = '';
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      id = '';
    }
    if (!ID_RE.test(id)) {
      sendJson(res, 400, { error: 'id is 1-64 letters, digits, - or _', field: 'id' });
      return true;
    }
    try {
      const r = await fetchUp(`/api/assets/${id}/thumb`);
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > THUMB_MAX) {
        throw new Upstream('the thumbnail is too large');
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
      });
      res.end(bytes);
    } catch (e) {
      sendJson(res, 502, { error: (e as Error).message, field: 'library' });
    }
    return true;
  }
  sendJson(res, 404, { error: 'no such library route', field: 'route' });
  return true;
}
