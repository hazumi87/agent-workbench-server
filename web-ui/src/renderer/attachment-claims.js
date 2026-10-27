// Item 13, R1.1 (the design notes revision 1): which attachment tool takes which file. Pure. An ES module:
// the web page's module host picks the tool that opens a picture with it, and the web build checks claims with it.
// One claims grammar (a manifest-plan amendment): set, name and type claims with exact keys, {stem} the only token,
// literal basename characters only. The matcher: names NFC-normalised and compared case-insensitively in ASCII;
// rungs set, then name, then type, then the built-in handler; sets larger first, then the tools' list order,
// then claim index; files in attachment order, each consumed once. the design notes §15.3, §15.10.
// test/attachment-claims.test.mjs.

const MAX_CLAIMS = 8;
const MAX_SET = 8;
const MAX_LEN = 80;
const MAX_STEM = 64;
const LITERAL = /^[A-Za-z0-9._ -]*$/;
const MIME = /^[a-z]+\/([a-z0-9.+-]+|\*)$/;
const TOKEN = '{stem}';

const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && (Object.getPrototypeOf(o) === null || Object.getPrototypeOf(Object.getPrototypeOf(o)) === null);
const exactKeys = (o, keys) => isPlain(o) && Object.keys(o).length === keys.length && keys.every((k) => k in o);
/** NFC, and ASCII letters lowercased (the file systems that matter are case-insensitive in ASCII). */
const norm = (s) => String(s).normalize('NFC').replace(/[A-Z]/g, (c) => c.toLowerCase());

/** One literal around a single token: no separators, no dot start, no '..', basename characters only. */
function literalOk(text, token) {
  if (typeof text !== 'string' || !text || text.length > MAX_LEN) return false;
  const i = text.indexOf(token);
  if (i < 0 || text.indexOf(token, i + 1) >= 0) return false;
  const rest = text.slice(0, i) + text.slice(i + token.length);
  return LITERAL.test(rest) && !text.startsWith('.') && !text.includes('..');
}

/** A tool's `claims`. → {ok:true} | {ok:false, reason}. */
function checkClaims(claims) {
  if (!Array.isArray(claims) || claims.length < 1 || claims.length > MAX_CLAIMS) return { ok: false, reason: 'claims must list 1 to 8 claims' };
  for (const c of claims) {
    if (!isPlain(c)) return { ok: false, reason: 'a claim is an object' };
    if (c.kind === 'set') {
      if (!exactKeys(c, ['kind', 'names'])) return { ok: false, reason: 'a set claim has exactly kind and names' };
      if (!Array.isArray(c.names) || c.names.length < 2 || c.names.length > MAX_SET) return { ok: false, reason: 'a set names 2 to 8 files' };
      if (!c.names.every((n) => literalOk(n, TOKEN))) return { ok: false, reason: 'each set name has one {stem} and basename characters only' };
      if (new Set(c.names.map(norm)).size !== c.names.length) return { ok: false, reason: 'a set names each file once' };
    } else if (c.kind === 'name') {
      if (!exactKeys(c, ['kind', 'pattern'])) return { ok: false, reason: 'a name claim has exactly kind and pattern' };
      if (!literalOk(c.pattern, '*')) return { ok: false, reason: 'a name pattern has one * and basename characters only' };
    } else if (c.kind === 'type') {
      if (!exactKeys(c, ['kind', 'accepts'])) return { ok: false, reason: 'a type claim has exactly kind and accepts' };
      const a = c.accepts;
      if (!Array.isArray(a) || a.length < 1 || a.length > 16 || new Set(a).size !== a.length || !a.every((x) => typeof x === 'string' && MIME.test(x))) {
        return { ok: false, reason: 'accepts lists 1 to 16 MIME types or families, each once' };
      }
    } else {
      return { ok: false, reason: 'a claim kind is set, name or type' };
    }
  }
  return { ok: true };
}

const split = (n, token) => {
  const s = norm(n);
  const i = s.indexOf(token === TOKEN ? TOKEN : '*');
  return { pre: s.slice(0, i), suf: s.slice(i + token.length) };
};
/** The stem a file name gives for one set name, or null. */
function stemOf(fileName, setName) {
  const { pre, suf } = split(setName, TOKEN);
  const n = norm(fileName);
  if (n.length <= pre.length + suf.length || !n.startsWith(pre) || !n.endsWith(suf)) return null;
  const stem = n.slice(pre.length, n.length - suf.length);
  return stem.length >= 1 && stem.length <= MAX_STEM ? stem : null;
}
function nameMatches(fileName, pattern) {
  const { pre, suf } = split(pattern, '*');
  const n = norm(fileName);
  return n.length > pre.length + suf.length && n.startsWith(pre) && n.endsWith(suf);
}
function typeMatches(fileType, accepts) {
  const t = typeof fileType === 'string' ? fileType.toLowerCase() : '';
  if (!t) return false;
  return accepts.some((a) => (a.endsWith('/*') ? t.startsWith(a.slice(0, -1)) : t === a));
}

/**
 * files: [{id, name, type}] in attachment order; tools: [{id, claims}] in the "Attachment tools" list order,
 * enabled tools only. → {assignments: [{fileId, tool|null, rung, set|null}] in file order, sets: [{tool, stem, files}]}.
 */
function match(files, tools) {
  const taken = new Map(); // file index → {tool, rung, set}
  const sets = [];
  const setClaims = [];
  tools.forEach((t, ti) => (t.claims || []).forEach((c, ci) => { if (c.kind === 'set') setClaims.push({ t, ti, ci, c }); }));
  setClaims.sort((a, b) => b.c.names.length - a.c.names.length || a.ti - b.ti || a.ci - b.ci);
  for (const { t, c } of setClaims) {
    // the stems this claim could form, in the order the files first show them
    const stems = [];
    files.forEach((file, fi) => {
      if (taken.has(fi)) return;
      for (const n of c.names) {
        const s = stemOf(file.name, n);
        if (s !== null && !stems.includes(s)) stems.push(s);
      }
    });
    for (const stem of stems) {
      for (;;) {
        const picked = [];
        for (const n of c.names) {
          const want = split(n, TOKEN);
          const fi = files.findIndex((file, k) => !taken.has(k) && !picked.includes(k) && norm(file.name) === want.pre + stem + want.suf);
          if (fi < 0) break;
          picked.push(fi);
        }
        if (picked.length !== c.names.length) break;
        const setIndex = sets.length;
        sets.push({ tool: t.id, stem, files: picked.map((k) => files[k].id) });
        for (const k of picked) taken.set(k, { tool: t.id, rung: 'set', set: setIndex });
      }
    }
  }
  const byRung = (kind) => {
    const out = [];
    tools.forEach((t, ti) => (t.claims || []).forEach((c, ci) => { if (c.kind === kind) out.push({ t, ti, ci, c }); }));
    return out.sort((a, b) => a.ti - b.ti || a.ci - b.ci);
  };
  const names = byRung('name');
  const types = byRung('type');
  files.forEach((file, fi) => {
    if (taken.has(fi)) return;
    const n = names.find(({ c }) => nameMatches(file.name, c.pattern));
    if (n) { taken.set(fi, { tool: n.t.id, rung: 'name', set: null }); return; }
    const ty = types.find(({ c }) => typeMatches(file.type, c.accepts));
    if (ty) { taken.set(fi, { tool: ty.t.id, rung: 'type', set: null }); return; }
    taken.set(fi, { tool: null, rung: 'builtin', set: null });
  });
  return { assignments: files.map((file, fi) => ({ fileId: file.id, ...taken.get(fi) })), sets };
}

/** "Open with…" for one file: every tool with a claim that takes it, in list order, then the built-in handler. */
function openWith(file, tools) {
  const out = [];
  for (const t of tools) {
    const takes = (t.claims || []).some((c) => (c.kind === 'set' ? c.names.some((n) => stemOf(file.name, n) !== null)
      : c.kind === 'name' ? nameMatches(file.name, c.pattern) : c.kind === 'type' ? typeMatches(file.type, c.accepts) : false));
    if (takes) out.push(t.id);
  }
  out.push('builtin');
  return out;
}

export { checkClaims, match, openWith, MAX_CLAIMS };
