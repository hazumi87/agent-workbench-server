/**
 * WHERE THE PACKET'S FACTS COME FROM (ticket): the I/O half of the context packet. Every source is LOCAL to the
 * instance (room lines + notes from the table, git from the project folder, the previous session's transcript through
 * the vendored read-only extractor); nothing needs Fabric, NATS, the KB, or the outgoing model. Every source can fail
 * on its own and the packet still builds (the missing part is said to be unknown).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { table } from '../../table/endpoint.ts';
import type { HistoryExtract, PacketInput } from './packet.ts';

const STALE_NOTE_MS = 7 * 24 * 3600_000;

export function gatherRoomLines(roomId: string, opts: { limit?: number; beforeId?: number | null } = {}): PacketInput['roomLines'] {
  const rows = table.listLine(roomId, { kind: ['chat', 'attachment'], limit: opts.limit ?? 60, before: opts.beforeId ?? null });
  return rows
    .filter((r) => typeof r.body === 'string' && r.body.trim())
    .map((r) => {
      let replyTo: number | null = null;
      try {
        const m = r.meta ? JSON.parse(r.meta) : null;
        replyTo = Number.isInteger(m?.reply?.id) ? m.reply.id : null;
      } catch {
        /* meta is opaque */
      }
      return { id: r.id, author: r.author, ts: r.ts, replyTo, text: r.body as string };
    });
}

export function gatherNotes(roomId: string, now: number): PacketInput['notes'] {
  try {
    return table.listRoomNotesVisible(roomId, now).map((n) => ({ title: null, ts: n.updated_at, text: n.text, stale: now - n.updated_at > STALE_NOTE_MS }));
  } catch {
    return [];
  }
}

type Exec = (file: string, args: string[], opts: { timeout: number; cwd?: string }) => Promise<string>;
const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => execFile(file, args, { ...opts, maxBuffer: 1 << 20 }, (e, out) => (e ? reject(e) : resolve(String(out)))));

/** Git state by NAMES only: head, branch, changed paths. No diff, no contents, never a write. */
export async function gatherGit(dir: string, exec: Exec = defaultExec): Promise<PacketInput['git']> {
  try {
    const run = (args: string[]) => exec('git', ['-C', dir, ...args], { timeout: 4000 });
    const [head, branch, status] = await Promise.all([run(['rev-parse', '--short', 'HEAD']), run(['rev-parse', '--abbrev-ref', 'HEAD']), run(['status', '--porcelain', '--untracked-files=normal'])]);
    const dirty = status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 200);
    return { head: head.trim() || null, branch: branch.trim() === 'HEAD' ? null : branch.trim() || null, dirty };
  } catch {
    return null;
  }
}

/* ---- the vendored extractor (connector's dependency-free script; docs: switch history-extract schema v1) ---- */
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** Strict reduction of untrusted extractor output to the HistoryExtract shape. Null = refuse. */
export function validateExtract(j: unknown): HistoryExtract | null {
  if (!isObj(j) || j.version !== 1 || !isObj(j.source)) {
    return null;
  }
  const s = j.source;
  if (typeof s.vendor !== 'string' || typeof s.sessionId !== 'string' || typeof s.cwd !== 'string') {
    return null;
  }
  const messages = Array.isArray(j.messages)
    ? j.messages.filter(isObj).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string').slice(-8).map((m) => ({ role: m.role as 'user' | 'assistant', ts: str(m.ts, 40), text: String(m.text).slice(0, 4000) }))
    : [];
  const strings = (v: unknown, n: number, each: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, n).map((x) => x.slice(0, each)) : []);
  const tools: Record<string, number> = {};
  if (isObj(j.toolSummary)) {
    for (const [k, v] of Object.entries(j.toolSummary).slice(0, 40)) {
      if (typeof v === 'number' && Number.isFinite(v)) tools[k.slice(0, 40)] = v;
    }
  }
  const b = isObj(j.budget) ? j.budget : {};
  return {
    version: 1,
    source: {
      vendor: s.vendor.slice(0, 20), sessionId: s.sessionId.slice(0, 80), cwd: s.cwd.slice(0, 400), path: str(s.path, 600),
      recordsRead: Number(s.recordsRead) || 0, bytesRead: Number(s.bytesRead) || 0, firstTs: str(s.firstTs, 40), lastTs: str(s.lastTs, 40),
      truncated: s.truncated === true, nextCursor: str(s.nextCursor, 200),
    },
    lastRequest: str(j.lastRequest, 2000),
    messages,
    filesTouched: strings(j.filesTouched, 30, 300),
    toolSummary: tools,
    unfinished: strings(j.unfinished, 12, 300),
    budget: { maxBytes: Number(b.maxBytes) || 0, usedBytes: Number(b.usedBytes) || 0 },
    warnings: strings(j.warnings, 12, 80),
  };
}

export interface ExtractorOpts {
  script: string;
  vendor: string;
  sessionId: string;
  cwd: string;
  /** exact transcript path when the engine already knows it (avoids discovery) */
  file?: string | null;
  root?: string | null;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Run the extractor as a child process with a hard timeout. ANY failure is null: the packet is built without it. */
export function runExtractor(o: ExtractorOpts): Promise<HistoryExtract | null> {
  return new Promise((resolve) => {
    if (!existsSync(o.script)) {
      resolve(null);
      return;
    }
    const args = [o.script, '--vendor', o.vendor, '--session', o.sessionId, '--cwd', o.cwd, '--max-bytes', String(o.maxBytes ?? 6000)];
    if (o.file) args.push('--file', o.file);
    else if (o.root) args.push('--root', o.root);
    let out = '';
    let done = false;
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const finish = (v: HistoryExtract | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* gone */ }
      finish(null);
    }, o.timeoutMs ?? 8000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > 200_000) {
        try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* gone */ }
        finish(null);
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      try {
        finish(validateExtract(JSON.parse(out)));
      } catch {
        finish(null);
      }
    });
  });
}

/** Write the packet where the TARGET can read it: the project folder (it is the target's own workspace), under
 *  `.workbench/handover/`, kept out of git via `.git/info/exclude` (a local, invisible, idempotent entry). Atomic. */
export function savePacketFile(projectDir: string, opId: string, text: string): { path: string; sha256: string } {
  const dir = join(projectDir, '.workbench', 'handover');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${opId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_')}.md`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o644); } catch { /* best effort */ }
  const exclude = join(projectDir, '.git', 'info', 'exclude');
  try {
    if (existsSync(join(projectDir, '.git', 'info'))) {
      const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (!/^\/?\.workbench\/?$/m.test(cur)) {
        appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.workbench/\n`);
      }
    }
  } catch {
    /* not a repo, or read-only: the packet file still exists */
  }
  return { path, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}
