/**
 * CHATTER routes [chatter] (Owner 2026-10-06), below the auth gates:
 *
 *   GET /api/chatter?hours=24          the report (engine/chatter.ts), any credential
 *   GET|PATCH /api/agent-comms         the rule switches [agent comms]; PATCH a PERSON only
 *   PUT /api/chatter/quiet {slug, quiet}  the person marks an agent quiet; a PERSON only
 *                                      (a window's cookie, never a bearer — rooms.ts requireHuman)
 *
 * While a slug is quiet the engine refuses an agent's fabric DM to it at the send
 * door and does not type one that arrives another way (index.ts, fabric.ts).
 * Room lines to a quiet seat are unchanged in phase 1.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson, errStatus } from './http-util.ts';
import { table } from '../table/endpoint.ts';
import { report } from '../engine/chatter.ts';
import { normalizeSlug } from '../engine/agent-slug.ts';
import { agentComms, setAgentComms, validAgentCommsPatch, AgentCommsError } from '../engine/agent-comms.ts';

const MAX_HOURS = 24 * 14;

export async function handle(req: IncomingMessage, res: ServerResponse, route: string, deps: { human: boolean; log: (l: string) => void }): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (route === '/api/chatter' && method === 'GET') {
    try {
      const raw = new URL(req.url ?? '', 'http://x').searchParams.get('hours');
      const hours = raw === null || raw === '' ? 24 : Number(raw);
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
        sendJson(res, 400, { error: `hours is a number above 0, at most ${MAX_HOURS}`, field: 'hours' });
        return true;
      }
      const now = Date.now();
      const since = now - hours * 60 * 60 * 1000;
      sendJson(res, 200, { since, now, ...report(table.chatterSource(since), { hours, quiet: table.chatterQuiet() }) });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return true;
  }
  if (route === '/api/agent-comms') {
    /* [agent comms] the SYSTEM-wide rule switches (engine/agent-comms.ts). Anyone signed in
       reads; only a person's window writes (the quiet switch's rule). */
    try {
      if (method === 'GET') {
        sendJson(res, 200, agentComms());
        return true;
      }
      if (method !== 'PATCH') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      if (!deps.human) {
        sendJson(res, 403, { error: 'agent comms settings need a person: change them from a window (cookie), not a bearer', field: 'credential' });
        return true;
      }
      let patch;
      try {
        patch = validAgentCommsPatch(await readBody(req));
      } catch (e) {
        if (e instanceof AgentCommsError) {
          sendJson(res, 400, { error: e.message, field: e.field });
          return true;
        }
        throw e;
      }
      const next = setAgentComms(patch);
      deps.log(`agent comms settings now ${JSON.stringify(next)}`);
      sendJson(res, 200, next);
    } catch (e) {
      sendJson(res, errStatus(e), { error: (e as Error).message });
    }
    return true;
  }
  if (route === '/api/chatter/quiet' && method === 'PUT') {
    try {
      if (!deps.human) {
        sendJson(res, 403, { error: 'marking an agent quiet needs a person: send it from a window (cookie), not a bearer', field: 'credential' });
        return true;
      }
      const b = await readBody(req);
      const slug = normalizeSlug(b?.slug);
      if (!slug) {
        sendJson(res, 400, { error: 'slug is an agent slug', field: 'slug' });
        return true;
      }
      if (typeof b.quiet !== 'boolean') {
        sendJson(res, 400, { error: 'quiet is true or false', field: 'quiet' });
        return true;
      }
      const quiet = table.setChatterQuiet(slug, b.quiet);
      deps.log(`chatter: ${slug} ${b.quiet ? 'marked quiet' : 'no longer quiet'} by the person`);
      sendJson(res, 200, { ok: true, slug, quiet: b.quiet, list: quiet });
    } catch (e) {
      sendJson(res, errStatus(e), { error: (e as Error).message });
    }
    return true;
  }
  return false;
}
