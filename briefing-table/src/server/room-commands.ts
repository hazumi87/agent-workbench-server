/**
 * ROOM COMMANDS — the room line's own `/` namespace (the design notes
 * §3, wr §2.5b-c) [ticket].
 *
 * `parse(text, seats)` is PURE: no db, no clock, no I/O. It decides what a
 * line of text IS; it never does it. The route (src/server/rooms.ts) calls the
 * matching table verb, so the typed door and the HTTP door write identical
 * facts. Parsed HERE in the engine, never in a page: the phone, the desktop
 * and voice must all get the same verbs (command parity is the mobile
 * strategy, wr §2.5c).
 *
 * PRECEDENCE (§3):
 *   0. `@all` anywhere is refused — installation-wide addressing needs the fabric;
 *      it is deferred, never narrowed to `@room`.
 *   1. A verb in the room table is a room command (incl. the two not-in-build
 *      verbs, which refuse DISTINCTLY from unknown).
 *   2. An unknown `/verb` WITH an explicit `@handle` / `@room` is CARRIED —
 *      delivered as a message asking the member to run it, never typed into a
 *      terminal — UNLESS the verb is within edit distance 1 of a room verb of
 *      five or more letters: then it is refused with that verb as the
 *      suggestion, whatever its target. A typo'd structural command must
 *      never reach an agent as an instruction (lead decision 2026-09-23).
 *   3. An unknown `/verb` with NO target is refused with a suggestion: the
 *      nearest room verb by edit distance, else "send it to @<lead>?". Never
 *      silently relayed — that is how two namespaces blur.
 *   4. (0 above.)
 *   5. With no lead, un-addressed chat and un-addressed carried commands are
 *      refused: "no lead yet — /set lead @<handle>". Addressed text is fine.
 *
 * Test table: test/fixtures/room-commands.json (shared with the page's
 * completion). Every row there is one input and its exact expected output.
 */
import { normalizeSlug } from '../engine/agent-slug.ts';
import { RESERVED_HANDLES, SEAT_POLICIES } from '../engine/room-vocab.ts';

/** The seat shape the parser needs — a store RoomSeat satisfies it. */
export interface ParseSeat {
  id: string;
  handle: string;
  is_lead?: boolean;
}

/** WORKGROUPS (Owner 2026-10-04): what a typed `@token` may also mean in a room
 *  of a family — pure data, the route reads it from the table. */
export interface ParseFamily {
  /** This room is a workgroup: `@lead` means the HEAD room's lead. */
  inWorkgroup: boolean;
  headLead: ParseSeat | null;
  /** Active seats of the family's OTHER rooms (a handle there is a direct address). */
  seats: ParseSeat[];
  /** Each family room's alias -> its lead (null = no lead yet). */
  aliases: Array<{ alias: string; roomName: string; lead: ParseSeat | null }>;
}

export type SeatRef = { seatId: string; handle: string };

export type RoomVerb =
  | 'set-lead'
  | 'set-policy'
  | 'set-turn'
  | 'set-store'
  | 'floor-take'
  | 'seat-restart'
  | 'seat-restart-all'
  | 'seat-restart-stop'
  | 'floor-skip'
  | 'rename-room'
  | 'rename-seat'
  | 'add'
  | 'replace'
  | 'remove'
  | 'wake'
  | 'deliver'
  | 'archive'
  | 'dissolve'
  | 'reopen'
  | 'mode'
  | 'brief'
  | 'help';

export type ParseResult =
  | { type: 'room'; verb: RoomVerb; target: SeatRef | 'room' | null; args: Record<string, unknown> }
  | { type: 'carried'; text: string; to: string[] | 'room' }
  /** [basic] a typed command for the agent: delivered verbatim + the typed marker */
  | { type: 'typed'; text: string; word: string; to: string[] }
  | { type: 'chat'; to: string | string[] | 'room'; toUser?: true; leadDefault?: true }
  | { type: 'refused'; error: string; suggestion: string | null };

/** The error a not-in-build verb answers with — distinct from "unknown". */
export const NOT_IN_BUILD = 'not in this build';

/**
 * The verb table: serves /help and the page's completion (GET
 * /api/rooms/commands). `class` is the Phase-1 status: executed; bind-only
 * until summon lands (§0.1 Q1); or refused as not in this build.
 */
export const ROOM_COMMANDS: ReadonlyArray<{
  word: string;
  verb: RoomVerb | null;
  usage: string;
  does: string;
  /** the area for the "/" list's headers (the design system [ref]) */
  group: 'Floor' | 'Seats' | 'Room';
  class: 'executed' | 'bind-only' | 'not-in-build';
  confirms?: boolean;
}> = [
  { word: 'set', verb: 'set-lead', usage: '/set lead @<handle>', does: 'Hand the lead over to a seat', group: 'Seats', class: 'executed' },
  { word: 'set', verb: 'set-policy', usage: '/set policy @<handle> <persistent|fresh|dispatched|pool> [size]', does: 'Set how a seat is filled', group: 'Seats', class: 'executed' },
  { word: 'set', verb: 'set-store', usage: '/set store <address|default>', does: "Set the room file store's address", group: 'Room', class: 'executed' },
  { word: 'set', verb: 'set-turn', usage: '/set turn <minutes|default>', does: 'Set how long a seat holds the floor (default 5 min)', group: 'Floor', class: 'executed' },
  { word: 'seat', verb: 'seat-restart', usage: '/seat restart @<handle>', does: 'Restart a seat that is not live', group: 'Seats', class: 'executed' },
  { word: 'seat', verb: 'seat-restart-all', usage: '/seat restart all', does: 'Restart every seat that is not live, one by one', group: 'Seats', class: 'executed' },
  { word: 'seat', verb: 'seat-restart-stop', usage: '/seat restart stop', does: 'Stop a running restart of all seats', group: 'Seats', class: 'executed' },
  { word: 'floor', verb: 'floor-take', usage: '/floor take', does: 'End every turn held in this room', group: 'Floor', class: 'executed' },
  { word: 'floor', verb: 'floor-skip', usage: '/floor skip @<handle>', does: "Skip a seat's turn", group: 'Floor', class: 'executed' },
  { word: 'rename', verb: 'rename-room', usage: '/rename room <name>', does: 'Name the room', group: 'Room', class: 'executed' },
  { word: 'rename', verb: 'rename-seat', usage: '/rename @<handle> to @<new-handle>', does: "Change a seat's address", group: 'Seats', class: 'executed' },
  { word: 'add', verb: 'add', usage: '/add <project> [as @<handle>]', does: 'Bring a project into a seat', group: 'Seats', class: 'bind-only' },
  { word: 'replace', verb: 'replace', usage: '/replace @<handle> [with <paneid>]', does: "Swap a seat's occupant, keeping the seat", group: 'Seats', class: 'bind-only' },
  { word: 'remove', verb: 'remove', usage: '/remove @<handle> [confirm]', does: 'Give up a seat', group: 'Seats', class: 'executed', confirms: true },
  { word: 'wake', verb: 'wake', usage: '/wake @<handle>', does: 'Bring a resting seat back', group: 'Seats', class: 'executed' },
  { word: 'deliver', verb: 'deliver', usage: '/deliver @<handle>', does: "Type a seat's held lines into its input box", group: 'Seats', class: 'executed' },
  { word: 'archive', verb: 'archive', usage: '/archive [confirm]', does: 'Put the room in stasis', group: 'Room', class: 'executed', confirms: true },
  { word: 'dissolve', verb: 'dissolve', usage: '/dissolve [confirm]', does: 'Dissolve this workgroup and return its seats', group: 'Room', class: 'executed', confirms: true },
  { word: 'reopen', verb: 'reopen', usage: '/reopen', does: 'Bring the room out of stasis', group: 'Room', class: 'executed' },
  { word: 'mode', verb: 'mode', usage: '/mode <autonomous|off>', does: 'Set the room mode for when you step away', group: 'Room', class: 'executed' },
  { word: 'brief', verb: 'brief', usage: '/brief <markdown> | /brief clear | /brief', does: "Set, clear or show the room's brief", group: 'Room', class: 'executed' },
  { word: 'help', verb: 'help', usage: '/help', does: 'List the room commands', group: 'Room', class: 'executed' },
  { word: 'seam', verb: null, usage: '/seam', does: 'Open the seam definition', group: 'Room', class: 'not-in-build' },
  { word: 'voice', verb: null, usage: '/voice on', does: 'Start voice for this room', group: 'Room', class: 'not-in-build' },
];

const VERB_WORDS = [...new Set(ROOM_COMMANDS.map((c) => c.word))];
// Only the structural verbs (5+ letters): a carried typo of one would skip its confirm step; short ones are common words.
const GUARDED_VERBS = VERB_WORDS.filter((w) => w.length >= 5);

const refused = (error: string, suggestion: string | null = null): ParseResult => ({ type: 'refused', error, suggestion });

/** Optimal-string-alignment distance: Levenshtein plus adjacent swaps, so a
 *  typo like `/remvoe` is ONE edit from `remove`. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) {
    d[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** The closest candidate within `max` (default: a small, length-scaled
 *  distance), or null. */
function nearest(word: string, candidates: string[], max = word.length <= 3 ? 1 : 2): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const dist = editDistance(word, c);
    if (dist < bestD) {
      best = c;
      bestD = dist;
    }
  }
  return best !== null && bestD <= max ? best : null;
}

/** `@the design system`, `@the design system,` `@the design system)` -> 'the design system'; anything else -> null. */
export function addressOf(token: string | undefined): string | null {
  const m = /^@([A-Za-z0-9][A-Za-z0-9-]*)[,.:;!?)\]}"']*$/.exec(token ?? '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * The leading `@token` of a line of text, lowercased, or null — the typed
 * address the route stores as the entry's `target` snapshot (display only).
 */
export function leadingAddress(text: string): string | null {
  const t = (text ?? '').trim();
  const first = t.startsWith('/') ? null : t.split(/\s+/)[0];
  return addressOf(first ?? undefined);
}

/**
 * A REPLY IS ADDRESSED BY ITS LEADING @ LIST ONLY (Owner [ref]: a reply is used like a forward; to name someone you put
 * the name at the start, unambiguously). Returns `text` with every @ AFTER the leading run of @words turned into the
 * full-width commercial at (U+FF20), so the parser, which would deliver to a name anywhere in the text, sees only the
 * leading names. For addressing only: the saved and shown text is never this copy. A line that does not start with an
 * @word keeps no addresses at all (a reply with none goes to the author of the line it answers).
 */
export function leadOnlyAddresses(text: string): string {
  const t = text ?? '';
  const m = /^\s*/.exec(t);
  let i = m ? m[0].length : 0;
  while (i < t.length) {
    const sp = t.slice(i).search(/\s/);
    const word = sp < 0 ? t.slice(i) : t.slice(i, i + sp);
    if (addressOf(word) === null) {
      break;
    }
    i += word.length;
    const ws = /^\s*/.exec(t.slice(i));
    i += ws ? ws[0].length : 0;
  }
  return t.slice(0, i) + t.slice(i).split('@').join(String.fromCharCode(0xff20));
}

/**
 * THE SEATS A REPLY NAMED BUT DID NOT ADDRESS. A reply is addressed by its leading @ list only (`leadOnlyAddresses`), so a seat named
 * lower down, after prose or after a leading @owner, is text and never receives the line. This returns those seat ids: the ones the whole
 * text names minus the ones the leading list addresses, so the sender can be told instead of finding out from silence. A command is
 * never a reply; code and quotes are already stripped by the parser, so a backticked name is not counted.
 */
export function droppedAddresses(text: string, seats: ParseSeat[], opts: ParseOpts = {}): string[] {
  if ((text ?? '').trim().startsWith('/')) {
    return [];
  }
  const seatIds = (t: string): string[] => {
    const p = parse(t, seats, { ...opts, unaddressedToLead: false });
    // `to` is 'room', a single seat id (one address), or a list; a single id is as good as a list of one
    return p.type === 'chat' && p.to !== 'room' && !p.leadDefault ? (Array.isArray(p.to) ? (p.to as string[]) : [p.to as string]) : [];
  };
  const reached = new Set(seatIds(leadOnlyAddresses(text)));
  return seatIds(text).filter((id) => !reached.has(id));
}

const ALL_RE = /(^|\s)@all(?=$|[\s,.:;!?])/i;

function isLead(s: ParseSeat): boolean {
  return s.is_lead === true;
}

function noLead(seats: ParseSeat[]): ParseResult {
  const h = seats[0]?.handle ?? '<handle>';
  return refused('no lead yet — un-addressed text goes to the lead', `/set lead @${h}`);
}

function unknownSeat(name: string, seats: ParseSeat[], fam?: ParseFamily): ParseResult {
  const near = nearest(name, [...seats.map((s) => s.handle), ...(fam?.seats.map((s) => s.handle) ?? []), ...(fam?.aliases.map((a) => a.alias) ?? [])]);
  const suggestion = near
    ? `did you mean @${near}?`
    : seats.length
      ? `members: ${seats.map((s) => `@${s.handle}`).join(', ')}`
      : 'this room has no members yet — /add <project>';
  return refused(`no @${name} in this room`, suggestion);
}

type Resolved = { ok: SeatRef | 'room' } | { refusal: ParseResult };

/** Resolve one address word (no `@`) against the room — and, for a line that is
 *  being SENT (chat or a carried command), against its family `fam`:
 *   (a) a seat handle in this room, (b) a seat handle anywhere in the family,
 *   (c) `@lead` = the HEAD room's lead (this room's own lead in a main room),
 *   (d) a room alias in the family = that room's lead, (e) `@room` = this room.
 *  Room verbs (/set, /remove ...) never pass `fam`: they act on THIS room. */
function resolve(name: string, seats: ParseSeat[], fam?: ParseFamily): Resolved {
  if (name === 'room') {
    return { ok: 'room' };
  }
  if (name === 'user' && !seats.some((s) => s.handle === name)) {
    // only a /command operand gets here: chat reads @user as THE USER (isUserAddress)
    return { refusal: refused('@user is the user, not a seat', 'name a seat: @<handle>') };
  }
  if (name === 'lead') {
    if (fam?.inWorkgroup) {
      return fam.headLead
        ? { ok: { seatId: fam.headLead.id, handle: fam.headLead.handle } }
        : { refusal: refused('the main room has no lead yet', null) };
    }
    const lead = seats.find(isLead);
    return lead ? { ok: { seatId: lead.id, handle: lead.handle } } : { refusal: noLead(seats) };
  }
  const seat = seats.find((s) => s.handle === name) ?? fam?.seats.find((s) => s.handle === name);
  if (seat) {
    return { ok: { seatId: seat.id, handle: seat.handle } };
  }
  const al = fam?.aliases.find((a) => a.alias === name);
  if (al) {
    return al.lead
      ? { ok: { seatId: al.lead.id, handle: al.lead.handle } }
      : { refusal: refused(`"${al.roomName}" has no lead yet`, null) };
  }
  return { refusal: unknownSeat(name, seats, fam) };
}

/** A seat operand: `@x` or a bare `x`; `@room` is not a seat. */
function seatOperand(token: string | undefined, seats: ParseSeat[], usage: string, fam?: ParseFamily): { seat: SeatRef } | { refusal: ParseResult } {
  if (!token) {
    return { refusal: refused('which seat?', usage) };
  }
  const name = addressOf(token) ?? addressOf(`@${token}`);
  if (!name) {
    return { refusal: refused(`"${token}" is not a handle`, usage) };
  }
  const r = resolve(name, seats, fam);
  if ('refusal' in r) {
    return r;
  }
  if (r.ok === 'room') {
    return { refusal: refused('@room is everyone, not a seat', usage) };
  }
  return { seat: r.ok };
}

/** A NEW handle the user typed: normalised, and never a reserved one. */
function newHandle(token: string | undefined, usage: string): { handle: string } | { refusal: ParseResult } {
  const h = normalizeSlug((token ?? '').replace(/^@/, ''));
  if (!h) {
    return { refusal: refused('a handle is lowercase letters, digits and single hyphens', usage) };
  }
  if (RESERVED_HANDLES.includes(h)) {
    return { refusal: refused(`@${h} is reserved`, usage) };
  }
  return { handle: h };
}

const room = (verb: RoomVerb, target: SeatRef | 'room' | null, args: Record<string, unknown> = {}): ParseResult => ({
  type: 'room',
  verb,
  target,
  args,
});

function parseCommand(t: string, seats: ParseSeat[], fam?: ParseFamily): ParseResult {
  const parts = t.slice(1).split(/\s+/).filter(Boolean);
  const word = (parts[0] ?? '').toLowerCase();
  const rest = parts.slice(1);
  if (!word) {
    return refused('an empty command', '/help');
  }
  switch (word) {
    case 'set': {
      const sub = (rest[0] ?? '').toLowerCase();
      if (sub === 'lead') {
        const r = seatOperand(rest[1], seats, '/set lead @<handle>');
        return 'refusal' in r ? r.refusal : room('set-lead', r.seat);
      }
      if (sub === 'policy') {
        const usage = `/set policy @<handle> <${SEAT_POLICIES.join('|')}>`;
        const r = seatOperand(rest[1], seats, usage);
        if ('refusal' in r) {
          return r.refusal;
        }
        const policy = (rest[2] ?? '').toLowerCase();
        if (!(SEAT_POLICIES as readonly string[]).includes(policy)) {
          return refused(policy ? `"${policy}" is not a policy` : 'which policy?', usage);
        }
        const args: Record<string, unknown> = { policy };
        if (rest[3] !== undefined) {
          const n = Number(rest[3]);
          if (policy !== 'pool' || !Number.isInteger(n) || n < 1) {
            return refused('only a pool takes a size, and it is a positive whole number', `/set policy @${r.seat.handle} pool 4`);
          }
          args.pool_size = n;
        }
        return room('set-policy', r.seat, args);
      }
      if (sub === 'store') {
        const v = rest[1] ?? '';
        if (!v) {
          return refused('which address?', '/set store http://host:8215 (or /set store default)');
        }
        return room('set-store', 'room', { address: v.toLowerCase() === 'default' ? null : v });
      }
      if (sub === 'turn') {
        const v = (rest[1] ?? '').toLowerCase();
        if (v === 'default') {
          return room('set-turn', 'room', { minutes: null });
        }
        const n = Number(v);
        if (!v || !Number.isInteger(n) || n < 1 || n > 120) {
          return refused('a turn time is a whole number of minutes, 1 to 120 (or "default")', '/set turn 5');
        }
        return room('set-turn', 'room', { minutes: n });
      }
      const near = nearest(sub, ['lead', 'policy', 'turn', 'store']);
      return refused(`"/set ${sub}" is not a room command`, near ? `/set ${near}` : '/set lead @<handle>, /set policy @<handle> <policy>, /set turn <minutes> or /set store <address>');
    }
    case 'seat': {
      const sub = (rest[0] ?? '').toLowerCase();
      if (sub !== 'restart') {
        return refused(sub ? `"/seat ${sub}" is not a room command` : 'restart what?', '/seat restart @<handle>');
      }
      const what = (rest[1] ?? '').toLowerCase();
      if (what === 'all') {
        return room('seat-restart-all', 'room');
      }
      if (what === 'stop') {
        return room('seat-restart-stop', 'room');
      }
      const r = seatOperand(rest[1], seats, '/seat restart @<handle>', fam); // a lead may reach a seat of its family
      return 'refusal' in r ? r.refusal : room('seat-restart', r.seat);
    }
    case 'floor': {
      const sub = (rest[0] ?? '').toLowerCase();
      if (sub === 'take') {
        return room('floor-take', 'room');
      }
      if (sub === 'skip') {
        const r = seatOperand(rest[1], seats, '/floor skip @<handle>');
        return 'refusal' in r ? r.refusal : room('floor-skip', r.seat);
      }
      return refused(sub ? `"/floor ${sub}" is not a room command` : 'take or skip?', '/floor take or /floor skip @<handle>');
    }
    case 'rename': {
      if ((rest[0] ?? '').toLowerCase() === 'room') {
        const name = /^\/rename\s+room\s+([\s\S]*)$/i.exec(t)?.[1]?.trim() ?? '';
        return name ? room('rename-room', 'room', { name }) : refused('what should the room be called?', '/rename room <name>');
      }
      const usage = '/rename @<handle> to @<new-handle>';
      const r = seatOperand(rest[0], seats, usage);
      if ('refusal' in r) {
        return r.refusal;
      }
      const to = (rest[1] ?? '').toLowerCase() === 'to' ? rest[2] : rest[1];
      const h = newHandle(to, usage);
      return 'refusal' in h ? h.refusal : room('rename-seat', r.seat, { handle: h.handle });
    }
    case 'add': {
      const usage = '/add <project> [as @<handle>]';
      const project = rest[0];
      if (!project || project.startsWith('@')) {
        return refused('which project?', usage);
      }
      const args: Record<string, unknown> = { project };
      if (rest[1] !== undefined) {
        if (rest[1].toLowerCase() !== 'as') {
          return refused(`expected "as", got "${rest[1]}"`, usage);
        }
        const h = newHandle(rest[2], usage);
        if ('refusal' in h) {
          return h.refusal;
        }
        args.handle = h.handle;
      }
      return room('add', null, args);
    }
    case 'replace': {
      const usage = '/replace @<handle> [with <paneid>]';
      const r = seatOperand(rest[0], seats, usage);
      if ('refusal' in r) {
        return r.refusal;
      }
      const args: Record<string, unknown> = {};
      if (rest[1] !== undefined) {
        if (rest[1].toLowerCase() !== 'with' || !rest[2]) {
          return refused('replace it with which pane?', usage);
        }
        args.paneid = rest[2];
      }
      return room('replace', r.seat, args);
    }
    case 'remove': {
      const r = seatOperand(rest[0], seats, '/remove @<handle>');
      return 'refusal' in r ? r.refusal : room('remove', r.seat, { confirm: (rest[1] ?? '').toLowerCase() === 'confirm' });
    }
    case 'wake': {
      const r = seatOperand(rest[0], seats, '/wake @<handle>');
      return 'refusal' in r ? r.refusal : room('wake', r.seat);
    }
    case 'deliver': {
      const r = seatOperand(rest[0], seats, '/deliver @<handle>');
      return 'refusal' in r ? r.refusal : room('deliver', r.seat, { confirm: (rest[1] ?? '').toLowerCase() === 'confirm' });
    }
    case 'archive':
      return room('archive', 'room', { confirm: (rest[0] ?? '').toLowerCase() === 'confirm' });
    case 'dissolve':
      return room('dissolve', 'room', { confirm: (rest[0] ?? '').toLowerCase() === 'confirm' });
    case 'reopen':
      return room('reopen', 'room');
    case 'mode': {
      const m = (rest[0] ?? '').toLowerCase();
      if (!m) {
        return refused('which mode?', '/mode autonomous');
      }
      return room('mode', 'room', { mode: m === 'off' ? null : m });
    }
    case 'brief': {
      /* [room brief] Owner 2026-10-05: the markdown may span lines, so it is read from the raw text. */
      const body = /^\/brief\s+([\s\S]*)$/i.exec(t)?.[1]?.trim() ?? '';
      if (!body) {
        return room('brief', 'room', { show: true });
      }
      return room('brief', 'room', body.toLowerCase() === 'clear' ? { clear: true } : { text: body });
    }
    case 'help':
      return room('help', null);
    case 'seam':
    case 'voice':
      return refused(NOT_IN_BUILD, null);
    default:
      break;
  }

  // Not a room verb. One edit from a structural one is a typo of it, refused
  // whatever the target — never carried to an agent as an instruction (rule
  // 2's guard).
  const typo = nearest(word, GUARDED_VERBS, 1);
  if (typo) {
    return refused(`"/${word}" is not a room command`, `did you mean /${typo}?`);
  }

  // Carried if it names who should run it (rule 2).
  const addressed = rest.map((tok) => addressOf(tok)).filter((a): a is string => a !== null);
  if (addressed.length) {
    const to: string[] = [];
    let toRoom = false;
    for (const name of addressed) {
      const r = resolve(name, seats, fam);
      if ('refusal' in r) {
        return r.refusal; // an unknown @handle, or @lead with no lead (rule 5)
      }
      if (r.ok === 'room') {
        toRoom = true;
      } else if (!to.includes(r.ok.seatId)) {
        to.push(r.ok.seatId);
      }
    }
    return { type: 'carried', text: t, to: toRoom ? 'room' : to };
  }

  // Unknown and un-addressed: refused with a suggestion (rule 3).
  const near = nearest(word, VERB_WORDS);
  if (near) {
    return refused(`"/${word}" is not a room command`, `did you mean /${near}?`);
  }
  const lead = seats.find(isLead);
  return refused(
    `"/${word}" is not a room command`,
    lead ? `send it to @${lead.handle}? /${word} @${lead.handle}` : `no lead yet — /set lead @${seats[0]?.handle ?? '<handle>'}`,
  );
}

/* [basic] THE BASIC ROOM COMMANDS (blueprint design-notes-id: one agent per room, no
   workgroups / leads / multi-seat). Only these stay room commands in a Basic room; every
   other `/word` the user types is a typed command for the room's agent. `/rename room
   <name>` is the room's; a bare `/rename <name>` is the agent's (rename the project). */
export const BASIC_ROOM_WORDS: readonly string[] = ['help', 'rename', 'wake', 'deliver', 'archive', 'reopen'];
export function basicRoomCommands(): typeof ROOM_COMMANDS {
  return ROOM_COMMANDS.filter((c) => BASIC_ROOM_WORDS.includes(c.word) && c.verb !== 'rename-seat');
}

/** A Basic typed command: who it goes to (the @-named seats, else the lead, else the
 *  only seat), or null when the word is a Basic room command. */
function basicTyped(t: string, seats: ParseSeat[], fam?: ParseFamily): ParseResult | null {
  const parts = t.slice(1).split(/\s+/).filter(Boolean);
  const word = (parts[0] ?? '').toLowerCase();
  if (!word) {
    return null;
  }
  const isRoomWord = word === 'rename' ? (parts[1] ?? '').toLowerCase() === 'room' : BASIC_ROOM_WORDS.includes(word);
  if (isRoomWord) {
    return null;
  }
  const to: string[] = [];
  for (const tok of parts.slice(1)) {
    const name = addressOf(tok);
    if (name === null) continue;
    const r = resolve(name, seats, fam);
    if (!('refusal' in r) && r.ok !== 'room' && !to.includes(r.ok.seatId)) {
      to.push(r.ok.seatId);
    }
  }
  if (!to.length) {
    const one = seats.find(isLead) ?? (seats.length === 1 ? seats[0] : undefined);
    if (!one) {
      return refused(`no agent in this room to send /${word} to`, null);
    }
    to.push(one.id);
  }
  return { type: 'typed', text: t, word, to };
}

/** What the parser is told beyond the seats (it never reads the db). */
export interface ParseOpts {
  /** THE USER's own @name (GET /api/rooms/me `handle`). It and the fixed alias
   *  `@user` both ADDRESS THE USER (Owner 2026-09-28: an agent's "@user ..."
   *  reply has to reach him), in the leading run AND as a mid-text mention:
   *  no seat recipient for that word, `toUser: true` on the result. A seat
   *  with the same handle wins (seats are what deliver; `user` is reserved
   *  and PATCH /api/rooms/me refuses a seat's name anyway). */
  userHandle?: string | null;
  /** The family's other rooms (see ParseFamily); absent = a room with none. */
  family?: ParseFamily;
  /** [address only] A line that names NOBODY goes to the lead (true, the default) or
   *  to no seat at all (false: written to the room, delivered to nobody).
   *  Settings -> Agent comms `unaddressedToLead`. */
  unaddressedToLead?: boolean;
  /** [basic] The Basic edition, for a line the USER typed: a leading `/word` that is
   *  not a Basic room command is a TYPED COMMAND for the room's agent (result
   *  `typed`), never refused or carried. Absent = the full edition's rules. */
  basic?: boolean;
}

const BACKTICK = '`';
/** The text with code removed (fenced blocks and inline `spans`) AND quoted
 *  text removed ("…" and “…”): an @name inside either is quoted, not addressed
 *  [address only; quotes: Owner [ref], toolkit [ref]]. The one choke point the
 *  parser, namesAnyone, the seat digest and the "to me" scan all read. */
export function withoutCode(text: string): string {
  const parts = text.split(BACKTICK.repeat(3));
  const prose = parts.filter((_, i) => i % 2 === 0).join(' ');
  const noCode = prose
    .split(BACKTICK)
    .filter((_, i) => i % 2 === 0)
    .join(' ');
  return withoutQuotes(noCode);
}

/* QUOTED TEXT (Owner [ref]): "…" and “…” are a quotation, not an address. The
 * page's matching copy (web/room.js quotedRanges) and test/fixtures/address-cases.json
 * keep the two in step.
 *   straight "  opens only at the start or after whitespace or an opening bracket
 *               (so 5" pipe is not a quote) and closes at the first " that is
 *               followed by the end, whitespace or closing punctuation;
 *   curly “…”   opens at “ and closes at the next ”;
 *   a span is at most QUOTE_MAX characters and never crosses a newline; an
 *   unmatched quote is left alone; apostrophes never count. */
export const QUOTE_MAX = 400;
const OPENERS = new Set([' ', String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13), '(', '[', '{']);
const CLOSERS = new Set([' ', String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13), '.', ',', ';', ':', '!', '?', ')', ']', '}']);
const STRAIGHT = String.fromCharCode(34);
const LEFT_CURLY = String.fromCharCode(0x201c);
const RIGHT_CURLY = String.fromCharCode(0x201d);
/** [start, end) of every quoted span, quotes included. */
export function quotedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    let close = -1;
    if (c === LEFT_CURLY) {
      for (let j = i + 1; j < n && j - i <= QUOTE_MAX && text[j] !== String.fromCharCode(10); j++) {
        if (text[j] === RIGHT_CURLY) {
          close = j;
          break;
        }
      }
    } else if (c === STRAIGHT && (i === 0 || OPENERS.has(text[i - 1]))) {
      for (let j = i + 1; j < n && j - i <= QUOTE_MAX && text[j] !== String.fromCharCode(10); j++) {
        if (text[j] === STRAIGHT && (j + 1 === n || CLOSERS.has(text[j + 1]))) {
          close = j;
          break;
        }
      }
    }
    if (close > i) {
      out.push([i, close + 1]);
      i = close + 1;
    } else {
      i++;
    }
  }
  return out;
}
/** The text with every quoted span replaced by one space. */
export function withoutQuotes(text: string): string {
  const spans = quotedRanges(text);
  if (!spans.length) {
    return text;
  }
  let out = '';
  let at = 0;
  for (const [a, b] of spans) {
    out += text.slice(at, a) + ' ';
    at = b;
  }
  return out + text.slice(at);
}

/** Same length as `text`, with code (fenced blocks, then inline spans, paired the
 *  way withoutCode reads them: an unmatched opener runs to the end) and quoted
 *  spans blanked to NUL. What is left is where an address can be. */
function protectedMask(text: string): string {
  const n = text.length;
  const NUL = String.fromCharCode(0);
  const prot = new Array<boolean>(n).fill(false);
  const fence = BACKTICK.repeat(3);
  const fences: number[] = [];
  for (let i = 0; i <= n - 3; ) {
    if (text.startsWith(fence, i)) {
      fences.push(i);
      i += 3;
    } else {
      i++;
    }
  }
  const mark = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      prot[k] = true;
    }
  };
  for (let k = 0; k < fences.length; k += 2) {
    mark(fences[k], k + 1 < fences.length ? fences[k + 1] + 3 : n);
  }
  let open = -1;
  for (let i = 0; i < n; i++) {
    if (prot[i] || text[i] !== BACKTICK) {
      continue;
    }
    if (open < 0) {
      open = i;
    } else {
      mark(open, i + 1);
      open = -1;
    }
  }
  if (open >= 0) {
    mark(open, n);
  }
  for (const [from, to] of quotedRanges(text)) {
    mark(from, to);
  }
  let out = '';
  for (let i = 0; i < n; i++) {
    out += prot[i] ? NUL : text[i];
  }
  return out;
}

/** THE USER'S REAL NAME ON AN AGENT'S LINE (Owner [ref], toolkit [ref]): every
 *  `@user` outside code and quotes becomes `@<handle>`, so a line copied to a
 *  room with another person does not conflate them. A no-op when the handle is
 *  absent or is `user` itself. The caller decides WHEN (an agent's line, a
 *  single-person room); this only rewrites. Case-insensitive; the handle is
 *  written as stored. */
export function convertUserAlias(text: string, handle: string | null | undefined): string {
  const h = (handle ?? '').trim();
  if (!h || h.toLowerCase() === USER_ALIAS || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(h)) {
    return text;
  }
  const mask = protectedMask(text);
  const re = /(?<![A-Za-z0-9_.@-])@user(?![A-Za-z0-9])(?!-[A-Za-z0-9])/gi;
  let out = '';
  let at = 0;
  for (const m of mask.matchAll(re)) {
    out += text.slice(at, m.index) + '@' + h;
    at = m.index + m[0].length;
  }
  return at === 0 ? text : out + text.slice(at);
}

/** The fixed alias for THE USER on the room line, whoever they are. */
export const USER_ALIAS = 'user';

/** Does the address word `name` (no `@`, lowercased) mean THE USER? The one
 *  rule every post path shares, for every author, human or agent. */
export function isUserAddress(name: string, seats: ParseSeat[], userHandle?: string | null): boolean {
  const me = userHandle ? userHandle.toLowerCase() : null;
  return (name === USER_ALIAS || (me !== null && name === me)) && !seats.some((s) => s.handle === name);
}

/**
 * HOW a chat line addressed by `text` is STORED (to-me, 2026-09-28): the
 * route's single answer, so the typed, bearer + `from`, pane-token and
 * attachment doors cannot disagree.
 *   - the leading run names a SEAT: target = the first seat word (resolved to
 *     its seat at write time, as always);
 *   - the leading run names ONLY the user: target = the user's handle (`user`
 *     normalised to it), `toUser` set so the store writes no seat;
 *   - no leading address: target null (= the lead, as always).
 * `toUserMeta` is the explicit `meta.to_user` flag: set whenever the line
 * addresses the user anywhere (leading or mid-text), including alongside
 * seats, so the page never has to infer it.
 */
export function chatAddress(
  text: string,
  p: { toUser?: true },
  seats: ParseSeat[],
  userHandle: string,
): { target: string | null; toUser: string | null; toUserMeta: boolean } {
  const words = (text ?? '').trim().split(/\s+/);
  let seatWord: string | null = null;
  let userLed = false;
  for (const w of words) {
    const name = addressOf(w);
    if (name === null) {
      break;
    }
    if (isUserAddress(name, seats, userHandle)) {
      userLed = true;
    } else if (seatWord === null) {
      seatWord = name;
    }
  }
  const toUserMeta = p.toUser === true;
  if (seatWord !== null) {
    return { target: seatWord, toUser: null, toUserMeta };
  }
  if (userLed) {
    return { target: userHandle, toUser: userHandle, toUserMeta: true };
  }
  return { target: null, toUser: null, toUserMeta };
}

/**
 * Decide what a line of text is. `seats` are the room's ACTIVE seats; the
 * lead carries `is_lead: true` (a store RoomSeat already does).
 */
export function parse(text: string, seats: ParseSeat[], opts: ParseOpts = {}): ParseResult {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) {
    return refused('nothing to send');
  }
  if (ALL_RE.test(t)) {
    return refused('@all is not in this build — cross-room addressing needs the fabric', 'use @room for everyone in this room');
  }
  if (t.startsWith('/')) {
    if (/^\/\?(\s|$)/.test(t)) {
      return room('help', null); // `/?` is /help, in every edition
    }
    if (opts.basic) {
      const typed = basicTyped(t, seats, opts.family);
      if (typed) {
        return typed;
      }
    }
    return parseCommand(t, seats, opts.family);
  }
  /* EVERY seat a line names gets it (Owner 2026-09-27: "@engine-seat
     @briefing-table ..." reached only the first). The LEADING run of @words is
     the address and is strict (an unknown handle refuses, as before); an
     @handle later in the text that names a seat (or @lead) is added, and any
     other @word there is just text. The user's own @name, or `@user`, anywhere
     in the line addresses the user (no seat, `toUser`) — Owner 2026-09-28.
     ONLY WHO IT NAMES [address only] (Owner 2026-10-07, room interface: a line
     that named the operator mid-text went to the lead AND the operator): the lead
     is added only when the line names NOBODY (no seat, not the user), and only
     while `unaddressedToLead` is on; off = delivered to no seat. An @name inside
     code (backticks) is quoted, not addressed; an email or URL never starts with @.
     One recipient keeps the single-id shape. */
  const words = t.split(/\s+/);
  const ids: string[] = [];
  const isMe = (name: string): boolean => isUserAddress(name, seats, opts.userHandle);
  let toUser = false;
  let i = 0;
  for (; i < words.length; i++) {
    const name = addressOf(words[i]);
    if (name === null) {
      break;
    }
    if (isMe(name)) {
      toUser = true;
      continue;
    }
    const r = resolve(name, seats, opts.family);
    if ('refusal' in r) {
      return r.refusal;
    }
    if (r.ok === 'room') {
      return { type: 'chat', to: 'room' };
    }
    ids.push(r.ok.seatId);
  }
  const rest = withoutCode(words.slice(i).join(' ')).split(/\s+/);
  for (const w of rest) {
    const name = addressOf(w.replace(/^[(\[{"']+/, ''));
    if (name === null || name === 'room') {
      continue;
    }
    if (isMe(name)) {
      toUser = true;
      continue;
    }
    const r = resolve(name, seats, opts.family);
    if (!('refusal' in r) && r.ok !== 'room') {
      ids.push(r.ok.seatId);
    }
  }
  let leadDefault = false;
  if (i === 0 && ids.length === 0 && !toUser && opts.unaddressedToLead !== false) {
    const lead = seats.find(isLead);
    if (!lead) {
      return noLead(seats);
    }
    ids.push(lead.id);
    leadDefault = true;
  }
  const to = [...new Set(ids)];
  return {
    type: 'chat',
    to: to.length === 1 ? to[0] : to,
    ...(toUser ? { toUser: true as const } : {}),
    ...(leadDefault ? { leadDefault: true as const } : {}),
  };
}

/** [passing ping] The seat ids a chat line names ONLY inside a sentence: not in the leading
 *  run of @words and not where an @ opens a sentence or line. Their copy says a reply is
 *  owed only if the sentence asks something of them. Pure; same word rules as parse(). */
export function namedInPassing(text: string, seats: ParseSeat[], opts: ParseOpts = {}): string[] {
  const words = (typeof text === 'string' ? text.trim() : '').split(/\s+/);
  let i = 0;
  const asked = new Set<string>();
  const idOf = (w: string): string | null => {
    const name = addressOf(w.replace(/^[(\[{"']+/, ''));
    if (name === null || name === 'room' || isUserAddress(name, seats, opts.userHandle)) {
      return null;
    }
    const r = resolve(name, seats, opts.family);
    return 'refusal' in r || r.ok === 'room' ? null : r.ok.seatId;
  };
  for (; i < words.length && addressOf(words[i]) !== null; i++) {
    const id = idOf(words[i]);
    if (id) {
      asked.add(id);
    }
  }
  const passing: string[] = [];
  let opens = true;
  for (const m of withoutCode(words.slice(i).join(' ')).matchAll(/(\S+)(\s*)/g)) {
    const id = idOf(m[1]);
    if (id) {
      (opens ? asked : { add: (x: string) => passing.push(x) }).add(id);
    }
    opens = /[.:;!?]$/.test(m[1]) || m[2].includes('\n');
  }
  return [...new Set(passing)].filter((id) => !asked.has(id));
}

/** Does `text` name anyone (a seat this room or its family can resolve, @room, @lead,
 *  an alias, or the user) ANYWHERE, outside code? [address only] */
export function namesAnyone(text: string, seats: ParseSeat[], opts: ParseOpts = {}): boolean {
  const p = parse(text, seats, { ...opts, unaddressedToLead: false });
  return p.type === 'chat' && (p.to === 'room' || p.toUser === true || (Array.isArray(p.to) ? p.to.length > 0 : true));
}
