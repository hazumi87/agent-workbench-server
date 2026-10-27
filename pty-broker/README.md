# PTY broker

The broker holds interactive terminal sessions for the Workbench engine. An engine reconnect can attach to an existing session and replay its recent output. Restarting the broker ends its sessions.

The reference server runs this package as the agent operating-system account. Its systemd unit is named `workbench-broker.service`; that name does not refer to a separate package. See [the reference deployment](../deploy/reference/README.md).

## Interface

WebSocket clients connect to `/broker` with a bearer token in the Authorization header. Tokens in query strings and browser Origin requests are rejected. `GET /health` exposes status and counts, without session content. Authentication and payload limits are defined in `src/auth.ts`.

The protocol in `src/protocol.ts` supports spawn, attach, detach, input, resize, kill and list. Sessions retain a bounded replay buffer and temporary exit tombstones. A new attachment replaces the previous attached client. Consumers check the protocol version before using the connection.

## Dependencies and checks

Run `npm ci` in this directory before installing the sibling engine. The engine uses this package through its local `file:../pty-broker` dependency.

`npm run typecheck` checks the TypeScript source. `npm test` starts temporary brokers and exercises session continuity, replay, authentication and stale tombstones; run it only in an isolated test environment. Production configuration and service operation are covered by the reference deployment guide.
