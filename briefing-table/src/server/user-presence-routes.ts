/* USER DEVICE PRESENCE routes [Owner room [ref]] — logic in ../engine/user-presence.ts.
 *   POST /api/presence/device   a PERSON's page reports its descriptor (human credential only: a cookie, no Authorization
 *                               header; a bearer or pane token is refused, so no agent can paint where Owner "is")
 *   GET  /api/presence/user     any authenticated caller reads the person's devices (bearer, cookie, or a seat's pane
 *                               token): read-only, one person per engine account, no write
 * Optional pulse-plane echo: `user.<person>.device` plain publish (NATS off = silently skipped), only on a change. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../identity/auth.ts';
import { readBody, sendJson } from './http-util.ts';
import { pictureOwner } from './picture-owner.ts';
import * as up from '../engine/user-presence.ts';
import * as telemetry from '../engine/telemetry.ts';
import { isSlug } from '../engine/agent-slug.ts';

export interface UserPresenceDeps {
  /** A person's credential (cookie), not a bearer/pane token. */
  human: boolean;
  principal: Principal | null;
}

const lastEcho = new Map<string, string>();

export async function handle(req: IncomingMessage, res: ServerResponse, route: string, deps: UserPresenceDeps): Promise<boolean> {
  if (route === '/api/presence/user' && req.method === 'GET') {
    const who = pictureOwner(deps.principal);
    sendJson(res, 200, up.query(who.key, who.name));
    return true;
  }
  if (route === '/api/presence/device' && req.method === 'POST') {
    if (!deps.human) {
      sendJson(res, 403, { ok: false, error: 'person_only', message: 'only the person\'s own page reports its device; agents read GET /api/presence/user' });
      return true;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: 'the body is JSON' });
      return true;
    }
    const v = up.validateDescriptor(body); // unknown keys are dropped here: only the named fields are copied out
    if (!v.ok) {
      sendJson(res, 400, { ok: false, error: v.error });
      return true;
    }
    if (!up.takeReport(v.value.device)) {
      res.setHeader('retry-after', '30');
      sendJson(res, 429, { ok: false, error: 'rate_limited', message: `at most ${up.RATE_PER_MIN} reports a minute per device` });
      return true;
    }
    const who = pictureOwner(deps.principal);
    up.record(who.key, v.value);
    echo(who.name, v.value);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (route === '/api/presence/device' || route === '/api/presence/user') {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  return false;
}

function echo(name: string | null, d: up.Descriptor): void {
  const slug = name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
  if (!isSlug(slug)) return;
  const fp = `${d.device}|${d.class}|${d.surface}|${d.page}|${d.visible}`;
  if (lastEcho.get(d.device) === fp) return;
  lastEcho.set(d.device, fp);
  if (lastEcho.size > 200) lastEcho.clear();
  telemetry.publishJson(`user.${slug}.device`, { person: slug, device: d.device, class: d.class, surface: d.surface, page: d.page, visible: d.visible, ts: new Date().toISOString() });
}
