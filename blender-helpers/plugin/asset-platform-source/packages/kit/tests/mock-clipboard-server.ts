// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task
//
// Faithful in-memory mock of the asset-clipboard backend for the 1b headless
// acceptance. Mirrors the live endpoints the React <asset-clipboard> calls:
//   GET  /api/list                 -> { clips: [...] }   (transient, not trashed, newest-first)
//   POST /api/upload  (multipart)  -> { ok, clip }
//   GET  /api/clip/:id             -> audio bytes
//   POST /api/clip/:id/trash       -> { ok }
//   POST /api/clip/:id/revive      -> { ok }
//   GET  /api/recycle              -> { clips: [...] }    (trashed)
//   GET  /api/assets?transient=0   -> { assets: [...] }   (promoted/curated)
//   PATCH /api/assets/:id {promote} -> { ok }             (transient->saved; stays in list)
//   DELETE /api/clip/:id           -> { ok }
//
// This server ALSO serves the test fixture HTML + the built dist/ bundle, so the
// page and the API share ONE origin — exactly like production behind the gateway
// (:8260). Same-origin means NO CORS is needed (the real component never needs it
// either). It binds port 0 → the OS assigns a free ephemeral port, so the test
// never squats a registry-managed service port (ports.json `services` 8200-8299).
//
// Using a mock (vs. the shared LIVE backend) keeps the run deterministic and
// avoids mutating shared infra; the live wiring is separately confirmed read-only
// via the gateway (bundle loads, element registers, /api/list 200).
import http from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..'); // packages/kit

interface MockClip {
  id: string;
  label: string;
  filename: string;
  duration_s: number;
  created_at: string;
  trashed_at: string | null;
  promoted: boolean;
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const BASE = '/asset-management/library';

// Minimal same-origin static file serve for the fixture + built bundle.
const STATIC: Record<string, { file: string; type: string }> = {
  '/fixture.html': { file: 'tests/fixture-asset-clipboard.html', type: 'text/html' },
  '/audio-player.html': { file: 'tests/fixture-audio-player.html', type: 'text/html' },
  '/picker-panel.html': { file: 'tests/fixture-picker-panel.html', type: 'text/html' },
  '/picker.html': { file: 'tests/fixture-picker.html', type: 'text/html' },
  '/asset-kit.js': { file: 'dist/asset-kit.js', type: 'application/javascript' },
};

export interface MockHandle {
  server: Server;
  port: number;
  origin: string;
}

export function startMock(): Promise<MockHandle> {
  // PER-INSTANCE state — each startMock gets its own clip store. (Module-level
  // state would be shared across spec files in a single Playwright worker, so one
  // spec's uploads would leak into another's "empty clipboard" expectations.)
  const clips = new Map<string, MockClip>();
  const listBody = (filter: (c: MockClip) => boolean): MockClip[] =>
    [...clips.values()]
      .filter(filter)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url || '/', 'http://x');
    const p = u.pathname;
    const m = req.method;

    // --- static (same origin as the API) ---
    const stat = STATIC[p];
    if (stat && m === 'GET') {
      readFile(path.join(KIT_ROOT, stat.file))
        .then((buf) => {
          res.writeHead(200, { 'Content-Type': stat.type });
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(404);
          res.end('not found');
        });
      return;
    }

    // --- A3 picker-panel sources (yt-audio shape): history + exported clips ---
    if (p === '/api/history' && m === 'GET') {
      return sendJson(res, 200, {
        history: [
          { video_id: 'jNQXAC9IVRw', url: 'https://youtu.be/jNQXAC9IVRw', title: 'Me at the zoo', thumbnail: '', last_ts: '2026-06-01T00:00:00Z' },
          { video_id: 'abc123', url: 'https://youtu.be/abc123', title: 'Second video', thumbnail: '', last_ts: '2026-05-31T00:00:00Z' },
        ],
      });
    }
    if (p === '/api/clips' && m === 'GET') {
      return sendJson(res, 200, {
        clips: [{ id: 'c1', label: 'clip one', url: `${BASE}/api/clip/x`, ts: '2026-06-01T00:00:00Z' }],
      });
    }

    // --- mock API ---
    if (p === `${BASE}/api/list` && m === 'GET') {
      return sendJson(res, 200, { session: 'mock', clips: listBody((c) => !c.trashed_at) });
    }
    if (p === `${BASE}/api/recycle` && m === 'GET') {
      return sendJson(res, 200, { clips: listBody((c) => !!c.trashed_at) });
    }
    if (p === `${BASE}/api/assets` && m === 'GET') {
      return sendJson(res, 200, { assets: listBody((c) => c.promoted) });
    }
    if (p === `${BASE}/api/upload` && m === 'POST') {
      req.on('data', () => {}); // drain; we don't parse multipart, just mint a clip
      req.on('end', () => {
        const id = randomUUID();
        const seq = clips.size + 1;
        clips.set(id, {
          id,
          label: `kit-test-${seq}`,
          filename: `kit-test-${seq}.wav`,
          duration_s: 0.05,
          created_at: new Date(Date.now() + seq).toISOString(),
          trashed_at: null,
          promoted: false,
        });
        sendJson(res, 200, { ok: true, session: 'mock', clip: clips.get(id) });
      });
      return;
    }
    const clipMatch = p.match(new RegExp(`^${BASE}/api/clip/([^/]+)(/trash|/revive)?$`));
    if (clipMatch) {
      const id = decodeURIComponent(clipMatch[1]);
      const sub = clipMatch[2];
      const c = clips.get(id);
      if (sub === '/trash' && m === 'POST') {
        if (c) c.trashed_at = new Date().toISOString();
        return sendJson(res, 200, { ok: true });
      }
      if (sub === '/revive' && m === 'POST') {
        if (c) c.trashed_at = null;
        return sendJson(res, 200, { ok: true });
      }
      if (!sub && m === 'DELETE') {
        clips.delete(id);
        return sendJson(res, 200, { ok: true });
      }
      if (!sub && m === 'GET') {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        return res.end(Buffer.from('RIFF')); // enough for <audio src> in headless
      }
    }
    const assetMatch = p.match(new RegExp(`^${BASE}/api/assets/([^/]+)$`));
    if (assetMatch && m === 'PATCH') {
      const id = decodeURIComponent(assetMatch[1]);
      const c = clips.get(id);
      if (c) c.promoted = true; // stays in /api/list (transient), now also curated
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // port 0 → OS picks a free ephemeral port (no registry collision).
  return new Promise<MockHandle>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}
