/**
 * What a request can PROVE about which machine it came from.
 *
 * Contract §0: "the tailnet identity of the device is recorded as evidence and
 * a label, and checked as an additional gate when available; it is never the
 * credential." This module is that qualifier — it answers "can we tell?", and
 * says `none` out loud when we cannot, which is the same three-outcome shape
 * `project-dir.ts` settled on (yes / no / could-not-reach). Collapsing
 * "unknown" into "mismatch" would lock Owner out of his own laptop the moment
 * Serve is in the path; collapsing it into "match" would make the gate a lie.
 *
 * THREE SOURCES, not two. `peer` (the socket's own remote address, unforgeable
 * by anything short of controlling the network path) is the strong one and is
 * unconditional. `serve-xff` is new (2026-09-15): behind Tailscale Serve every
 * remote client arrives as loopback, so `peer` alone goes blind for Owner's
 * entire daily path — the very case this whole feature exists for. Gated
 * behind `HARBOR_WB_BEHIND_SERVE=1` (only the operator who has actually put
 * this engine behind Serve should turn it on), it reads `x-forwarded-for`
 * *only* when the socket peer is loopback, so it never competes with `peer`
 * evidence and never fires on a request that reached the port some other way.
 *
 * WHY THIS IS STILL SAFE, and the reasoning does not change from before: the
 * header is forgeable by anything that can already reach the loopback port,
 * so it is EVIDENCE ONLY. It is never promoted into an authorization decision
 * on its own strength — it only feeds the SAME narrowing check `peer` always
 * fed (does a replayed device cookie match the node it was minted on). It is
 * never wired into `src/server/auth.ts`'s `isLocalHookDelivery` exemption,
 * which stays a loopback-and-no-forwarding check for the reasons stated
 * there: growing "trust a header behind Serve" into a general rule is exactly
 * the mistake this file's whole design refuses to make. Two guards keep a
 * forged value from being treated as more than it is: it must parse as an
 * address inside Tailscale's own CGNAT range (100.64.0.0/10 — nothing outside
 * that range is a tailnet address, forged or not), and only the FIRST address
 * in the header is ever read (Serve prepends the client; anything after it is
 * whatever the client itself claimed).
 *
 * THE DEVICE KEY IS NEVER A HOSTNAME for the `serve-xff` path. Every iOS peer
 * reports `HostName: "localhost"` in `tailscale status --json`, so a hostname
 * would make every iPhone on the tailnet look like the same device. The node's
 * own public key (or ID, when a key is absent) is what `tailnet.peerFor`
 * returns for this — see `src/engine/tailnet.ts`. The `peer` path keeps
 * comparing hostnames, unchanged, for continuity with whatever it already
 * bound; the two sources are not meant to be interchangeable for the SAME
 * device; see the identity-engine test for the shape this takes in practice.
 */
import type { IncomingMessage } from 'node:http';
import { deviceFor, peerFor, type PeerInfo } from '../engine/tailnet.ts';

export type EvidenceKind = 'peer' | 'serve-xff' | 'none';

export interface Evidence {
  kind: EvidenceKind;
  /** A stable per-device key: the peer's tailnet hostname (`peer`) or its
   *  node public key/ID (`serve-xff` — see the header for why hostname is
   *  unsafe there). Null when the address did not resolve to a known peer. */
  node: string | null;
  /** The device's STABLE node key (its Tailscale public key / node ID), for BOTH sources. This is what a remembered device is bound to (device.tailnet_key):
   *  a hostname is not unique (every iOS peer says "localhost", a shared-in node may collide) and an address can be remapped. Null when the address did not
   *  resolve to a known peer. `node` stays as it was for the older rows and the account page's label. */
  key: string | null;
  /** The address itself, when one was determinable. */
  ip: string | null;
  /** What the peer record says about the device's kind (tagged: no owning user; shared in: another tailnet's owner), for the owner's optional refusal. */
  tags: string[];
  sharedIn: boolean | null;
  /** Human label for logs and the account page, e.g. "GPU-HOST · windows" or
   *  "iPhone · ios (100.x.y.z)". Null when nothing could be derived. */
  label: string | null;
  /** `Tailscale-User-Login`, when Serve identified an authenticated tailnet
   *  user on this request. Independent of device evidence — carried along
   *  for logging, not compared by `checkDevice`. */
  userLogin: string | null;
}

const NONE: Evidence = { kind: 'none', node: null, key: null, ip: null, tags: [], sharedIn: null, label: null, userLogin: null };

function behindServe(): boolean {
  return (process.env.HARBOR_WB_BEHIND_SERVE ?? '').trim() === '1';
}

function isLoopback(ip: string): boolean {
  return ip === '' || ip === '127.0.0.1' || ip === '::1';
}

/** The first value in a possibly-repeated, possibly-comma-joined header. */
function firstOf(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  const val = raw?.split(',')[0]?.trim();
  return val || null;
}

/**
 * Is this address shaped like a Tailscale IPv4 address? 100.64.0.0/10 is the
 * whole of Tailscale's CGNAT range — nothing a real tailnet peer presents
 * falls outside it. Exported for the unit that would otherwise have to
 * reconstruct it to test the boundary.
 *
 * IPv6 tailnet addresses (`fd7a:115c:a1e0::/48`) are deliberately NOT
 * recognised here: Serve's `x-forwarded-for` on this installation has only ever
 * been observed carrying the IPv4 form, and a stricter allow-list is the
 * safer default for a value we cannot verify. Widen it if that changes.
 */
export function looksLikeTailscaleAddress(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (!m) {
    return false;
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

const FRIENDLY_OS: Record<string, string> = {
  ios: 'iPhone',
  android: 'Android',
  macos: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
};

/**
 * A human label for a resolved peer, e.g. "GPU-HOST · windows". When the
 * hostname is generic (missing, or the literal "localhost" every iOS peer
 * reports) it falls back to a friendly name derived from the OS plus the
 * address, e.g. "iPhone · ios (100.64.0.9)" — otherwise every iPhone would
 * print the same unhelpful label. Exported so label shape is unit-testable
 * without a live `tailscale status --json`.
 */
export function deriveLabel(peer: PeerInfo | null, ip: string): string | null {
  if (!peer) {
    return null;
  }
  const os = (peer.os ?? '').toLowerCase();
  const generic = !peer.hostName || peer.hostName.toLowerCase() === 'localhost';
  if (!generic) {
    return os ? `${peer.hostName} · ${os}` : peer.hostName;
  }
  const friendly = FRIENDLY_OS[os] ?? (os ? os[0].toUpperCase() + os.slice(1) : 'Unknown device');
  return os ? `${friendly} · ${os} (${ip})` : `${friendly} (${ip})`;
}

/** What this request proves about its origin machine. */
export function evidenceFor(req: IncomingMessage): Evidence {
  const rawIp = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
  const loopback = isLoopback(rawIp);
  const xff = req.headers['x-forwarded-for'];

  if (behindServe() && loopback && xff) {
    const client = firstOf(xff);
    if (client && looksLikeTailscaleAddress(client)) {
      const peer = peerFor(client);
      return {
        kind: 'serve-xff',
        node: peer?.nodeKey ?? null,
        key: peer?.nodeKey ?? null,
        ip: client,
        tags: peer?.tags ?? [],
        sharedIn: peer ? peer.sharedIn === true : null,
        label: deriveLabel(peer, client),
        userLogin: firstOf(req.headers['tailscale-user-login']),
      };
    }
    // Present but unusable (not a tailnet-shaped address) — never guess.
    return NONE;
  }

  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) {
    // A proxy hop outside the behind-Serve contract above (switch off, or the
    // peer wasn't loopback to begin with). The real address, if any, exists
    // only in a header we must not trust here.
    return NONE;
  }
  if (!rawIp || loopback) {
    // Loopback names this machine, not a device: a local window and a Serve
    // hop (with the switch off) are indistinguishable here, so it proves
    // nothing about WHICH device.
    return NONE;
  }
  const direct = peerFor(rawIp);
  return {
    kind: 'peer',
    node: deviceFor(rawIp),
    key: direct?.nodeKey ?? null,
    ip: rawIp,
    tags: direct?.tags ?? [],
    sharedIn: direct ? direct.sharedIn === true : null,
    label: deriveLabel(direct, rawIp),
    userLogin: null,
  };
}

export interface EvidenceVerdict {
  ok: boolean;
  /** Recorded on the device row's last use. */
  evidence: EvidenceKind;
  /** One line for the log when a device is refused. Names only — never a token. */
  reason: string | null;
}

/**
 * Check a remembered device against what it recorded when it was minted.
 *
 * Refuses only on a DISAGREEMENT between two things we can both see. If either
 * side is unknown there is nothing to compare, and an unknown is not a
 * mismatch. This applies identically regardless of which source (`peer` or
 * `serve-xff`) produced `seen` — the gate does not care how a device was seen,
 * only whether what it shows now agrees with what it showed when minted.
 *
 * Node name beats IP: a tailnet address can change (re-auth, ephemeral node,
 * IPv4/IPv6 on the same machine) while the node is the same machine, and the
 * name is what Owner would read on the account page. The IP is compared only
 * when neither side has a name.
 */
export function checkDevice(
  recorded: { tailnet_node: string | null; tailnet_ip: string | null; tailnet_key?: string | null },
  seen: Evidence,
): EvidenceVerdict {
  if (seen.kind === 'none') {
    return { ok: true, evidence: 'none', reason: null };
  }
  /* KEY TO KEY, whenever both sides have one (Add a server, design review [ref]): the node key is the same string on the `peer` and `serve-xff` paths and survives a
     hostname collision or an address remap, so a token minted behind Serve is accepted on a direct tailnet connection and a shared-in node binds to ITSELF.
     A row from before the column has no key and keeps today's behaviour below. */
  if (recorded.tailnet_key && seen.key) {
    if (recorded.tailnet_key !== seen.key) {
      return { ok: false, evidence: seen.kind, reason: 'device bound to another tailnet device (node key mismatch)' };
    }
    return { ok: true, evidence: seen.kind, reason: null };
  }
  if (recorded.tailnet_node && seen.node) {
    if (recorded.tailnet_node !== seen.node) {
      return {
        ok: false,
        evidence: seen.kind,
        reason: `device bound to ${recorded.tailnet_node}, presented from ${seen.node}`,
      };
    }
    return { ok: true, evidence: seen.kind, reason: null };
  }
  if (recorded.tailnet_ip && seen.ip && !recorded.tailnet_node && !seen.node) {
    if (recorded.tailnet_ip !== seen.ip) {
      return {
        ok: false,
        evidence: seen.kind,
        reason: `device bound to ${recorded.tailnet_ip}, presented from ${seen.ip}`,
      };
    }
  }
  return { ok: true, evidence: seen.kind, reason: null };
}
