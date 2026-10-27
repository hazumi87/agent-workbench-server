/**
 * Request/response helpers shared by the engine's route handlers.
 *
 * Moved VERBATIM out of `src/server/index.ts` (workrooms T0, [ticket]) so a
 * route module can import them instead of having them passed in or copied.
 * Behaviour is unchanged: the same 2 MB cap, the same 413 that ANSWERS, the
 * same `.status`-carrying rejections.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/* Same value as `MIME['.json']` in index.ts, which still owns the static-file
 * MIME table. Kept as a literal here so this module imports nothing from the
 * engine. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/* Request-body ceiling. The big payload here is a pasted SVG logo, and real
 * exported logos are large — a single detailed path can be tens of KB, and it
 * crosses the wire DOUBLE-escaped (the logo object is JSON inside the recipe's
 * JSON). The old 64 KB cap was under that, and it failed in the worst possible
 * way: it destroyed the socket, so no response ever reached the browser and the
 * Save button simply did nothing (found 2026-09-02 on a ~70 KB logo). Now the
 * cap is generous, and going over it ANSWERS — 413, with the numbers in it.
 * HARD_KILL only exists so an unbounded upload can still be cut off. */
const MAX_BODY = 2 * 1024 * 1024;
const HARD_KILL = 10 * MAX_BODY;

/** Read + parse a JSON request body. Rejects with `.status` set, so the caller
 *  can answer with the right code instead of guessing 400. */
export function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let total = 0;
    let over = false;
    req.on('data', (d) => {
      total += d.length;
      if (total > MAX_BODY) {
        over = true;
        raw = ''; // stop holding it; we still drain so the 413 can be delivered
        if (total > HARD_KILL) {
          req.destroy();
        }
        return;
      }
      raw += d;
    });
    req.on('end', () => {
      if (over) {
        reject(
          Object.assign(
            new Error(`body too large: ${total} bytes (max ${MAX_BODY}) — is the SVG oversized?`),
            { status: 413 },
          ),
        );
        return;
      }
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Status carried by a readBody rejection, else 400. */
export const errStatus = (err: unknown): number => (err as { status?: number })?.status ?? 400;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': JSON_CONTENT_TYPE });
  res.end(JSON.stringify(body));
}

/** An entity tag for a body: a WEAK tag over its JSON (sha1, 20 hex). Weak
 *  because the same tag names the gzip'd and the plain encoding of one body
 *  (they are the same content, RFC 9110 8.8.1). */
export function etagOf(body: string | Buffer): string {
  return `W/"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
}

/** Does the request's If-None-Match name `etag`? (`*`, a list, weak W/ forms:
 *  If-None-Match uses the weak comparison.) */
export function notModified(req: IncomingMessage, etag: string): boolean {
  const inm = req.headers['if-none-match'];
  if (typeof inm !== 'string' || !inm) {
    return false;
  }
  const want = etag.replace(/^W\//, '');
  return inm.split(',').some((t) => {
    const tag = t.trim().replace(/^W\//, '');
    return tag === '*' || tag === want;
  });
}

/** Does the client take gzip? (`gzip` or `*` listed, and not at q=0.) */
export function acceptsGzip(req: IncomingMessage): boolean {
  const ae = req.headers['accept-encoding'];
  if (typeof ae !== 'string') {
    return false;
  }
  return ae.split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') {
      return false;
    }
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

/* Gzip'd bodies by ETag: several windows polling one unchanged answer pay for
   one compression. Small and bounded; an entry is only ever a cache. */
const GZIP_MIN = 1024;
const gzCache = new Map<string, Buffer>();
function gzipFor(etag: string, text: string): Buffer {
  const hit = gzCache.get(etag);
  if (hit) {
    return hit;
  }
  const gz = gzipSync(text, { level: 6 });
  if (gzCache.size >= 64) {
    gzCache.delete(gzCache.keys().next().value as string);
  }
  gzCache.set(etag, gz);
  return gz;
}

/**
 * sendJson for a route that is POLLED or fetched by key [perf/poll-traffic]:
 *   - an ETag (a hash of the serialized body unless `opts.etag` names one) and
 *     a 304 with no body when the request already holds it;
 *   - gzip when the client accepts it and the body is worth it (>= 1 KB);
 *   - `cache-control` defaults to `private, no-cache`: the browser keeps the
 *     body and revalidates every time, so a poll of an unchanged answer costs
 *     its headers.
 * Only a 200 is ETag'd; any other status is answered as sendJson would.
 */
export function sendJsonCached(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  opts: { etag?: string; cacheControl?: string; volatile?: readonly string[] } = {},
): void {
  const text = JSON.stringify(body);
  if (status !== 200) {
    res.writeHead(status, { 'content-type': JSON_CONTENT_TYPE });
    res.end(text);
    return;
  }
  /* `volatile`: keys derived from the clock on every read (a room's idle_ms)
     that no page draws. Left out of the TAG, so they alone never defeat a 304;
     a 304 then keeps the value the browser already holds. */
  const vol = opts.volatile;
  const etag =
    opts.etag ??
    etagOf(vol && vol.length ? JSON.stringify(body, (k, v) => (vol.includes(k) ? undefined : v)) : text);
  const cacheControl = opts.cacheControl ?? 'private, no-cache';
  if (notModified(req, etag)) {
    res.writeHead(304, { 'cache-control': cacheControl, etag, vary: 'accept-encoding' });
    res.end();
    return;
  }
  const headers: Record<string, string | number> = {
    'content-type': JSON_CONTENT_TYPE,
    'cache-control': cacheControl,
    etag,
    vary: 'accept-encoding',
  };
  let payload: string | Buffer = text;
  if (Buffer.byteLength(text) >= GZIP_MIN && acceptsGzip(req)) {
    payload = gzipFor(etag, text);
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = Buffer.byteLength(payload);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : payload);
}
