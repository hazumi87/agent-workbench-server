/**
 * BASIC EDITION: the edition switch and the AGENT COMMAND registry [basic] (Owner
 * 2026-10-08, room interface; blueprint KB design-notes-id "Learning commands",
 * "confirmation rule" and the v1 command table; platform's KB design-notes-id).
 *
 * EDITION: HARBOR_WB_EDITION = 'basic' | anything else ('full', the default). Same
 * engine code; the edition is an instance setting (reported on /health).
 *
 * AGENT COMMANDS are the hosted user's skills (/publish, /save, /undo ...). The
 * engine never runs them: in a Basic room or agent chat a typed `/word` that is not
 * a room command goes to the room's agent VERBATIM, as a message from the user, with
 * ONE marker appended (TYPED_MARKER_*). The skill branches on the marker: typed =
 * explain what will change and ask "Is that what you want?" before acting; the same
 * request in plain words = just do it. The registry only feeds /help, /? and
 * GET /api/commands, and picks which marker a word gets.
 *
 * WHERE THE LIST COMES FROM: HARBOR_WB_COMMANDS_FILE, else <data dir>/commands.json,
 * else the built-in v1 list below. File shape: [{name, explain, confirm, always?}]
 * (or {commands: [...]}); `name` with or without the leading slash. A file that
 * cannot be read or parsed falls back to the built-in list (never an outage).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { instancePath } from './data-dir.ts';

export type Edition = 'basic' | 'full';
export function edition(): Edition {
  return process.env.HARBOR_WB_EDITION === 'basic' ? 'basic' : 'full';
}
export const isBasic = (): boolean => edition() === 'basic';

export interface AgentCommand {
  /** Without the slash, lowercase: `publish`. */
  name: string;
  /** One plain line: what the user is asking the agent to do. */
  explain: string;
  /** When TYPED, the agent explains and asks before acting. */
  confirm: boolean;
  /** Always asks, typed or not (it throws work away). */
  always?: boolean;
}

/* THE MARKER (agreed string; the design notes). The stable prefix is what a
   skill matches; the rest tells the agent what to do in the same words. */
export const TYPED_MARKER_PREFIX = '(typed command:';
export const TYPED_MARKER_CONFIRM = '(typed command: explain what this does and ask before acting)';
export const TYPED_MARKER_PLAIN = '(typed command: explain what this does, then do it)';

/** The marker for a typed `/word`: an unknown word gets the asking one (the safe side). */
export function typedMarker(word: string, cmds: readonly AgentCommand[] = agentCommands()): string {
  const c = cmds.find((x) => x.name === word.toLowerCase());
  return c && !c.confirm && !c.always ? TYPED_MARKER_PLAIN : TYPED_MARKER_CONFIRM;
}

/** The leading `/word` of a line (lowercase, no slash), or null. `/?` is `?`. */
export function slashWord(text: string): string | null {
  const t = (text ?? '').trim();
  if (!t.startsWith('/')) return null;
  const w = t.slice(1).split(/\s+/)[0] ?? '';
  return w ? w.toLowerCase() : null;
}

/* The v1 table (blueprint design-notes-id, addendum "consolidated command set").
   /help and /? are the ROOM's (they list this); /try /keep /drop are later. */
export const DEFAULT_AGENT_COMMANDS: readonly AgentCommand[] = [
  { name: 'commands', explain: "You're asking the agent for the glossary: every command and what it asks the agent to do.", confirm: false },
  { name: 'preview', explain: "You're asking the agent for the private preview link (only you can open it).", confirm: false },
  { name: 'status', explain: "You're asking what is public right now and what changed since the last save.", confirm: false },
  { name: 'changes', explain: "You're asking what is different since the last save (a diff).", confirm: false },
  { name: 'save', explain: "You're asking the agent to save a version with a short note (a commit).", confirm: false },
  { name: 'history', explain: "You're asking for the list of saved versions (the log).", confirm: false },
  { name: 'undo', explain: "You're asking the agent to throw away the changes you have NOT saved (restore).", confirm: true, always: true },
  { name: 'revert', explain: "You're asking to go back to an earlier saved version, as a new save; nothing is lost (revert).", confirm: true },
  { name: 'publish', explain: "You're asking the agent to make the current version public, visible to anyone you give the link (snapshot + tag).", confirm: true },
  { name: 'unpublish', explain: "You're asking the agent to take the public copy down; the public link stops working.", confirm: true },
  { name: 'newlink', explain: "You're asking for a new public address; every old link stops working.", confirm: true },
  { name: 'restore-public', explain: "You're asking to put your working files back to exactly what is public now.", confirm: true, always: true },
  { name: 'screenshot', explain: "You're asking the agent to take a picture of the preview and show it (it checks its own work too).", confirm: false },
  { name: 'explain', explain: "You're asking for a plain-words explanation of a file, a change or the site.", confirm: false },
  { name: 'add', explain: "You're asking the agent to add a library or file the shared way (no duplicate per project).", confirm: true },
  { name: 'newsite', explain: "You're asking for a new project: its own folder, preview and room (same as the New site button).", confirm: true },
  { name: 'rename', explain: "You're asking to rename the project; its folder and links stay the same.", confirm: true },
  { name: 'export', explain: "You're asking for a zip of the project to download.", confirm: false },
  { name: 'skill', explain: "You're asking the agent to write a new skill: teach it a new trick.", confirm: true },
];

function normalise(raw: unknown): AgentCommand[] | null {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as any).commands) ? (raw as any).commands : null;
  if (!list) return null;
  const out: AgentCommand[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim().replace(/^\//, '').toLowerCase() : '';
    const explain = typeof c.explain === 'string' ? c.explain.trim() : '';
    if (!/^[a-z0-9?][a-z0-9-]{0,39}$/.test(name) || !explain || out.some((x) => x.name === name)) continue;
    out.push({ name, explain, confirm: c.confirm !== false, ...(c.always === true ? { always: true } : {}) });
  }
  return out.length ? out : null;
}

let cache: { path: string; mtime: number; size: number; list: AgentCommand[] } | null = null;

/** Where the registry file is (null = none: the built-in list). */
export function commandsFile(): string | null {
  const env = process.env.HARBOR_WB_COMMANDS_FILE;
  if (env) return env;
  const p = instancePath('commands.json');
  return existsSync(p) ? p : null;
}

/** The live registry (re-read when the file changes; built-in list on any failure). */
export function agentCommands(): AgentCommand[] {
  const p = commandsFile();
  if (!p) return [...DEFAULT_AGENT_COMMANDS];
  try {
    const st = statSync(p);
    if (cache && cache.path === p && cache.mtime === st.mtimeMs && cache.size === st.size) return [...cache.list];
    cache = null;
    const list = normalise(JSON.parse(readFileSync(p, 'utf8'))) ?? [...DEFAULT_AGENT_COMMANDS];
    cache = { path: p, mtime: st.mtimeMs, size: st.size, list };
    return [...list];
  } catch {
    return [...DEFAULT_AGENT_COMMANDS];
  }
}
