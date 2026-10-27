/**
 * THE ENGINE AS ITS OWN HEADLESS VIEWER, IN-PROCESS (assistant switch, the design notes §3 item 1).
 *
 * A headless launch spawns when a viewer attaches (index.ts launchRecipe: "the window is the viewer"), and the
 * seat-reload driver (seat-reload-drive.ts) is that viewer: it dials the engine's own /pty socket with the shared
 * bearer. Under STRICT accounts (Basic) the shared bearer is dead on every door, so the engine's own dial is refused
 * (401) and nothing it launches headless can start. This pair is the same attach WITHOUT a network hop: the server
 * half goes through the /pty connection handler exactly as a window's socket does, so every rule a viewer meets
 * (intent 'view' never takes the keyboard, spawn guards, permits) applies unchanged. It carries no credential and opens
 * no door: nothing outside this process can reach it.
 *
 * The server half implements only what the connection handler uses on a socket: on/emit, send, readyState + OPEN,
 * ping (answered with a pong), terminate/close (both fire 'close' on each half once).
 */
import { EventEmitter } from 'node:events';

export interface SelfSocket {
  on(event: string, fn: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
}

export function selfPair(): { server: any; client: SelfSocket } {
  const OPEN = 1;
  const CLOSED = 3;
  let state = OPEN;
  const server: any = new EventEmitter();
  const client: any = new EventEmitter();
  const shut = (): void => {
    if (state === CLOSED) return;
    state = CLOSED;
    setImmediate(() => {
      server.emit('close', 1000, Buffer.from(''));
      client.emit('close', 1000);
    });
  };
  Object.defineProperty(server, 'readyState', { get: () => state });
  server.CONNECTING = 0;
  server.OPEN = OPEN;
  server.CLOSING = 2;
  server.CLOSED = CLOSED;
  server.send = (data: unknown, a?: unknown, b?: unknown): void => {
    const cb = typeof a === 'function' ? a : typeof b === 'function' ? b : null;
    if (state === OPEN) {
      const s = typeof data === 'string' ? data : String(data);
      setImmediate(() => client.emit('message', Buffer.from(s)));
    }
    if (cb) (cb as () => void)();
  };
  server.ping = (): void => {
    setImmediate(() => state === OPEN && server.emit('pong'));
  };
  server.terminate = shut;
  server.close = shut;
  client.send = (data: string): void => {
    if (state === OPEN) setImmediate(() => server.emit('message', Buffer.from(data), false));
  };
  client.close = shut;
  setImmediate(() => client.emit('open'));
  return { server, client };
}
