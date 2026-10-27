/* ROOM TEMPLATES, the engine side (design review's note KB design-notes-id, option 3C; Owner's step H). ONE strict format, one importer, one exporter.
 *   - `role` and `recipe` on a seat are always KEYS. `roles` ({key: {text}}) and `recipes` ({key: profile}) are OPTIONAL content that fills in only what is MISSING
 *     here: a role folder that does not exist, a recipe id that does not exist. Import never overwrites the person's own roles or recipes.
 *   - STRICT: an unknown field at any level is refused (the recipe-pack rule), a carried recipe is a PROFILE (vendor, model, effort and nothing else: never initCmd,
 *     projectDir, target, an ssh alias, env), a folder is a CHOICE and never a path, `bypass` is not a permission, role text is inert data (the person confirms it on
 *     import in the app). All of it is checked BEFORE anything is written, and the create is ONE transaction.
 *   - User templates are REPEATABLE (a new room each time; no seeded marker). Lost-reply safety is an in-memory idempotency key, about 10 minutes, committed answers only.
 *   - WHAT THE ENGINE CANNOT APPLY YET is reported (`not_applied`), never silently dropped: `permission` (no per-room permission level exists), `tools` (an app joins a
 *     room through the human-registered tool registry), and a `roomLead` that is not the room's own lead ([ref] is unbuilt). The app acts on them.
 * Pure of HTTP; rooms.ts only calls createFromTemplate and exportTemplate. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { table } from '../table/endpoint.ts';
import { isSlug } from './agent-slug.ts';
import { RESERVED_HANDLES } from './room-vocab.ts';

export const FORMAT = 'workbench-room-template';
export const FORMAT_VERSION = 1;
const MAX_FILE = 256 * 1024;
const MAX_ROLE = 16 * 1024;
const MAX_ROLES = 64 * 1024;
const MAX_TEAMS = 10;
const MAX_SEATS = 50;
const VENDORS = ['claude-code', 'codex-cli', 'gemini-cli', 'cli-manager'] as const;
const FOLDERS = ['existing', 'new', 'none'] as const;
const PERMISSIONS = ['ask', 'auto'] as const;
const MODEL_RE = /^[A-Za-z0-9._-]{1,40}$/;
const NAME_RESERVED = [...RESERVED_HANDLES, 'room-lead'];

export type TemplateCode = 'invalid' | 'unsupported_format' | 'missing_recipe' | 'recipe_conflict';
export class TemplateError extends Error {
  readonly code: TemplateCode;
  readonly field?: string;
  /** machine-readable extras that ride the answer beside `error` / `field` / `code` (the missing recipe keys), so no app parses the sentence */
  readonly extra: Record<string, unknown>;
  constructor(code: TemplateCode, message: string, field?: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.field = field;
    this.extra = extra;
  }
}
const bad = (field: string, why: string): never => {
  throw new TemplateError('invalid', `${field}: ${why}`, field);
};

export interface TSeat { handle: string; role: string; recipe: string }
export interface TTeam { alias: string; name: string; lead: string; seats: TSeat[] }
export interface TRecipe { vendor: (typeof VENDORS)[number]; model?: string; effort?: string }
export interface Template {
  format: typeof FORMAT;
  formatVersion: number;
  key: string;
  name: string;
  version: number;
  brief: string;
  room: { lead: string; seats: TSeat[] };
  teams: TTeam[];
  roomLead?: string;
  tools: string[];
  permission: (typeof PERMISSIONS)[number];
  folder: (typeof FOLDERS)[number];
  roles?: Record<string, { text: string }>;
  recipes?: Record<string, TRecipe>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/* eslint-disable-next-line no-control-regex */
const CTRL_ANY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // everything but \t \n \r
/* eslint-disable-next-line no-control-regex */
const CTRL_ALL = /[\u0000-\u001f\u007f]/;

function onlyKeys(o: Record<string, unknown>, allowed: string[], path: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) bad(`${path}.${k}`, 'this field is not part of the format');
  }
}
function str(v: unknown, path: string, max: number, opts: { multiline?: boolean; min?: number } = {}): string {
  if (typeof v !== 'string') return bad(path, 'a string is expected');
  if (v.length < (opts.min ?? 0) || v.length > max) return bad(path, `between ${opts.min ?? 0} and ${max} characters`);
  if ((opts.multiline ? CTRL_ANY : CTRL_ALL).test(v)) return bad(path, 'a control character is not allowed');
  return v;
}
function slug(v: unknown, path: string): string {
  if (typeof v !== 'string' || !isSlug(v)) return bad(path, 'lowercase letters, digits and single hyphens, as written (nothing is fixed silently)');
  return v;
}
function name(v: unknown, path: string): string {
  const s = slug(v, path);
  if (NAME_RESERVED.includes(s)) return bad(path, `@${s} is reserved`);
  return s;
}

function seat(v: unknown, path: string): TSeat {
  if (!isObj(v)) return bad(path, 'a seat is {handle, role, recipe}');
  onlyKeys(v, ['handle', 'role', 'recipe'], path);
  return { handle: name(v.handle, `${path}.handle`), role: slug(v.role, `${path}.role`), recipe: slug(v.recipe, `${path}.recipe`) };
}

/** Validate a document. Throws TemplateError (code + field = the JSON path) and writes nothing. */
export function validateTemplate(doc: unknown): Template {
  if (!isObj(doc)) return bad('$', 'the document is a JSON object');
  let size = 0;
  try {
    size = JSON.stringify(doc).length;
  } catch {
    return bad('$', 'the document is not plain JSON');
  }
  if (size > MAX_FILE) return bad('$', `at most ${MAX_FILE / 1024} KB`);
  onlyKeys(doc, ['format', 'formatVersion', 'key', 'name', 'version', 'brief', 'room', 'teams', 'roomLead', 'tools', 'permission', 'folder', 'roles', 'recipes'], '$');
  if (doc.format !== FORMAT) return bad('$.format', `this is not a ${FORMAT} document`);
  const fv = doc.formatVersion;
  if (typeof fv !== 'number' || !Number.isInteger(fv) || fv < 1) return bad('$.formatVersion', 'a whole number of 1 or more');
  if (fv > FORMAT_VERSION) {
    throw new TemplateError('unsupported_format', `made by a newer Workbench (format ${fv}; this one reads up to ${FORMAT_VERSION})`, '$.formatVersion');
  }
  const key = slug(doc.key, '$.key');
  const nm = str(doc.name, '$.name', 80, { min: 1 });
  const version = doc.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return bad('$.version', 'a whole number of 1 or more');
  const brief = doc.brief === undefined ? '' : str(doc.brief, '$.brief', 4000, { multiline: true });

  const handles = new Set<string>();
  const aliases = new Set<string>();
  let seatCount = 0;
  const take = (s: TSeat, path: string): void => {
    if (handles.has(s.handle) || aliases.has(s.handle)) bad(`${path}.handle`, `@${s.handle} is used twice in this family`);
    handles.add(s.handle);
    if (++seatCount > MAX_SEATS) bad('$.room.seats', `at most ${MAX_SEATS} seats in all`);
  };

  if (!isObj(doc.room)) return bad('$.room', '{lead, seats}');
  onlyKeys(doc.room, ['lead', 'seats'], '$.room');
  if (!Array.isArray(doc.room.seats) || doc.room.seats.length < 1) return bad('$.room.seats', 'at least one seat');
  const roomSeats = (doc.room.seats as unknown[]).map((s, i) => seat(s, `$.room.seats[${i}]`));
  roomSeats.forEach((s, i) => take(s, `$.room.seats[${i}]`));
  const roomLead = name(doc.room.lead, '$.room.lead');
  if (!roomSeats.some((s) => s.handle === roomLead)) return bad('$.room.lead', 'the lead must be one of this room\'s own seats');

  const teamsIn = doc.teams === undefined ? [] : doc.teams;
  if (!Array.isArray(teamsIn)) return bad('$.teams', 'a list of teams');
  if (teamsIn.length > MAX_TEAMS) return bad('$.teams', `at most ${MAX_TEAMS} teams`);
  const teams: TTeam[] = (teamsIn as unknown[]).map((t, i) => {
    const p = `$.teams[${i}]`;
    if (!isObj(t)) return bad(p, '{alias, name, lead, seats}');
    onlyKeys(t, ['alias', 'name', 'lead', 'seats'], p);
    const alias = name(t.alias, `${p}.alias`);
    if (aliases.has(alias) || handles.has(alias)) bad(`${p}.alias`, `@${alias} is used twice in this family`);
    aliases.add(alias);
    if (!Array.isArray(t.seats) || t.seats.length < 1) return bad(`${p}.seats`, 'at least one seat');
    const seats = (t.seats as unknown[]).map((s, j) => seat(s, `${p}.seats[${j}]`));
    seats.forEach((s, j) => take(s, `${p}.seats[${j}]`));
    const lead = name(t.lead, `${p}.lead`);
    if (!seats.some((s) => s.handle === lead)) return bad(`${p}.lead`, 'the lead must be one of this team\'s own seats');
    return { alias, name: str(t.name, `${p}.name`, 80, { min: 1 }), lead, seats };
  });
  for (const t of teams) {
    if (handles.has(t.alias)) bad('$.teams', `@${t.alias} is both a handle and an alias`);
  }
  let roomLeadPtr: string | undefined;
  if (doc.roomLead !== undefined) {
    roomLeadPtr = name(doc.roomLead, '$.roomLead');
    if (roomLeadPtr !== roomLead && !teams.some((t) => t.lead === roomLeadPtr)) return bad('$.roomLead', 'must be the room\'s lead or a team\'s lead');
  }
  const tools = doc.tools === undefined ? [] : doc.tools;
  if (!Array.isArray(tools) || tools.length > 20) return bad('$.tools', 'a short list of tool ids');
  const toolIds = (tools as unknown[]).map((t, i) => slug(t, `$.tools[${i}]`));
  const permission = doc.permission === undefined ? 'ask' : doc.permission;
  if (!(PERMISSIONS as readonly unknown[]).includes(permission)) return bad('$.permission', "'ask' or 'auto'");
  const folder = doc.folder === undefined ? 'none' : doc.folder;
  if (!(FOLDERS as readonly unknown[]).includes(folder)) return bad('$.folder', "'existing', 'new' or 'none' (a choice, never a path)");

  let roles: Template['roles'];
  if (doc.roles !== undefined) {
    if (!isObj(doc.roles)) return bad('$.roles', '{role: {text}}');
    roles = {};
    let total = 0;
    for (const [rk, rv] of Object.entries(doc.roles)) {
      const p = `$.roles.${rk}`;
      slug(rk, p);
      if (!isObj(rv)) return bad(p, '{text}');
      onlyKeys(rv, ['text'], p);
      const text = str(rv.text, `${p}.text`, MAX_ROLE + 1, { multiline: true });
      if (text.length > MAX_ROLE) return bad(`${p}.text`, `at most ${MAX_ROLE / 1024} KB per role`);
      total += text.length;
      roles[rk] = { text };
    }
    if (total > MAX_ROLES) return bad('$.roles', `at most ${MAX_ROLES / 1024} KB for all roles`);
  }
  let recipes: Template['recipes'];
  if (doc.recipes !== undefined) {
    if (!isObj(doc.recipes)) return bad('$.recipes', '{recipe: {vendor, model?, effort?}}');
    recipes = {};
    for (const [rk, rv] of Object.entries(doc.recipes)) {
      const p = `$.recipes.${rk}`;
      slug(rk, p);
      if (!isObj(rv)) return bad(p, '{vendor, model?, effort?}');
      onlyKeys(rv, ['vendor', 'model', 'effort'], p);
      if (!(VENDORS as readonly unknown[]).includes(rv.vendor)) return bad(`${p}.vendor`, `one of ${VENDORS.join(', ')}`);
      const r: TRecipe = { vendor: rv.vendor as TRecipe['vendor'] };
      if (rv.model !== undefined && rv.model !== null) {
        if (typeof rv.model !== 'string' || !MODEL_RE.test(rv.model)) return bad(`${p}.model`, 'a model name');
        r.model = rv.model;
      }
      if (rv.effort !== undefined && rv.effort !== null) {
        if (typeof rv.effort !== 'string' || !/^[a-z]{2,12}$/.test(rv.effort)) return bad(`${p}.effort`, 'an effort word');
        r.effort = rv.effort;
      }
      recipes[rk] = r;
    }
  }
  return {
    format: FORMAT, formatVersion: fv, key, name: nm, version, brief,
    room: { lead: roomLead, seats: roomSeats }, teams, ...(roomLeadPtr ? { roomLead: roomLeadPtr } : {}),
    tools: toolIds, permission: permission as Template['permission'], folder: folder as Template['folder'],
    ...(roles ? { roles } : {}), ...(recipes ? { recipes } : {}),
  };
}

export interface CreateResult {
  status: 'created' | 'replayed';
  room_id: string;
  groups: Record<string, string>;
  seats: Record<string, string>;
  template: { key: string; version: number };
  /** the folder CHOICE: the app asks for the path (existing) or makes the folder (new) through the code-folder routes */
  folder: Template['folder'];
  permission: Template['permission'];
  tools: string[];
  /** what the engine could not apply and the app must: 'permission', 'tools', 'roomLead' */
  not_applied: string[];
  /** sentences already written into the new room as facts */
  facts: string[];
}

const ACTOR = { actor: 'user' } as const;
const replay = new Map<string, { at: number; result: CreateResult }>();
const REPLAY_MS = 10 * 60_000;
export function _resetReplay(): void {
  replay.clear();
}

const sameProfile = (a: { vendor: string; model: string | null; effort: string | null }, b: TRecipe): boolean =>
  a.vendor === b.vendor && (a.model ?? null) === (b.model ?? null) && ((a.effort as string | null) ?? null) === (b.effort ?? null);

/** Create a NEW room (and its teams and seats) from a document, in one transaction. Nothing is started. */
export function createFromTemplate(doc: unknown, opts: { env?: Record<string, string | undefined>; idempotencyKey?: string | null } = {}): CreateResult {
  const env = opts.env ?? process.env;
  const idem = typeof opts.idempotencyKey === 'string' && opts.idempotencyKey ? opts.idempotencyKey.slice(0, 128) : null;
  const now = Date.now();
  for (const [k, v] of replay) if (now - v.at > REPLAY_MS) replay.delete(k);
  if (idem) {
    const hit = replay.get(idem);
    if (hit) return { ...hit.result, status: 'replayed' };
  }
  const tpl = validateTemplate(doc);
  const files = env.HARBOR_WB_FILES_DIR?.trim() || null;
  const facts: string[] = [];

  /* RECIPES FIRST (resolved or refused before the transaction opens, so a refusal writes nothing). */
  const allSeats = [...tpl.room.seats, ...tpl.teams.flatMap((t) => t.seats)];
  const recipeFor = new Map<string, string>(); // template recipe key -> the id seats get
  const toCreate: Array<{ id: string; key: string; role: string; profile: TRecipe }> = [];
  for (const s of allSeats) {
    if (recipeFor.has(s.recipe)) continue;
    if (table.getRecipe(s.recipe)) {
      recipeFor.set(s.recipe, s.recipe); // the person's own recipe with that key: used as is
      continue;
    }
    const profile = tpl.recipes?.[s.recipe];
    if (!profile) {
      /* name EVERY missing key, not just the first, in a structured field */
      const missing = [...new Set(allSeats.map((x) => x.recipe).filter((k) => !table.getRecipe(k) && !tpl.recipes?.[k]))];
      throw new TemplateError(
        'missing_recipe',
        `this template needs ${missing.length > 1 ? 'recipes' : 'a recipe'} called ${missing.map((k) => `"${k}"`).join(', ')}, which this install does not have and the file does not carry`,
        'recipe',
        { recipe: missing[0], recipes: missing },
      );
    }
    const id = `tpl-${tpl.key}-${s.recipe}`;
    const existing = table.getRecipe(id);
    if (existing && !sameProfile(existing as never, profile)) {
      throw new TemplateError('recipe_conflict', `a recipe with the id "${id}" already exists with different settings; rename or remove it and try again`, 'recipe');
    }
    recipeFor.set(s.recipe, id);
    if (!existing) toCreate.push({ id, key: s.recipe, role: s.role, profile });
  }

  const ordered = <T extends TSeat>(seats: T[], lead: string): T[] => [...seats.filter((s) => s.handle === lead), ...seats.filter((s) => s.handle !== lead)];
  const out = table.roomBatch((tx): CreateResult => {
    for (const c of toCreate) {
      table.upsertRecipe({
        id: c.id, name: `${tpl.name} · ${c.key}`, target: 'local', projectDir: files ? join(files, 'agents', c.role) : null, vendor: c.profile.vendor, agent: null,
        model: c.profile.model ?? null, effort: c.profile.effort ?? null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null,
        color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
      } as never);
    }
    const seats: Record<string, string> = {};
    const groups: Record<string, string> = {};
    const main = tx.createRoom({ name: tpl.name }, ACTOR).result;
    if (tpl.brief) tx.setRoomBrief(main.id, tpl.brief, ACTOR);
    for (const s of ordered(tpl.room.seats, tpl.room.lead)) {
      seats[s.handle] = tx.addSeat(main.id, { recipe_id: recipeFor.get(s.recipe), handle: s.handle }, ACTOR).result.id;
    }
    for (const t of tpl.teams) {
      const room = tx.createRoom({ name: t.name, parent_id: main.id, alias: t.alias }, ACTOR).result;
      groups[t.alias] = room.id;
      for (const s of ordered(t.seats, t.lead)) {
        seats[s.handle] = tx.addSeat(room.id, { recipe_id: recipeFor.get(s.recipe), handle: s.handle }, ACTOR).result.id;
      }
    }
    const notApplied: string[] = [];
    notApplied.push('permission'); // ALWAYS, until a per-room permission level exists (even 'ask' is not applied: do not "fix" this into skipping 'ask')
    if (tpl.tools.length) notApplied.push('tools');
    if (tpl.roomLead && tpl.roomLead !== tpl.room.lead) notApplied.push('roomLead');
    return {
      status: 'created', room_id: main.id, groups, seats, template: { key: tpl.key, version: tpl.version }, folder: tpl.folder, permission: tpl.permission,
      tools: tpl.tools, not_applied: notApplied, facts,
    };
  });
  const result = out.value;

  /* ROLE FILES, after the commit and best effort (files are not transactional): written ONLY where the folder is missing; the person's own always wins. */
  if (tpl.roles && files) {
    for (const [role, { text }] of Object.entries(tpl.roles)) {
      const folder = join(files, 'agents', role);
      try {
        if (existsSync(folder)) {
          facts.push(`agents/${role} already exists here; yours was kept, the template's was not written`);
          continue;
        }
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'CLAUDE.md'), text, { flag: 'wx' });
        writeFileSync(join(folder, 'AGENTS.md'), text, { flag: 'wx' });
      } catch (e) {
        facts.push(`agents/${role} could not be written (${(e as Error).message})`);
      }
    }
  } else if (tpl.roles && !files) {
    facts.push('this template carries role text, but there is no files folder here to write it to');
  }
  for (const f of facts) {
    try {
      table.appendLine(result.room_id, { kind: 'fact', body: f } as never, ACTOR);
    } catch {
      /* a fact is never worth a failed create */
    }
  }
  if (idem) replay.set(idem, { at: now, result });
  return result;
}

/** A room's family as a document. Keys always; content (`roles`, `recipes`) only when asked. Never paths, history, notes, files, tasks or credentials. */
export function exportTemplate(
  roomId: string,
  opts: { env?: Record<string, string | undefined>; teams?: string[] | null; embed?: Array<'roles' | 'recipes'> } = {},
): Record<string, any> {
  const env = opts.env ?? process.env;
  const files = env.HARBOR_WB_FILES_DIR?.trim() || null;
  const room = table.getRoom(roomId);
  if (!room) throw new TemplateError('invalid', 'there is no such room', 'room');
  if (room.parent_id) throw new TemplateError('invalid', 'only a main room can be exported; open the room this team belongs to', 'room');
  const used = new Map<string, { role: string }>();
  const seatsOf = (rid: string): TSeat[] => {
    const lead = table.getRoom(rid)?.lead_seat;
    const rows = table.listSeats(rid).filter((s) => !!s.recipe_id);
    rows.sort((a, b) => Number(b.id === lead) - Number(a.id === lead));
    return rows.map((s) => {
      const rec = table.getRecipe(s.recipe_id as string);
      const dir = rec?.projectDir ?? '';
      const parts = dir.split(/[/\\]/).filter(Boolean);
      const role = parts.length >= 2 && parts[parts.length - 2] === 'agents' && isSlug(parts[parts.length - 1]) ? parts[parts.length - 1] : (s.recipe_id as string);
      used.set(s.recipe_id as string, { role });
      return { handle: s.handle, role: isSlug(role) ? role : 'custom', recipe: s.recipe_id as string };
    });
  };
  const leadHandle = (rid: string): string => {
    const l = table.getRoom(rid)?.lead_seat;
    return (l ? table.getSeat(l)?.handle : undefined) ?? seatsOf(rid)[0]?.handle ?? '';
  };
  const mainSeats = seatsOf(room.id);
  const wanted = opts.teams ?? null;
  const teamRooms = table.listRooms({}).filter((r) => r.parent_id === room.id && r.state === 'open' && r.alias && (!wanted || wanted.includes(r.alias)));
  const doc: Record<string, any> = {
    format: FORMAT, formatVersion: FORMAT_VERSION, key: (isSlug(room.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) ? room.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'room').slice(0, 60),
    name: room.name, version: 1, brief: room.brief ?? '',
    room: { lead: leadHandle(room.id), seats: mainSeats },
    teams: teamRooms.map((t) => ({ alias: t.alias as string, name: t.name, lead: leadHandle(t.id), seats: seatsOf(t.id) })),
    tools: table.listRoomApps(room.id).map((a) => a.slug).filter((s) => isSlug(s)),
    permission: 'ask',
    folder: table.familyCodeFolder(room.id)?.mode ?? 'none',
  };
  if (opts.embed?.includes('recipes')) {
    doc.recipes = {};
    for (const key of used.keys()) {
      const rec = table.getRecipe(key);
      if (!rec) continue;
      const vendor = (VENDORS as readonly string[]).includes(rec.vendor) ? rec.vendor : 'claude-code';
      doc.recipes[key] = { vendor, ...(rec.model ? { model: rec.model } : {}), ...(rec.effort ? { effort: rec.effort } : {}) };
    }
  }
  if (opts.embed?.includes('roles') && files) {
    doc.roles = {};
    for (const { role } of used.values()) {
      if (!isSlug(role)) continue;
      try {
        const text = readFileSync(join(files, 'agents', role, 'CLAUDE.md'), 'utf8').slice(0, MAX_ROLE);
        if (text.trim()) doc.roles[role] = { text };
      } catch {
        /* no such role file: the key alone travels */
      }
    }
  }
  void basename; void dirname;
  return doc;
}
