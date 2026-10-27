/* A static server for the document viewer's browser tests and probe [ticket]:
 * web/ at /, plus /__harness.html (the real module + CSS, nothing else) and
 * two stand-ins for the engine's raw route. No engine, no auth. */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export const HARNESS = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/vendor/aurora-tokens.css"><link rel="stylesheet" href="/room.css"><link rel="stylesheet" href="/room-doc-view.css">
<body style="margin:0;background:var(--ink);color:var(--text);font-family:var(--font)">
<div class="rm-pv" id="pv" style="position:fixed;top:0;bottom:0;right:0;width:420px"><div class="pv-h"><span class="pv-t"><b class="pv-name">doc</b></span><div class="pv-tools" id="tools"></div><button class="pv-x" id="x"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="pv-b" id="pvb"></div></div>
<script type="module">
import * as dv from '/room-doc-view.mjs';
window.dv = dv;
window.mount = (o) => { const d = dv.createDocView(o); document.getElementById('pvb').replaceChildren(d.body); document.getElementById('tools').replaceChildren(d.tools); window.cur = d; return d; };
window.ready = true;
</script>`;

export function serveWeb(port) {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__harness.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HARNESS);
      return;
    }
    if (u.pathname.startsWith('/api/rooms/r1/assets/raw/')) {
      res.writeHead(200, { 'content-type': u.pathname.endsWith('.png') ? 'image/png' : 'text/markdown' });
      res.end(u.pathname.endsWith('.png') ? PNG : '# raw\n');
      return;
    }
    if (u.pathname.startsWith('/__doc/')) {
      const f = join(process.env.DOCVIEW_DOCS || '', normalize(u.pathname.slice(7)));
      if (existsSync(f)) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(readFileSync(f));
        return;
      }
    }
    const f = join(WEB, normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (f.startsWith(WEB) && existsSync(f) && statSync(f).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
      res.end(readFileSync(f));
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}
