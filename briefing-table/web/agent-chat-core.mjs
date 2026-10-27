/* AGENT CHAT, the pure rules [agent chat] Owner 2026-10-05: which vendors get the
 * Chat | CLI tabs, which view a pane opens on, the pending-bubble labels, the
 * tool-burst line, fenced-code splitting, the Enter setting. No DOM, no
 * absolute imports, so tests load it in node; agent-chat.mjs is the view. */
import { heldWord } from './held-words.mjs';

/* ---- which vendors get the tabs, and which view a pane opens on ---- */
export const AGENT_VENDORS = ['claude-code', 'codex-cli', 'gemini-cli'];
export const hasChatTabs = (vendor) => AGENT_VENDORS.includes(vendor);
export const viewKey = (paneid) => `hwb.chatView.${paneid}`;

/** The remembered view for a pane, or null. Storage can throw (private window). */
export function readView(paneid, storage) {
  try {
    const v = storage.getItem(viewKey(paneid));
    return v === 'chat' || v === 'cli' ? v : null;
  } catch {
    return null;
  }
}
export function writeView(paneid, view, storage) {
  try {
    storage.setItem(viewKey(paneid), view);
  } catch {
    /* the choice just is not remembered */
  }
}

/** The view a pane opens on: shells have no Chat; a remembered choice wins; else Chat when readable. */
export function pickView({ vendor, supported, saved }) {
  if (!hasChatTabs(vendor)) {
    return 'cli';
  }
  if (saved) {
    return saved;
  }
  return supported === false ? 'cli' : 'chat';
}

/* ---- the pending bubble ---- */
/** What a just-sent message says about itself until the transcript echoes it. */
export function pendingLabel(state, held) {
  if (state === 'typed') {
    return 'sent';
  }
  if (state === 'held') {
    return held?.reason === 'draft' ? 'held: draft in the CLI' : `held: ${heldWord(held || {})}`;
  }
  if (state === 'queued') {
    return 'queued';
  }
  if (state === 'sending') {
    return 'sending';
  }
  return state || '';
}

const KEY_LEN = 40;
/** Does this transcript item echo that pending send? (the engine adds an "Attached:" line to the text) */
export function echoes(item, pending) {
  if (item.role !== 'user') {
    return false;
  }
  const want = pending.text.trim().slice(0, KEY_LEN);
  if (!want) {
    return (item.files?.length ?? 0) > 0 || item.text.includes('Attached:');
  }
  return item.text.includes(want);
}

/* ---- who typed it [chat sender] (Owner 2026-10-06: agents' messages showed under his name) ----
 * A pane with no message channel (Codex) is DELIVERED to by typing, so its transcript files
 * fabric DMs and room lines as user turns. The engine's own prefixes say who really sent them
 * (room-typer.ts frameFabric / frame): `[fabric · @<from> · <kind> …] body` and
 * `[room <name> · @<author> · #<id>] body`. Parsed with indexOf, no regex. */
const SEP = ' · ';
/** {via:'fabric'|'room', from, kind?, room?, body} for an engine-typed turn, else null. */
export function typedSource(text) {
  const s = String(text ?? '');
  const end = s.indexOf(']');
  if (end < 0) {
    return null;
  }
  const body = s.slice(end + 1).trimStart();
  if (s.startsWith('[fabric' + SEP + '@')) {
    const parts = s.slice(1, end).split(SEP);
    const from = (parts[1] || '').slice(1);
    return from ? { via: 'fabric', from, kind: parts[2] || '', body } : null;
  }
  if (s.startsWith('[room ')) {
    const inner = s.slice(6, end);
    const at = inner.lastIndexOf(SEP + '@');
    if (at < 0) {
      return null;
    }
    /* [reply route] the frame may end in ` · #<line id>` (room-typer frame) */
    let from = inner.slice(at + SEP.length + 1);
    const hash = from.indexOf(SEP + '#');
    if (hash >= 0) {
      from = from.slice(0, hash);
    }
    return from ? { via: 'room', from, room: inner.slice(0, at), body } : null;
  }
  return null;
}
/** A typed turn from someone other than the person (a room line by @user is still theirs). */
export function fromPeer(item) {
  if (item.role !== 'user') {
    return null;
  }
  const src = typedSource(item.text);
  return src && !(src.via === 'room' && src.from === 'user') ? src : null;
}

/* ---- rows ---- */
const TIMES = String.fromCharCode(215);
/** "Ran 3 tools: Bash, Read x2" from a tool row's tools list (order of first use). */
export function toolLine(item) {
  const tools = item.tools || [];
  if (!tools.length) {
    return item.text || 'Ran a tool';
  }
  const counts = new Map();
  for (const t of tools) {
    counts.set(t.name, (counts.get(t.name) || 0) + 1);
  }
  const names = [...counts].map(([n, c]) => (c > 1 ? `${n} ${TIMES}${c}` : n));
  return `Ran ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${names.join(', ')}`;
}

/** Text split into prose and fenced code runs: [{code:boolean, text}]. */
export function splitFences(text) {
  const fence = '`'.repeat(3);
  const parts = String(text ?? '').split(fence);
  const out = [];
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const nl = p.indexOf('\n');
      const body = nl >= 0 && /^[A-Za-z0-9_+-]*$/.test(p.slice(0, nl).trim()) ? p.slice(nl + 1) : p;
      out.push({ code: true, text: body.replace(/\n$/, '') });
    } else {
      /* the newline that closes/opens a fence is the fence's, not a blank line of prose */
      let t = p;
      if (i > 0 && t.startsWith('\n')) {
        t = t.slice(1);
      }
      if (i < parts.length - 1 && t.endsWith('\n')) {
        t = t.slice(0, -1);
      }
      if (t) {
        out.push({ code: false, text: t });
      }
    }
  });
  return out;
}


