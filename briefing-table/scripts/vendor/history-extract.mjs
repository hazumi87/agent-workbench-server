#!/usr/bin/env node
/** Basic switch history fallback [ticket/ticket]. Node built-ins only.
 * Read-only, bounded extraction from an exact session; never invokes a model.
 * Exported for portable tests; CLI prints one bounded JSON document.
 */
import { open, opendir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HEADER_BYTES = 256 * 1024;
const SCAN_BYTES = 2 * 1024 * 1024;
const RECORD_BYTES = 512 * 1024;
const MAX_ENTRIES = 20000;
const sha = value => createHash('sha256').update(value).digest('hex');
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = value => typeof value === 'string' ? value : '';
const bytes = value => Buffer.byteLength(value, 'utf8');
const inside = (root, path) => {
  const r = relative(root, path);
  return r === '' || (!r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && r !== '..' && !isAbsolute(r));
};
function cut(text, limit) {
  const b = Buffer.from(text);
  if (b.length <= limit) return text;
  let end = Math.max(0, limit - 3);
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString('utf8') + '…';
}

/** Best-effort redaction of common pasted secrets; not a universal secret detector.
 * Secret files, tool output, environment and reasoning blocks are never inputs.
 */
function clean(text) {
  return text.replace(/<(system-reminder|environment_context|system_instruction)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted key]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[redacted token]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [redacted]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
const ts = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const defaultRoot = vendor => join(homedir(), vendor === 'claude-code' ? '.claude/projects' : '.codex/sessions');
const warning = (out, name) => { if (!out.warnings.includes(name)) out.warnings.push(name); };

function initial(vendor, sessionId, cwd, maxBytes) {
  return { version: 1, source: { vendor, sessionId, cwd, path: null, recordsRead: 0,
    bytesRead: 0, firstTs: null, lastTs: null, truncated: false, nextCursor: null },
  lastRequest: null, messages: [], filesTouched: [], toolSummary: {}, unfinished: [],
  budget: { maxBytes, usedBytes: 0 }, warnings: [] };
}
function measure(out) {
  // usedBytes includes its own decimal representation and the trailing CLI newline.
  for (let i = 0; i < 5; i++) {
    const n = bytes(JSON.stringify(out)) + 1;
    if (out.budget.usedBytes === n) return n;
    out.budget.usedBytes = n;
  }
  return out.budget.usedBytes;
}
function fit(out) {
  if (measure(out) > out.budget.maxBytes) {
    warning(out, 'output-truncated'); out.source.truncated = true;
  }
  while (measure(out) > out.budget.maxBytes) {
    if (out.messages.length > 1) out.messages.shift();
    else if (out.filesTouched.length) out.filesTouched.pop();
    else if (out.unfinished.length) out.unfinished.shift();
    else if (Object.keys(out.toolSummary).length) delete out.toolSummary[Object.keys(out.toolSummary)[0]];
    else if (out.messages.length) out.messages.pop();
    else if (out.lastRequest && bytes(out.lastRequest) > 128) out.lastRequest = cut(out.lastRequest, Math.floor(bytes(out.lastRequest) / 2));
    else if (out.lastRequest) out.lastRequest = null;
    else if (out.source.path) out.source.path = null;
    else if (out.source.cwd) { out.source.cwd = null; warning(out, 'metadata-omitted'); }
    else if (out.source.nextCursor) out.source.nextCursor = null;
    else break;
  }
  measure(out);
  return out;
}

async function locate(root, vendor, sessionId, cwd, file) {
  const base = await realpath(root);
  if (file) {
    const path = await realpath(resolve(file));
    if (!inside(base, path)) throw new Error('path-outside-root');
    return path;
  }
  if (vendor === 'claude-code') {
    const path = await realpath(join(base, (cwd.replace(/[/\\]+$/, '') || cwd).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`));
    if (!inside(base, path)) throw new Error('path-outside-root');
    return path;
  }
  const found = []; let entries = 0;
  async function walk(dir, depth) {
    for await (const entry of await opendir(dir)) {
      if (++entries > MAX_ENTRIES) throw new Error('discovery-limit');
      if (entry.isDirectory() && depth < 4) await walk(join(dir, entry.name), depth + 1);
      else if (entry.isFile() && (entry.name === `${sessionId}.jsonl` || entry.name.endsWith(`-${sessionId}.jsonl`))) {
        found.push(join(dir, entry.name));
        if (found.length > 1) throw new Error('session-ambiguous');
      }
    }
  }
  await walk(base, 0);
  if (found.length !== 1) throw new Error('session-not-found');
  return found[0];
}

async function readRange(file, start, end) {
  const buf = Buffer.alloc(end - start); let n = 0;
  while (n < buf.length) {
    const r = await file.read(buf, n, buf.length - n, start + n);
    if (!r.bytesRead) break;
    n += r.bytesRead;
  }
  return buf.subarray(0, n);
}
function lines(buf, start, out) {
  const result = []; let from = 0;
  // A bounded tail may start inside a record. Never parse that fragment.
  if (start > 0) {
    const first = buf.indexOf(10);
    if (first < 0) return { records: [], boundary: start + buf.length };
    from = first + 1;
  }
  const boundary = start + from;
  for (;;) {
    const end = buf.indexOf(10, from);
    if (end < 0) {
      if (from < buf.length) warning(out, 'partial-record-skipped');
      break;
    }
    const raw = buf.subarray(from, end);
    if (raw.length > RECORD_BYTES) warning(out, 'oversized-record-skipped');
    else if (raw.length) {
      try { result.push({ data: JSON.parse(raw.toString('utf8')), offset: start + from, hash: sha(raw) }); }
      catch { warning(out, 'malformed-record-skipped'); }
    }
    from = end + 1;
  }
  return { records: result, boundary };
}

function contentText(content, types) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(b => obj(b) && types.includes(b.type)).map(b => str(b.text)).join('\n\n') : '';
}
function claudeLineage(records, leaf, out) {
  const main = records.filter(r => ['user', 'assistant'].includes(r.data?.type) && r.data.isSidechain !== true);
  const byId = new Map(main.filter(r => str(r.data.uuid)).map(r => [r.data.uuid, r]));
  let current = leaf ? byId.get(leaf) : main.at(-1);
  if (leaf && !current) { warning(out, 'lineage-outside-window'); return { rows: [], missing: leaf, linked: true }; }
  if (!current || !Object.hasOwn(current.data, 'parentUuid') || !str(current.data.uuid)) {
    warning(out, 'lineage-unavailable-append-order'); return { rows: main, linked: false };
  }
  const kept = [], seen = new Set(); let missing = null;
  while (current) {
    if (seen.has(current.data.uuid)) throw new Error('invalid-lineage');
    seen.add(current.data.uuid); kept.unshift(current);
    const parent = current.data.parentUuid;
    if (parent === null) break;
    if (typeof parent !== 'string' || !parent || parent.length > 128) throw new Error('invalid-lineage');
    current = byId.get(parent);
    if (!current) { missing = parent; warning(out, 'lineage-outside-window'); }
  }
  return { rows: kept, missing, linked: true };
}
function safePath(value, cwd) {
  if (!value || bytes(value) > 1024 || /[\r\n\0]/.test(value)) return null;
  const path = resolve(cwd, value);
  if (!inside(cwd, path) || /(?:^|[/\\])(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|[^/\\]*\.(?:pem|key))$/i.test(path)) return null;
  return relative(cwd, path) || null;
}

function normalize(records, vendor, cwd, transcriptId, out) {
  const messages = [], files = new Set(), openCalls = new Map();
  const counts = Object.create(null); let plan = null;
  const countCall = (id, name, input) => {
    if (!/^[\w.:-]{1,80}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) return;
    if (Object.hasOwn(counts, name) || Object.keys(counts).length < 40) counts[name] = (counts[name] ?? 0) + 1;
    if (id) {
      openCalls.set(id, name);
      if (openCalls.size > 1000) { openCalls.delete(openCalls.keys().next().value); warning(out, 'open-call-tracking-truncated'); }
    }
    let args = input;
    if (typeof input === 'string' && name !== 'apply_patch') {
      try { args = JSON.parse(input); } catch { args = null; }
    }
    const addPath = p => {
      const path = safePath(str(p), cwd);
      if (path) { files.delete(path); files.add(path); if (files.size > 30) files.delete(files.values().next().value); }
    };
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file'].includes(name) && obj(args)) {
      addPath(args.file_path ?? args.path ?? args.notebook_path);
    }
    if (name === 'apply_patch' && typeof input === 'string') {
      for (const m of input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) addPath(m[1]);
    }
    if (obj(args) && (name === 'update_plan' || name === 'TodoWrite')) {
      const steps = name === 'update_plan' ? args.plan : args.todos;
      if (Array.isArray(steps)) plan = { kind: 'plan', basis: 'last-observed-plan', steps: steps.slice(0, 8)
        .filter(s => obj(s) && ['pending', 'in_progress', 'completed'].includes(s.status))
        .map(s => ({ text: cut(clean(str(s.step ?? s.content)), 180), status: s.status })) };
    }
  };
  for (const r of records) {
    const d = r.data;
    if (!obj(d)) continue;
    let role, text = '', id = '', stamp = ts(d.timestamp);
    if (vendor === 'codex-cli') {
      if (d.type !== 'response_item' || !obj(d.payload)) continue;
      const p = d.payload; id = str(p.id);
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role) &&
          (p.phase === undefined || ['final', 'commentary'].includes(p.phase))) {
        role = p.role; text = contentText(p.content, ['input_text', 'output_text']);
      } else if (['function_call', 'custom_tool_call'].includes(p.type)) countCall(str(p.call_id), str(p.name), p.arguments ?? p.input);
      else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) openCalls.delete(str(p.call_id));
    } else {
      if (d.isSidechain === true || d.isMeta === true || d.isCompactSummary === true || d.isApiErrorMessage === true) continue;
      if (!['user', 'assistant'].includes(d.type)) continue;
      role = d.type; id = str(d.uuid); text = contentText(d.message?.content, ['text']);
      for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (b?.type === 'tool_use') countCall(str(b.id), str(b.name), b.input);
        if (b?.type === 'tool_result') openCalls.delete(str(b.tool_use_id));
      }
    }
    text = clean(text);
    if (!role || !text) continue;
    const clipped = cut(text, 1200);
    messages.push({ role, ts: stamp, text: clipped, ...(clipped !== text ? { truncated: true } : {}),
      history: { kind: 'transcript', transcriptId, recordId: id || `byte-offset:${r.offset}`, recordSha256: r.hash },
      offset: r.offset });
  }
  out.filesTouched = [...files]; out.toolSummary = { ...counts };
  out.unfinished = [...(plan ? [plan] : []), ...[...openCalls].slice(-8).map(([id, tool]) =>
    ({ kind: 'tool-outcome-unknown', tool, callId: cut(id, 160), basis: 'no-result-in-scanned-range' }))];
  if (files.size) warning(out, 'files-are-attempted-paths');
  if (openCalls.size) warning(out, 'tool-outcomes-not-running-state');
  return messages;
}

/** The engine must authorize the source session/project before invoking this script.
 * A root argument is a filesystem scope, not an authorization mechanism.
 */
export async function extractHistory(options) {
  const vendor = options.vendor, sessionId = options.session;
  const maxBytes = Number(options.maxBytes ?? 6000);
  if (!['claude-code', 'codex-cli'].includes(vendor) || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId ?? '') ||
      typeof options.cwd !== 'string' || !isAbsolute(options.cwd) || bytes(options.cwd) > 1024 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 65536) throw new Error('invalid-arguments');
  const cwd = resolve(options.cwd), out = initial(vendor, sessionId, cwd, maxBytes);
  let handle;
  try {
    const path = await locate(options.root ?? defaultRoot(vendor), vendor, sessionId, cwd, options.file);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('not-regular-file');
    const size = Number(before.size);
    const snapshot = sha(JSON.stringify([vendor, sessionId, cwd, path, String(before.dev), String(before.ino), String(before.size), String(before.mtimeNs)]));
    let end = size, leaf;
    if (options.page) {
      if (typeof options.page !== 'string' || options.page.length > 2048) throw new Error('invalid-cursor');
      let cursor;
      try { cursor = JSON.parse(Buffer.from(options.page, 'base64url').toString('utf8')); } catch { throw new Error('invalid-cursor'); }
      if (cursor?.version !== 1 || cursor.snapshot !== snapshot) throw new Error('cursor-stale');
      if (!Number.isSafeInteger(cursor.end) || cursor.end <= 0 || cursor.end > size) throw new Error('invalid-cursor');
      if (cursor.leaf !== undefined && (vendor !== 'claude-code' || typeof cursor.leaf !== 'string' || !cursor.leaf || cursor.leaf.length > 128)) throw new Error('invalid-cursor');
      end = cursor.end;
      leaf = cursor.leaf;
    }
    const start = Math.max(0, end - SCAN_BYTES);
    const tail = await readRange(handle, start, end);
    const head = start === 0 ? tail : await readRange(handle, 0, Math.min(size, HEADER_BYTES));
    out.source.path = path; out.source.bytesRead = tail.length + (head === tail ? 0 : head.length);
    const chunk = lines(tail, start, out);
    const headRows = head === tail ? chunk.records : lines(head, 0, out).records;
    const allRows = head === tail ? chunk.records : [...headRows, ...chunk.records];
    let identified = false;
    for (const { data: d } of allRows) {
      if (!obj(d)) continue;
      if (vendor === 'codex-cli' && d.type === 'session_meta') {
        if (d.payload?.id !== sessionId) throw new Error('session-mismatch');
        if (typeof d.payload?.cwd !== 'string' || resolve(d.payload.cwd) !== cwd) throw new Error('cwd-mismatch');
        identified = true;
      }
      if (vendor === 'codex-cli' && d.type === 'turn_context' && typeof d.payload?.cwd === 'string' && resolve(d.payload.cwd) !== cwd) throw new Error('cwd-mismatch');
      if (vendor === 'claude-code' && ['user', 'assistant'].includes(d.type) && d.isSidechain !== true) {
        if (d.sessionId !== sessionId) throw new Error('session-mismatch');
        if (typeof d.cwd !== 'string' || resolve(d.cwd) !== cwd) throw new Error('cwd-mismatch');
        identified = true;
      }
    }
    if (!identified) throw new Error('identity-unverified');
    out.source.recordsRead = chunk.records.length;
    const transcriptId = sha(JSON.stringify([vendor, sessionId, path, String(before.dev), String(before.ino)]));
    const lineage = vendor === 'claude-code' ? claudeLineage(chunk.records, leaf, out) : { rows: chunk.records, linked: false };
    const messages = normalize(lineage.rows, vendor, cwd, transcriptId, out);
    if (!messages.length) warning(out, 'no-conversation-in-scanned-range');
    // A contiguous suffix keeps pagination lossless for recognized messages.
    // The latest vendor user record is also carried separately if recent agent
    // chatter fills the suffix. It is not asserted to be the person's objective.
    const selected = []; let userCount = 0, assistantCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if ((m.role === 'user' && userCount === 4) || (m.role === 'assistant' && assistantCount === 2)) break;
      selected.unshift(m);
      if (m.role === 'user') userCount++; else assistantCount++;
    }
    const latestUser = messages.findLast(m => m.role === 'user');
    out.lastRequest = latestUser ? cut(latestUser.text, 1000) : null;
    if (out.lastRequest) warning(out, 'last-request-is-vendor-user-record');
    out.messages = selected.map(({ offset, ...message }) => message);
    out.source.firstTs = messages[0]?.ts ?? null;
    out.source.lastTs = messages.at(-1)?.ts ?? null;
    out.source.truncated = start > 0 || messages.length > selected.length || selected.some(m => m.truncated);
    if (out.source.truncated) warning(out, 'bounded-history-only');
    // Reserve cursor space before fitting; after fitting, adjust to the first kept record.
    const cursorFor = (n, parent) => n > 0 ? Buffer.from(JSON.stringify({ version: 1, snapshot, end: n,
      ...(parent ? { leaf: parent } : {}) })).toString('base64url') : null;
    // Reserve the longest numeric cursor before fitting; replacing it with an
    // actual smaller offset cannot cause another message to disappear from budget.
    out.source.nextCursor = cursorFor(Number.MAX_SAFE_INTEGER, vendor === 'claude-code' ? 'x'.repeat(128) : undefined);
    fit(out);
    const firstKept = out.messages[0];
    const earliest = firstKept ? selected.find(m => m.history.recordId === firstKept.history.recordId &&
      m.history.recordSha256 === firstKept.history.recordSha256)?.offset : undefined;
    const boundary = earliest ?? selected[0]?.offset ?? chunk.boundary;
    const parent = lineage.linked ? lineage.rows.find(r => r.offset === boundary)?.data.parentUuid ?? lineage.missing : undefined;
    out.source.nextCursor = out.source.nextCursor && (!lineage.linked || parent) ? cursorFor(boundary, parent) : null;
    // A window with no full records must still move backwards.
    if (out.source.nextCursor && boundary >= end) out.source.nextCursor = cursorFor(start, parent);
    if (selected.length && !out.messages.length) {
      out.source.nextCursor = null; warning(out, 'budget-too-small-for-messages');
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw new Error('source-changed');
    return fit(out);
  } catch (error) {
    const known = ['path-outside-root', 'discovery-limit', 'session-ambiguous', 'session-not-found',
      'not-regular-file', 'invalid-cursor', 'cursor-stale', 'session-mismatch', 'cwd-mismatch',
      'identity-unverified', 'source-changed', 'invalid-lineage'];
    const code = error?.code === 'ENOENT' ? 'session-not-found' : known.includes(error?.message) ? error.message : 'source-unavailable';
    const empty = initial(vendor, sessionId, cwd, maxBytes); warning(empty, code);
    return fit(empty);
  } finally { if (handle) await handle.close(); }
}

async function main(argv) {
  const options = {}, names = { '--vendor': 'vendor', '--session': 'session', '--cwd': 'cwd',
    '--root': 'root', '--file': 'file', '--max-bytes': 'maxBytes', '--page': 'page' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]];
    if (!key || argv[i + 1] === undefined || Object.hasOwn(options, key)) throw new Error('invalid-arguments');
    options[key] = argv[i + 1];
  }
  process.stdout.write(JSON.stringify(await extractHistory(options)) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write(JSON.stringify({ version: 1, error: 'invalid-arguments' }) + '\n');
    process.exitCode = 2;
  });
}
