/* LOCAL MODE GUARD (E6) AND THE BOUND PORT (E2). Import-free, so telemetry, the fabric subscriber, channels and the server can all ask
 * without a cycle.
 *
 * E6. A local engine is a closed node: it never calls NATS, the fabric or channel MCP, whatever the environment says. The refusal is
 * read at CALL time from the env, not captured at module load, so a variable the supervisor forgot to pin (or a test that sets the mode
 * after import) cannot decide it. The supervisor's pin of HARBOR_WB_NATS_URL / HARBOR_WB_FABRIC_URL stays, as a second lock.
 *
 * E2. A local engine binds port 0 and the OS picks, so HARBOR_WB_PORT (unset, or '0') is NOT the port anything can dial. The server
 * records the port it actually bound; every reader that builds an engine URL asks here. */

function isLocal(env: Record<string, string | undefined>): boolean {
  return (env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local';
}

/* The HOSTED web-first pilot (HARBOR_WB_HOSTED=1) is a closed node too: one person per server, no NATS, no fabric, no channel MCP, whatever the environment says. */
export function networkServicesRefused(env: Record<string, string | undefined> = process.env): boolean {
  return isLocal(env) || (env.HARBOR_WB_HOSTED ?? '').trim() === '1';
}

let bound: number | null = null;

/** Called once by the server when listen() reports the port. Anything that is not a real port clears it. */
export function setBoundPort(port: number | null): void {
  bound = typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** The port the engine is actually listening on, or null before it listens. */
export function boundPort(): number | null {
  return bound;
}

/** The port to put in a URL that points back at this engine: the bound port when there is one, else the configured one (server mode's
 *  default 7420). In local mode before listen there is no honest answer, so 0 comes back rather than a guess at 7420, which is the
 *  real server's port. */
export function enginePort(env: Record<string, string | undefined> = process.env): number {
  if (bound !== null) {
    return bound;
  }
  if (isLocal(env)) {
    return 0;
  }
  const n = Number(env.HARBOR_WB_PORT ?? 7420);
  return Number.isInteger(n) && n > 0 ? n : 7420;
}
