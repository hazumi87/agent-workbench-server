/**
 * CONCIERGE routes (the design notes P0 + P1; rules in engine/concierge.ts).
 *
 * The person's door (below the auth gates, index.ts):
 *   GET   /api/concierge          status for the icon and fly-out, settings for Settings
 *   PATCH /api/concierge          settings; a PERSON only (a window's cookie, never a bearer)
 *   POST  /api/concierge/seen     {ts} the person has looked: clears the badge; a PERSON only
 *   GET   /api/concierge/<scope>  403: the read scope is the concierge PANE's, never the bearer's
 *
 * The concierge pane's door (index.ts paneTokenRoute, a pane token for THE pane only):
 *   GET   /api/concierge/sessions                        live session rows, a safe subset
 *   GET   /api/concierge/rooms                           open rooms: roster, lead, brief, apps, unread, held
 *   GET   /api/concierge/recipes/:id/sessions            a project's session listing and titles
 *
 * Basic edition: there is no Concierge; every /api/concierge route answers 404.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson, errStatus } from './http-util.ts';
import * as concierge from '../engine/concierge.ts';
import * as relay from '../engine/concierge-relay.ts';
import * as signoff from '../engine/concierge-signoff.ts';
import * as conciergeAct from '../engine/concierge-act.ts';
import * as roomTyper from '../engine/room-typer.ts';
import { sendToConcierge, SendCache } from '../engine/concierge-send.ts';
import { isLocalMode } from '../engine/local-mode.ts';
import { isBasic } from '../engine/agent-commands.ts';
import { table } from '../table/endpoint.ts';

/** Is `h` (lowercase, no @) already a seat's handle in any room? A name may not be shared. */
function seatHandleTaken(h: string): boolean {
  return table.listRooms({}).some((r) => table.listSeats(r.id, { includeLeft: true }).some((x) => x.handle.toLowerCase() === h));
}

export interface ConciergeDeps {
  human: boolean;
  /** a person that an AGENT cannot forge: an identity session/device principal, or (local mode only) the per-launch cookie. The sign-off routes need THIS, not `human`:
   *  on a server the legacy cookie is derivable from the shared bearer, which agents can read (design review, 2026-10-25). */
  person: boolean;
  log: (l: string) => void;
  /** HARBOR_WB_PANE_TOKENS: without it the scope has no door at all */
  paneTokensOn: boolean;
  recipe(id: string): { id: string; name: string; vendor: string } | undefined;
  isLive(paneid: string): boolean;
  /** whose badge (the person behind the cookie) */
  userKey: string;
}

/** Answers to voice utterances already typed (by utteranceId): a retry types nothing twice. In memory; an engine restart forgets it. */
const voiceSends = new SendCache();

const SCOPES = /^\/api\/concierge\/(sessions|rooms|recipes\/[^/]+\/sessions)$/;
const RELAY_POSTS = /^\/api\/concierge\/(message|summary-round)$/;
const SIGNOFFS = /^\/api\/concierge\/signoffs(?:\/([0-9a-f]{12}))?(\/answer)?$/;

/** What the icon, the fly-out and Settings read. Never a credential. */
export function status(deps: Pick<ConciergeDeps, 'paneTokensOn' | 'recipe' | 'isLive'>): Record<string, unknown> {
  const s = concierge.settings();
  const pane = concierge.conciergePane(s);
  const rec = (id: string | null) => {
    const r = id ? deps.recipe(id) : undefined;
    return r ? { id: r.id, name: r.name, vendor: r.vendor } : null;
  };
  const active = concierge.activeRecipe(s);
  return {
    settings: s,
    prerequisite: {
      paneTokens: deps.paneTokensOn,
      ...(deps.paneTokensOn ? {} : { message: 'The Concierge needs pane tokens, which are off on this engine (HARBOR_WB_PANE_TOKENS). It cannot read the Workbench until they are turned on.' }),
    },
    active: rec(active),
    primary: rec(s.primary),
    fallback: rec(s.fallback),
    pane,
    live: pane ? deps.isLive(pane) : false,
  };
}

export async function handle(req: IncomingMessage, res: ServerResponse, route: string, deps: ConciergeDeps): Promise<boolean> {
  if (route !== '/api/concierge' && !route.startsWith('/api/concierge/')) {
    return false;
  }
  const method = req.method ?? 'GET';
  if (isBasic()) {
    sendJson(res, 404, { error: 'there is no Concierge in the Basic edition' });
    return true;
  }
  try {
    /* THE VOICE SEND SEAM (the design notes): the app host proxies the voice module's utterance here with the bearer it holds.
       Local mode only. A held utterance is NOT sent and NOT queued (200 {status:'held', delivered:false, retryAfterMs}). */
    if (route === '/api/concierge/send') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      if (!isLocalMode(process.env)) {
        sendJson(res, 404, { error: 'the voice send seam is part of the local engine', code: 'not_local' });
        return true;
      }
      const a = sendToConcierge(
        await readBody(req),
        {
          pane: () => concierge.conciergePane(),
          paneLive: (p) => deps.isLive(p),
          typer: {
            frameChat: roomTyper.frameChat,
            enqueueChat: roomTyper.enqueueChat,
            heldFor: roomTyper.heldFor,
            drainQueue: roomTyper.drainQueue,
            requeue: roomTyper.requeue,
          },
          typeMax: roomTyper.TYPE_TEXT_MAX,
          log: deps.log,
        },
        voiceSends,
      );
      sendJson(res, a.status, a.body);
      return true;
    }
    const so = SIGNOFFS.exec(route);
    if (so) {
      return await handleSignoffsPerson(req, res, method, so[1], !!so[2], deps);
    }
    if (SCOPES.test(route) || RELAY_POSTS.test(route)) {
      sendJson(res, 403, { ok: false, error: 'concierge_scope', message: "only the Concierge pane's own token uses this; the shared bearer never does" });
      return true;
    }
    if (route === '/api/concierge') {
      if (method === 'GET') {
        sendJson(res, 200, status(deps));
        return true;
      }
      if (method !== 'PATCH') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      if (!deps.human) {
        sendJson(res, 403, { error: 'Concierge settings need a person: change them from a window (cookie), not a bearer', field: 'credential' });
        return true;
      }
      try {
        const patch = concierge.validPatch(await readBody(req), (id) => !!deps.recipe(id), seatHandleTaken);
        const next = concierge.setSettings(patch);
        concierge.resetCache();
        const cancelled = signoff.cancelForSettings(next.enabled, next.allowed);
        if (cancelled) deps.log(`concierge: ${cancelled} pending sign-off(s) cancelled by the settings change`);
        deps.log(`concierge settings now ${JSON.stringify({ ...next })}`);
      } catch (e) {
        if (e instanceof concierge.ConciergeError) {
          sendJson(res, 400, { error: e.message, field: e.field });
          return true;
        }
        throw e;
      }
      sendJson(res, 200, status(deps));
      return true;
    }
    if (route === '/api/concierge/seen' && method === 'POST') {
      if (!deps.human) {
        sendJson(res, 403, { error: 'only the person marks the Concierge read', field: 'credential' });
        return true;
      }
      const b = (await readBody(req)) ?? {};
      const ts = Number(b.ts);
      if (!Number.isFinite(ts) || ts <= 0) {
        sendJson(res, 400, { error: 'ts is the time of the newest reply seen', field: 'ts' });
        return true;
      }
      concierge.markSeen(deps.userKey, ts);
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, { error: 'no such Concierge route' });
  } catch (e) {
    sendJson(res, errStatus(e), { error: (e as Error).message });
  }
  return true;
}

export interface ScopeDeps {
  sessions(): Promise<unknown[]>;
  rooms(): Promise<unknown[]>;
  recipeSessions(recipeId: string): Promise<unknown[] | null>;
  /** P2 relay effects (index.ts wires them to the rooms); the rules are engine/concierge-relay.ts */
  relay: relay.RelayDeps;
  /** the act's window-button guards and audit facts (index.ts wires them to the rooms and the typer) */
  act: conciergeAct.ActDeps;
  log: (l: string) => void;
}


/** The pane-token door. True when answered; false = not a Concierge route.
 *  Only THE concierge pane gets past the gate; every other pane is 403. */
export async function handleScope(req: IncomingMessage, res: ServerResponse, route: string, paneid: string, deps: ScopeDeps): Promise<boolean> {
  if (!route.startsWith('/api/concierge')) {
    return false;
  }
  if (isBasic()) {
    sendJson(res, 404, { error: 'there is no Concierge in the Basic edition' });
    return true;
  }
  if (route === '/api/concierge/act' && req.method === 'POST') {
    if (!concierge.isConciergePane(paneid)) {
      sendJson(res, 403, { ok: false, error: 'not_concierge', message: 'this pane is not the Concierge' });
      return true;
    }
    try {
      const b = await readBody(req);
      if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.verb !== 'string' || typeof b.signoff !== 'string') {
        sendJson(res, 400, { ok: false, error: 'bad_request', message: 'the body is {verb, signoff}' });
      } else {
        sendJson(res, 200, await conciergeAct.act(b.signoff, b.verb, deps.act));
      }
    } catch (e) {
      if (e instanceof signoff.SignoffError) {
        sendJson(res, e.status, { ok: false, error: e.code, message: e.message, ...e.extra });
      } else {
        deps.log(`concierge act failed: ${(e as Error)?.message ?? e}`);
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
    return true;
  }
  const sg = SIGNOFFS.exec(route);
  if (sg && !sg[2] && ((req.method === 'POST' && !sg[1]) || (req.method === 'GET' && sg[1]))) {
    if (!concierge.isConciergePane(paneid)) {
      sendJson(res, 403, { ok: false, error: 'not_concierge', message: 'this pane is not the Concierge' });
      return true;
    }
    try {
      if (req.method === 'GET') {
        const r = signoff.get(sg[1]);
        sendJson(res, r ? 200 : 404, r ?? { ok: false, error: 'no_such_signoff' });
      } else {
        const b = await readBody(req);
        if (!b || typeof b !== 'object' || Array.isArray(b)) {
          sendJson(res, 400, { ok: false, error: 'bad_request', message: 'the body is a JSON object' });
        } else {
          sendJson(res, 201, signoff.request(b, concierge.settings().allowed));
        }
      }
    } catch (e) {
      if (e instanceof signoff.SignoffError) {
        sendJson(res, e.status, { ok: false, error: e.code, message: e.message, ...e.extra });
      } else {
        deps.log(`concierge signoff ${route} failed: ${(e as Error)?.message ?? e}`);
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
    return true;
  }
  const post = RELAY_POSTS.exec(route);
  const m = SCOPES.exec(route);
  if (!post && (!m || (req.method ?? 'GET') !== 'GET')) {
    sendJson(res, 403, { ok: false, error: 'not_for_pane_token', message: 'the Concierge reads; it changes nothing' });
    return true;
  }
  if (!concierge.isConciergePane(paneid)) {
    deps.log(`concierge scope REFUSED for ${paneid}: not the concierge pane`);
    sendJson(res, 403, { ok: false, error: 'not_concierge', message: 'this pane is not the Concierge' });
    return true;
  }
  if (post && req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed', message: `${route} is a POST` });
    return true;
  }
  try {
    if (post) {
      const b = await readBody(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        sendJson(res, 400, { ok: false, error: 'bad_request', message: 'the body is a JSON object' });
        return true;
      }
      const a = post[1] === 'message' ? relay.message(deps.relay, b) : relay.summaryRound(deps.relay, b);
      sendJson(res, a.status, a.body);
      return true;
    }
    if (m![1] === 'sessions') {
      sendJson(res, 200, { sessions: await deps.sessions() });
    } else if (m![1] === 'rooms') {
      sendJson(res, 200, { rooms: await deps.rooms() });
    } else {
      let id = m![1].slice('recipes/'.length, -'/sessions'.length);
      try {
        id = decodeURIComponent(id);
      } catch {
        /* raw */
      }
      const list = await deps.recipeSessions(id);
      if (list === null) {
        sendJson(res, 404, { error: 'unknown recipe', field: 'id' });
      } else {
        sendJson(res, 200, { sessions: list });
      }
    }
  } catch (e) {
    deps.log(`concierge scope ${route} failed: ${(e as Error)?.message ?? e}`);
    sendJson(res, post ? errStatus(e) : 500, post ? { ok: false, error: (e as Error).message } : { ok: false, error: 'internal' });
  }
  return true;
}


/** The person's door for sign-offs: the list, and the answer. A WINDOW session or device cookie only (never a personal API token, the shared bearer or a pane token: 403 needs_a_person),
 *  and the answer refuses a cross-site Origin like /handback/approve. The Concierge can never answer its own request. */
async function handleSignoffsPerson(req: IncomingMessage, res: ServerResponse, method: string, id: string | undefined, answerRoute: boolean, deps: ConciergeDeps): Promise<boolean> {
  if (isBasic()) {
    sendJson(res, 404, { error: 'there is no Concierge in the Basic edition' });
    return true;
  }
  if (!deps.person) {
    sendJson(res, 403, { ok: false, error: 'needs_a_person', message: 'only a person signed in to a window answers or reads sign-offs; a token, the shared bearer or the legacy cookie does not' });
    return true;
  }
  try {
    if (!id && method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      sendJson(res, 200, { signoffs: signoff.list(q.get('state') === 'all' ? 'all' : 'pending', Number(q.get('limit')) || 50) });
      return true;
    }
    if (id && !answerRoute && method === 'GET') {
      const r = signoff.get(id);
      sendJson(res, r ? 200 : 404, r ?? { ok: false, error: 'no_such_signoff' });
      return true;
    }
    if (id && answerRoute && method === 'POST') {
      const origin = req.headers.origin;
      if (origin) {
        let same = false;
        try {
          same = new URL(String(origin)).hostname.toLowerCase() === String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
        } catch {
          same = false;
        }
        if (!same) {
          sendJson(res, 403, { ok: false, error: 'cross_site', message: 'cross-site request refused' });
          return true;
        }
      }
      const b = (await readBody(req)) ?? {};
      // via 'voice' is NOT accepted until the per-verb voice assurance setting exists (design review security read 2026-10-25): default none
      const answered = signoff.answer(id, b.answer, deps.userKey, b.via, false);
      tellConcierge(answered, deps);
      sendJson(res, 200, answered);
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (e instanceof signoff.SignoffError) {
      sendJson(res, e.status, { ok: false, error: e.code, message: e.message, ...e.extra });
    } else {
      throw e;
    }
  }
  return true;
}

/** The ENGINE tells the Concierge the person's answer, as a normal chat line to its pane (design review Q4): the RECORD is the authority, never these words, and the line names the id
 *  so the Concierge can fetch it. Best effort: the typer queues it behind a draft or a turn; if it cannot be sent the Concierge can still poll the record. */
function tellConcierge(s: signoff.Signoff, deps: ConciergeDeps): void {
  try {
    const pane = concierge.conciergePane();
    if (!pane || !deps.isLive(pane)) {
      return;
    }
    const line = s.state === 'approved' ? `Approved. [signoff ${s.id}: ${s.verb}; call act with this id]` : `Declined. [signoff ${s.id}: ${s.verb}]`;
    roomTyper.enqueueChat(pane, line, null);
  } catch (e) {
    deps.log(`concierge: could not tell the Concierge about signoff ${s.id}: ${(e as Error).message}`);
  }
}
