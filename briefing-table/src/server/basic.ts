/* ============================================================================
 * BASIC EDITION ROUTES [basic] (Owner 2026-10-08, room interface; blueprint KB
 * design-notes-id, platform KB design-notes-id). the design notes.
 *
 *   GET  /api/commands               room + agent commands, one plain line each
 *   POST /api/projects/new-site {name}   PERSON only, Basic only
 *   GET  /api/rooms/:id/site         the Preview/Public bar's data
 *
 * Wired in index.ts BELOW the auth gate and ABOVE rooms.handle (which would
 * otherwise answer /api/rooms/:id/site as an unknown room route).
 * ========================================================================== */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readBody, sendJson } from './http-util.ts';
import { table } from '../table/endpoint.ts';
import type { Recipe, Room, RoomSeat } from '../table/endpoint.ts';
import { ROOM_COMMANDS, basicRoomCommands } from './room-commands.ts';
import { agentCommands, edition, isBasic, TYPED_MARKER_CONFIRM, TYPED_MARKER_PLAIN, TYPED_MARKER_PREFIX } from '../engine/agent-commands.ts';
import * as sites from '../engine/sites.ts';
import * as rooms from './rooms.ts';

export interface BasicDeps extends Partial<rooms.RoomRouteDeps> {
  human: boolean;
  log(line: string): void;
}

/** GET /api/commands (any credential): what /help and /? list, for the UI and the room guide. */
export function commandsView(): Record<string, unknown> {
  const basic = isBasic();
  return {
    edition: edition(),
    passThrough: basic,
    marker: { prefix: TYPED_MARKER_PREFIX, confirm: TYPED_MARKER_CONFIRM, plain: TYPED_MARKER_PLAIN },
    room: (basic ? basicRoomCommands() : ROOM_COMMANDS)
      .filter((c) => c.class !== 'not-in-build')
      .map((c) => ({ name: `/${c.word}`, usage: c.usage, explain: c.does }))
      .concat(basic ? [{ name: '/?', usage: '/?', explain: 'this list' }] : []),
    agent: agentCommands().map((c) => ({ name: `/${c.name}`, explain: c.explain, confirm: c.confirm, ...(c.always ? { always: true } : {}) })),
  };
}

/** The Builder recipe new sites are cloned from: HARBOR_WB_BUILDER_RECIPE (id or name), else the one named "Builder". */
function builderRecipe(): Recipe | undefined {
  const want = (process.env.HARBOR_WB_BUILDER_RECIPE || 'Builder').trim();
  const all = table.listRecipes();
  return all.find((r) => r.id === want) ?? all.find((r) => r.name.toLowerCase() === want.toLowerCase());
}

const creating = new Set<string>();
const NAME_MAX = 80;

export interface NewSiteResult {
  status: number;
  body: Record<string, unknown>;
}

function fail(status: number, error: string, field: string, extra: Record<string, unknown> = {}): NewSiteResult {
  return { status, body: { ok: false, error, field, ...extra } };
}

function siteView(room: Room, row: { slug: string; site_id: string; name: string; dir: string }, seat: RoomSeat | undefined): Record<string, unknown> {
  return {
    room: { id: room.id, name: room.name },
    site: { slug: row.slug, id: row.site_id, name: row.name, dir: row.dir },
    ...(seat ? { seat: { id: seat.id, handle: seat.handle } } : {}),
  };
}

/**
 * POST /api/projects/new-site {name}. Order: run the install's new-site command
 * (nothing of ours exists yet, so a failure rolls back nothing), then the
 * recipe, room, seat and the site row; a failure THERE archives the room, drops
 * the recipe and the row (the folder is kept with its .site.json, so a retry
 * adopts it as the same project, same id). Then start the seat and post the first line; a start that
 * fails keeps the room (the person can press Start) and says so.
 * IDEMPOTENT: the same name again answers the existing site (`existed: true`).
 */
export async function newSite(body: Record<string, unknown>, deps: BasicDeps): Promise<NewSiteResult> {
  const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > NAME_MAX) {
    return fail(400, `name is the site's name, 1 to ${NAME_MAX} characters`, 'name');
  }
  let slug = sites.slugify(name);
  const existing = table.getSiteBySlug(slug);
  if (existing) {
    const room = table.getRoom(existing.room_id);
    if (room) {
      const seat = table.listSeats(room.id)[0];
      return { status: 200, body: { ok: true, existed: true, ...siteView(room, existing, seat) } };
    }
  }
  if (creating.has(slug)) {
    return fail(409, `"${name}" is already being created`, 'name');
  }
  const builder = builderRecipe();
  if (!builder) {
    return fail(409, 'this instance has no Builder recipe to start the site agent from', 'recipe');
  }
  creating.add(slug);
  try {
    const base = sites.sitesDir();
    mkdirSync(base, { recursive: true });
    let dir = join(base, slug);
    let siteId = sites.newSiteId();
    while (table.siteIdUsed(siteId)) siteId = sites.newSiteId();
    let meta = sites.readSiteJson(dir);
    if (existsSync(dir)) {
      if (!meta) {
        return fail(409, `a folder named ${slug} already exists and is not a site; pick another name`, 'name');
      }
      deps.log(`new-site: adopting ${dir} (left by an earlier try)`);
    } else {
      const r = await sites.runNewSite({ name, slug, id: siteId });
      if (!r.ok) {
        deps.log(`new-site: command failed for ${slug} (exit ${r.code})`);
        return fail(502, 'the new-site command failed; nothing was created', 'command', { detail: (r.stderr || r.stdout).trim().slice(-500) });
      }
      meta = sites.readSiteJson(dir);
      if (!existsSync(dir)) {
        return fail(502, `the new-site command finished but ${dir} is not there`, 'command', { detail: r.stdout.trim().slice(-500) });
      }
    }
    /* remote-ops mints its own slug + id into .site.json: that file is the authority */
    if (typeof meta?.slug === 'string' && meta.slug && meta.slug !== slug) {
      slug = meta.slug;
      dir = join(base, slug);
    }
    if (typeof meta?.id === 'string' && meta.id) {
      if (table.siteIdUsed(meta.id)) {
        return fail(409, 'that site id was already used once; it is never reused', 'id');
      }
      siteId = meta.id;
    }
    let room: Room | null = null;
    let recipe: Recipe | null = null;
    let seat: RoomSeat | null = null;
    try {
      const { created_at: _c, updated_at: _u, last_launched_at: _l, ...rest } = builder;
      recipe = table.upsertRecipe({ ...rest, id: `site-${siteId}`, name, projectDir: dir, agent: slug });
      room = table.createRoom({ name }, { actor: 'user' }).result;
      seat = table.addSeat(room.id, { recipe_id: recipe.id }, { actor: 'user' }).result;
      table.insertSite({ room_id: room.id, slug, site_id: siteId, name, dir, recipe_id: recipe.id });
    } catch (e) {
      if (room) {
        try {
          table.archiveRoom(room.id, { actor: 'user' });
        } catch {
          /* rolled back as far as it goes */
        }
      }
      if (recipe) {
        try {
          table.deleteRecipe(recipe.id);
        } catch {
          /* ignore */
        }
      }
      table.deleteSite(siteId);
      deps.log(`new-site: rolled back ${slug}: ${(e as Error).message}`);
      return fail(409, `the room could not be made (${(e as Error).message}); nothing is left behind but the folder`, 'room');
    }
    const status = await sites.siteStatus(dir, { slug, id: siteId, name });
    let started = false;
    let startError: string | null = null;
    let paneid: string | null = null;
    try {
      const r = await rooms.startSeatForPerson(room, seat, deps);
      started = true;
      paneid = typeof r.paneid === 'string' ? r.paneid : null;
    } catch (e) {
      startError = (e as Error).message;
      deps.log(`new-site: ${slug} created, its agent did not start: ${startError}`);
    }
    const first =
      `New site "${name}". Your project folder is ${dir}. ` +
      `Private preview (only you): ${status.previewUrl ?? 'not available yet'}. ` +
      `Public: ${status.published ? `yes, at ${status.publicUrl}` : 'not yet; it goes public only when I ask you to publish it'}.`;
    try {
      rooms.postLineAs(table.getRoom(room.id) ?? room, 'user', first, {}, { projector: async () => (x: any) => x, ...deps } as rooms.RoomRouteDeps);
    } catch (e) {
      deps.log(`new-site: first line not posted in ${room.id}: ${(e as Error).message}`);
    }
    return {
      status: 200,
      body: {
        ok: true,
        existed: false,
        ...siteView(room, { slug, site_id: siteId, name, dir }, seat),
        previewUrl: status.previewUrl,
        started,
        ...(paneid ? { paneid } : {}),
        ...(startError ? { startError } : {}),
      },
    };
  } finally {
    creating.delete(slug);
    creating.delete(sites.slugify(name));
  }
}

/** GET /api/rooms/:id/site: the bar's data; every field null when it is not a site room. */
export async function roomSite(roomId: string): Promise<Record<string, unknown>> {
  const row = table.getSiteByRoom(roomId);
  if (!row) {
    return { ...sites.NO_SITE };
  }
  const s = await sites.siteStatus(row.dir, { slug: row.slug, id: row.site_id, name: row.name });
  return { ...s, name: s.name ?? row.name };
}

export async function handle(req: IncomingMessage, res: ServerResponse, route: string, deps: BasicDeps): Promise<boolean> {
  const method = req.method ?? 'GET';
  try {
    if (route === '/api/commands' && method === 'GET') {
      sendJson(res, 200, commandsView());
      return true;
    }
    if (route === '/api/projects/new-site' && method === 'POST') {
      if (!isBasic()) {
        sendJson(res, 404, { ok: false, error: 'New site is a Basic edition feature', field: 'edition' });
        return true;
      }
      if (!deps.human) {
        sendJson(res, 403, { ok: false, error: 'a new site needs a person: send it from a window (cookie), not a bearer', field: 'credential' });
        return true;
      }
      const r = await newSite((await readBody(req)) ?? {}, deps);
      sendJson(res, r.status, r.body);
      return true;
    }
    const m = /^\/api\/rooms\/([^/]+)\/site$/.exec(route);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      if (!table.getRoom(id)) {
        sendJson(res, 404, { ok: false, error: 'no such room', field: 'room' });
        return true;
      }
      sendJson(res, 200, await roomSite(id));
      return true;
    }
  } catch (e) {
    deps.log(`basic ${method} ${route}: ${(e as Error).stack ?? String(e)}`);
    sendJson(res, 500, { ok: false, error: 'internal_error' });
    return true;
  }
  return false;
}
