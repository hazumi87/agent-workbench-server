/* ============================================================================
 * THE CONCIERGE'S NAME IN DICTATION (conversation test page). Page-owned and
 * pure: no DOM, no fetch. Contract: the design notes (Owner,
 * room interface [ref]/[ref]).
 *
 *  - every whole-word spoken display name becomes "@<handle>", anywhere in the
 *    text ("ask Olivia to proof read this" -> "ask @olivia to proof read
 *    this"); "Olivia's" and "Olivian" are not matches; "at olivia" (the handle
 *    said aloud) is one too
 *  - a send phrase is a COMMAND, never content, and may carry the name:
 *    "send that", "Olivia, send it", "ok Olivia this is ready to send" are all
 *    stripped whole and send the draft
 *  - "Olivia, can you proof read this draft?" is CONTENT: it stays in the draft
 *    as "@olivia, can you ...?" and does NOT send (Owner [ref]: a proofread cue
 *    is a later "draft becomes a note" mode; the name is a cue the Concierge
 *    judges, not a command). Only a send phrase sends.
 *  - no handle = no substitution, no name-aware commands
 *  - only the Concierge's name: seat names are never touched
 *
 * The turn module (voice-test-turns.mjs, the voice service's, vendored) still decides the
 * timing (ok / prompt / yes-no). It lowercases and strips punctuation, so the
 * page keeps its own readable draft and uses this module for what it says.
 * ========================================================================== */

/* same normalisation as the turn module, so a phrase that hits there hits here */
const PUNCT = /[^\p{L}\p{N}' ]+/gu;
const CURLY = new RegExp(String.fromCharCode(0x2019), 'g'); // a typographic apostrophe
const TRAIL = new RegExp('[' + String.fromCharCode(92) + 's,;:' + String.fromCharCode(0x2014) + '-]+$', 'u'); // dangling separators
export function normalize(text) {
  return String(text || '').replace(CURLY, "'").toLowerCase().replace(PUNCT, ' ').replace(/\s+/g, ' ').trim();
}

/** Words that may lead an address: "hey Olivia", "ok Olivia, ...". */
export const ADDRESS_LEADS = ['hey', 'ok', 'okay', 'alright', 'so', 'and'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => String.fromCharCode(92) + c);

/** The rule for a {displayName, handle} pair, or null when there is nothing to
 *  substitute (no handle, or no name to listen for). */
export function nameRule(pair) {
  const handle = String(pair?.handle ?? '').trim().replace(/^@+/, '').toLowerCase();
  const display = String(pair?.displayName ?? '').trim();
  if (!handle || !/^[a-z][a-z0-9_-]{1,31}$/.test(handle)) {
    return null;
  }
  const names = [];
  const dn = normalize(display);
  if (dn) {
    names.push(dn.split(' '));
  }
  return { displayName: display, handle, nameWords: names, handleWords: normalize(handle).split(' ') };
}

/* a name boundary: not a letter, digit or apostrophe on either side
   ("Olivia's" and "Olivian" are not her) */
const B_BEFORE = "(^|[^\\p{L}\\p{N}'\\u2019@])";
const B_AFTER = "(?![\\p{L}\\p{N}'\\u2019])";

/** The text with every whole-word display name (and "at <handle>") as "@<handle>". */
export function substitute(text, rule) {
  let out = String(text ?? '');
  if (!rule) {
    return out;
  }
  const at = '@' + rule.handle;
  /* "at olivia" / "@olivia" first, so "at Olivia" is not left as "at @olivia" */
  const hw = rule.handleWords.map(esc).join('[\\s-]+');
  out = out.replace(new RegExp(`${B_BEFORE}(?:at\\s+|@)${hw}${B_AFTER}`, 'giu'), (_m, pre) => pre + at);
  for (const words of rule.nameWords) {
    const nw = words.map(esc).join('\\s+');
    out = out.replace(new RegExp(`${B_BEFORE}@?${nw}${B_AFTER}`, 'giu'), (_m, pre) => pre + at);
  }
  return out;
}

/* ---- token view: the raw words with their normalised forms, so a phrase can be
   matched on normalised words and cut from the raw text ---- */
function tokens(raw) {
  const toks = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  const flat = []; // {w, tok}
  toks.forEach((t, i) => {
    for (const w of normalize(t).split(' ').filter(Boolean)) {
      flat.push({ w, tok: i });
    }
  });
  return { toks, flat };
}
const isName = (flat, at, rule) => {
  /* how many words at flat[at] are the Concierge's name ("olivia", "at olivia",
     the handle), or 0 */
  if (!rule) {
    return 0;
  }
  const seqs = [...rule.nameWords, ['at', ...rule.handleWords], rule.handleWords];
  for (const s of seqs.sort((a, b) => b.length - a.length)) {
    if (s.length && s.every((w, k) => flat[at + k]?.w === w)) {
      return s.length;
    }
  }
  return 0;
};

/**
 * Does `raw` end with a send command? -> {hit:false} | {hit:true, content, phrase}
 * `content` is the raw text before the command (may be ''), with any address
 * that belongs to the command ("ok Olivia", "Olivia,") removed too.
 */
export function parseSend(raw, { sendPhrases = [], rule = null } = {}) {
  const { toks, flat } = tokens(raw);
  if (!flat.length) {
    return { hit: false };
  }
  const phrases = [...new Set(sendPhrases.map(normalize).filter(Boolean))].map((p) => p.split(' ')).sort((a, b) => b.length - a.length);
  let cut = -1;
  let phrase = '';
  for (const p of phrases) {
    const at = flat.length - p.length;
    if (at >= 0 && p.every((w, k) => flat[at + k].w === w)) {
      cut = at;
      phrase = p.join(' ');
      break;
    }
  }
  if (cut < 0) {
    return { hit: false };
  }
  /* the address that leads the command: "[ok|hey] Olivia [please]" just before it */
  let start = cut;
  if (flat[start - 1]?.w === 'please') {
    start--;
  }
  for (let n = 4; n >= 1; n--) {
    if (start - n >= 0 && isName(flat, start - n, rule) === n) {
      start -= n;
      break;
    }
  }
  while (start > 0 && ADDRESS_LEADS.includes(flat[start - 1].w)) {
    start--; // "ok, send that" / "and send it": the lead belongs to the command
  }
  const firstTok = start < flat.length ? flat[start].tok : toks.length;
  const content = toks.slice(0, firstTok).join(' ').replace(TRAIL, '').trim();
  return { hit: true, content, phrase };
}

/** One utterance into the draft. -> {
 *    text: the substituted content to add to the draft ('' = nothing),
 *    send: true when it ended with a send command,
 *    substituted: true when the name was turned into the @handle }  */
export function readUtterance(raw, { sendPhrases = [], rule = null } = {}) {
  const s = parseSend(raw, { sendPhrases, rule });
  const body = s.hit ? s.content : String(raw ?? '').trim();
  const text = substitute(body, rule);
  return { text, send: s.hit, substituted: text !== body };
}
