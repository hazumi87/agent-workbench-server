/**
 * Tailnet device names — turning a connecting IP into something a human reads.
 *
 * The control lease's whole job is answering "who has the keyboard right now."
 * A client can only describe ITSELF ("Windows browser"), which is useless when
 * two machines run the same OS — the VRPC at the desk and the laptop both say
 * "Windows" (seen live, 2026-08-19). The engine, though, sees where the socket
 * came from, and on this installation every device is on the tailnet. So we resolve
 * the peer IP to its tailnet hostname and the message becomes "Windows browser
 * · haz-001", which names the actual machine.
 *
 * Best-effort and non-fatal: no tailscale, no CLI on PATH, a parse failure —
 * all degrade to the bare address. Nothing here is a security boundary; it is
 * a display nicety. Auth is a separate concern (see the design notes).
 */
import { execFile } from 'node:child_process';

/** Where the Windows installer puts it; `tailscale` alone is not on the
 *  service's PATH (the engine runs under harbor, not a login shell). */
const CANDIDATES = [
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale',
];

let ipToName = new Map<string, string>();
/** This host's own tailnet name, so loopback can be NAMED rather than described
 *  relative to whoever happens to be reading. */
let selfName: string | null = null;

/**
 * The fuller record behind a tailnet IP — added 2026-09-15 alongside the
 * identity evidence work (`src/identity/tailnet-evidence.ts`). `deviceFor`
 * above only ever needed a display hostname; evidence needs a key that
 * cannot collide. **iOS peers all report `HostName: "localhost"`**, so the
 * hostname alone would make every iPhone on the tailnet look like the same
 * device — `nodeKey` (the node's stable public key/ID) is the field that
 * cannot. */
export interface PeerInfo {
  hostName: string;
  os: string | null;
  nodeKey: string | null;
  tailscaleIP: string;
  /** `Tags` from `tailscale status --json`: a tagged device has no owning user (verified on the server 2026-10-25: tag:routers, tag:home). */
  tags?: string[];
  /** `ShareeNode`: a device shared in from ANOTHER tailnet. Not observable on this installation's tailnet (no shared-in peer exists), so it is read from Tailscale's documented field. */
  sharedIn?: boolean;
}

interface RawNode {
  TailscaleIPs?: string[];
  HostName?: string;
  OS?: string;
  PublicKey?: string;
  ID?: string;
  Tags?: string[];
  ShareeNode?: boolean;
}

let ipToPeer = new Map<string, PeerInfo>();
let selfPeer: PeerInfo | null = null;

function run(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['status', '--json'], { timeout: 4000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Refresh the IP→hostname map. Call at boot; cheap enough to repeat. */
export async function refresh(): Promise<number> {
  for (const bin of CANDIDATES) {
    try {
      const raw = await run(bin);
      const parsed = JSON.parse(raw) as {
        Self?: RawNode;
        Peer?: Record<string, RawNode>;
      };
      const next = new Map<string, string>();
      const nextPeers = new Map<string, PeerInfo>();
      let selfInfo: PeerInfo | null = null;
      const add = (node: RawNode | undefined, isSelf: boolean): void => {
        if (!node?.HostName) {
          return;
        }
        const nodeKey = node.PublicKey ?? node.ID ?? null;
        for (const ip of node.TailscaleIPs ?? []) {
          next.set(ip, node.HostName);
          const info: PeerInfo = {
            hostName: node.HostName,
            os: node.OS ?? null,
            nodeKey,
            tailscaleIP: ip,
            tags: Array.isArray(node.Tags) ? node.Tags.filter((t) => typeof t === 'string') : [],
            sharedIn: node.ShareeNode === true,
          };
          nextPeers.set(ip, info);
          if (isSelf) {
            selfInfo = info;
          }
        }
      };
      add(parsed.Self, true);
      selfName = parsed.Self?.HostName ?? null;
      for (const peer of Object.values(parsed.Peer ?? {})) {
        add(peer, false);
      }
      ipToName = next;
      ipToPeer = nextPeers;
      selfPeer = selfInfo;
      return next.size;
    } catch {
      /* try the next candidate path */
    }
  }
  return 0;
}

/**
 * Human name for a connecting address, or null if we cannot do better than the
 * raw address. Loopback is "this machine" — the desk, not a tailnet peer.
 */
export function deviceFor(remoteAddress: string | undefined): string | null {
  if (!remoteAddress) {
    return null;
  }
  const ip = remoteAddress.replace('::ffff:', '');
  if (ip === '127.0.0.1' || ip === '::1') {
    /* NAME IT, never "this machine".
     *
     * The label is WRITTEN by the engine and READ by a client that may be
     * anywhere. "this machine" is engine-relative, so on Owner's laptop the
     * manager said Kiosk was active on "this machine" while every other row
     * said `haz-001` — it looked like the session he was using locally, and it
     * meant the exact opposite (2026-08-31). An absolute name is true from
     * every vantage point, which is the only property that works for a label
     * that travels. */
    return selfName ?? 'the engine host';
  }
  return ipToName.get(ip) ?? null;
}

/**
 * The full peer record for an address, when the tailnet map has one.
 * `deviceFor` above answers "what do I call this address"; this answers "what
 * do I actually know about it" — used by identity evidence
 * (`src/identity/tailnet-evidence.ts`) to derive a per-device key that
 * survives an iOS peer's shared `HostName: "localhost"`, and a human label.
 * Same loopback-means-self handling as `deviceFor`.
 */
export function peerFor(remoteAddress: string | undefined): PeerInfo | null {
  if (!remoteAddress) {
    return null;
  }
  const ip = remoteAddress.replace('::ffff:', '');
  if (ip === '127.0.0.1' || ip === '::1') {
    return selfPeer;
  }
  return ipToPeer.get(ip) ?? null;
}

/**
 * The address to NAME a client by, given the socket and its headers.
 *
 * Behind Tailscale Serve every remote client arrives on 127.0.0.1, so the
 * socket address alone labels the laptop "this machine" — which defeats the
 * entire point of the label (found live 2026-08-23: all six sessions read
 * "Windows browser · this machine"). Serve puts the real tailnet address in
 * `x-forwarded-for`, so prefer it.
 *
 * TRUSTING A HEADER HERE IS DELIBERATE AND SAFE, and the reason is worth being
 * precise about because the opposite rule holds one file over: auth must NEVER
 * trust a forwarded header, since anything that can reach the loopback port
 * could forge one (see src/server/auth.ts). This is a DISPLAY NICETY. The worst
 * a forged value does is print the wrong machine name next to "has control" —
 * it grants nothing. Never promote this to an authorization input.
 */
export function clientAddress(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const fwd = headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || remoteAddress;
}

/** TEST HOOK: replace the peer map (what `tailscale status --json` would have said), so identity tests can name peers without a tailnet. */
export function _setPeersForTest(peers: PeerInfo[], self: PeerInfo | null = null): void {
  ipToPeer = new Map(peers.map((p) => [p.tailscaleIP, p]));
  ipToName = new Map(peers.map((p) => [p.tailscaleIP, p.hostName]));
  selfPeer = self;
  selfName = self?.hostName ?? null;
}
