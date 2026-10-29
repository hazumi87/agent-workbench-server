// asset-library-shell — serves the Asset Library Shell SPA at /asset-management/library/.
// Built from monorepo packages/app. Pure static SPA. (Phase B rename: was
// /asset-tools/library.) The namespace root /asset-management/ is a separate
// landing page owned by the gateway; the library SPA lives one level down.
//
// NOTE: no node_modules here — uses only node built-ins, like asset-kit/server.js.
// The `app` object passed in is the gateway's express instance.
//
// Deploy: rebuild packages/app → cp dist/* here/dist/ → restart the gateway
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, existsSync } from 'fs';
import { stat } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE = '/asset-management/library';
const DIST = path.join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function ext(p) {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i) : '';
}

export async function register(app) {
  // Serve content-hashed assets under /assets/
  app.get(`${BASE}/assets/*`, async (req, res) => {
    const rel = req.path.replace(`${BASE}/assets/`, '');
    const file = path.join(DIST, 'assets', rel);
    if (!existsSync(file)) return res.status(404).end();
    try {
      const s = await stat(file);
      res.setHeader('Content-Type', MIME[ext(file)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Length', s.size);
      createReadStream(file).pipe(res);
    } catch { res.status(500).end(); }
  });

  // All other paths → serve index.html (SPA client-side routing)
  app.get([BASE, `${BASE}/`, `${BASE}/*`], (_req, res) => {
    const idx = path.join(DIST, 'index.html');
    if (!existsSync(idx)) return res.status(503).send('Shell not built — run: pnpm --filter @asset/app build');
    res.setHeader('Content-Type', 'text/html');
    createReadStream(idx).pipe(res);
  });
}
