/* ============================================================================
 * APP ENDPOINT VERIFICATION (the design notes §4.4, security P0 on
 * rooms/apps-engine) [rooms/apps-sec].
 *
 * A tool's port comes from `status/app.json`, which the `agents` group can
 * write, while the engine's bearer is 0600 to the engine's own account. So
 * before the engine sends that bearer anywhere (the bind call), or builds a
 * panel from a discovered port, it checks WHO is listening:
 *
 *   1. the port is an integer 1024-65535, not this engine's own port and not a
 *      known service port (a confused-deputy guard: the engine must never POST
 *      its own bearer back at itself or at the broker / fabric / harbor);
 *   2. every LISTEN socket that would take a connection to 127.0.0.1:<port>
 *      (127.0.0.1, 0.0.0.0, ::ffff:127.0.0.1, ::) is owned by THIS process's
 *      uid — read from /proc/net/tcp + tcp6, state 0A;
 *   3. each of those sockets' inode is an open fd of app.json#pid, and that
 *      pid's cwd (realpath) is inside the tool root (realpath).
 *
 * Any failure is "unverified": no bearer, no panel. Linux only — anywhere else
 * the answer is `platform`, and nothing is sent. Deliberately free of engine
 * imports (auth.ts mints a credential at load) so it unit-tests in isolation;
 * /proc is read through an injectable reader so the uid branch can be tested
 * without a second account.
 *
 * WHAT THIS DOES NOT CLOSE: a same-uid process can pass every check, and the
 * listener can change between this check and the fetch. The real fix is a
 * per-app bind secret (R-next, needs an Image Studio change).
 * ========================================================================== */

import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { endianness } from 'node:os';
import * as nodePath from 'node:path';

type PathMod = Pick<typeof nodePath, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

/** Is `target` `base` itself or somewhere under it? Resolved on both sides,
 *  compared with path.relative, never as raw strings (a separator or a
 *  trailing slash must not decide it — the r22 Windows run). Anything odd
 *  (a '..' prefix, a different drive, an absolute remainder) fails CLOSED.
 *  `pathMod` is injectable so a win32 path can be tested on Linux. */
export function isInside(base: string, target: string, pathMod: PathMod = nodePath): boolean {
  const rel = pathMod.relative(pathMod.resolve(base), pathMod.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel));
}

/** Is `target` exactly one folder directly under `base`? Same rules. */
export function isDirectChild(base: string, target: string, pathMod: PathMod = nodePath): boolean {
  const rel = pathMod.relative(pathMod.resolve(base), pathMod.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !pathMod.isAbsolute(rel) && !rel.includes(pathMod.sep) && !rel.includes('/');
}

export interface ProcReader {
  readFile(path: string): string;
  readdir(path: string): string[];
  readlink(path: string): string;
  realpath(path: string): string;
}

export const realProc: ProcReader = {
  readFile: (p) => readFileSync(p, 'utf8'),
  readdir: (p) => readdirSync(p),
  readlink: (p) => readlinkSync(p),
  realpath: (p) => realpathSync(p),
};

/** Ports an app may never claim, whatever app.json says: the engine (VRPC
 *  default + server), the real pty-broker, the launcher, the fabric,
 *  harbor. The engine's own configured port is added at call time. */
export const RESERVED_PORTS: readonly number[] = Object.freeze([7420, 7430, 8201, 8202, 8204, 8210]);

export type EndpointCheck = { ok: true; port: number } | { ok: false; reason: string };

export interface VerifyOpts {
  enginePort?: number;
  proc?: ProcReader;
  uid?: number;
  platform?: string;
}

const LISTEN = '0A';
const ACCEPTED = new Set(['127.0.0.1', '0.0.0.0', '::ffff:127.0.0.1', '::']);

/** /proc/net/tcp{,6} print each 32-bit word of the address as a native-endian
 *  %08X, so on a little-endian host each word's bytes are reversed. */
function decodeAddr(hex: string): string {
  const bytes: number[] = [];
  for (let w = 0; w < hex.length; w += 8) {
    const word = hex.slice(w, w + 8);
    const wb = [0, 2, 4, 6].map((i) => parseInt(word.slice(i, i + 2), 16));
    bytes.push(...(endianness() === 'LE' ? wb.reverse() : wb));
  }
  if (bytes.length === 4) {
    return bytes.join('.');
  }
  if (bytes.length !== 16) {
    return 'other';
  }
  if (bytes.every((b) => b === 0)) {
    return '::';
  }
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join('.')}`;
  }
  return 'other';
}

interface ListenSock {
  addr: string;
  uid: number;
  inode: string;
}

/** Every LISTEN socket on `port` that a connect to 127.0.0.1:<port> could reach. */
function listenersOn(port: number, proc: ProcReader): ListenSock[] {
  const out: ListenSock[] = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = proc.readFile(file);
    } catch {
      continue; // no IPv6 on this host, e.g.
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== LISTEN) {
        continue;
      }
      const [addrHex, portHex] = f[1].split(':');
      if (parseInt(portHex, 16) !== port) {
        continue;
      }
      const addr = decodeAddr(addrHex);
      if (!ACCEPTED.has(addr)) {
        continue;
      }
      out.push({ addr, uid: Number(f[7]), inode: f[9] });
    }
  }
  return out;
}

function socketInodes(pid: number, proc: ProcReader): Set<string> | null {
  try {
    const out = new Set<string>();
    for (const fd of proc.readdir(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(proc.readlink(`/proc/${pid}/fd/${fd}`));
        if (m) {
          out.add(m[1]);
        }
      } catch {
        /* an fd closed while we listed it */
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Is the endpoint app.json names really this tool's own process, under our
 *  own uid? `{ok:false, reason}` is "unverified" — the reason is for a human
 *  (the catalog shows it), never parsed. `no-listener` is the one reason a
 *  caller may read, to report a stopped app as down rather than unknown. */
export function verifyEndpoint(root: string, appJson: { port?: unknown; pid?: unknown } | null, opts: VerifyOpts = {}): EndpointCheck {
  if ((opts.platform ?? process.platform) !== 'linux') {
    return { ok: false, reason: 'platform' };
  }
  const proc = opts.proc ?? realProc;
  const uid = opts.uid ?? process.getuid!();
  const enginePort = opts.enginePort ?? Number(process.env.HARBOR_WB_PORT ?? 7420);
  const port = appJson?.port;
  const pid = appJson?.pid;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, reason: 'port out of range' };
  }
  if (port === enginePort || RESERVED_PORTS.includes(port)) {
    return { ok: false, reason: `port ${port} is reserved` };
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) {
    return { ok: false, reason: 'app.json has no valid pid' };
  }
  const socks = listenersOn(port, proc);
  if (!socks.length) {
    return { ok: false, reason: 'no-listener' };
  }
  const foreign = socks.find((s) => s.uid !== uid);
  if (foreign) {
    return { ok: false, reason: `listener on ${port} belongs to uid ${foreign.uid}, not ${uid}` };
  }
  const inodes = socketInodes(pid, proc);
  if (!inodes) {
    return { ok: false, reason: `cannot read the fds of pid ${pid}` };
  }
  if (socks.some((s) => !inodes.has(s.inode))) {
    return { ok: false, reason: `listener on ${port} is not held by pid ${pid}` };
  }
  let cwd: string;
  let rootReal: string;
  try {
    cwd = proc.realpath(`/proc/${pid}/cwd`);
    rootReal = proc.realpath(root);
  } catch {
    return { ok: false, reason: `cannot resolve the cwd of pid ${pid} or the tool root` };
  }
  if (!isInside(rootReal, cwd)) {
    return { ok: false, reason: `pid ${pid} does not run inside the tool root` };
  }
  return { ok: true, port };
}
