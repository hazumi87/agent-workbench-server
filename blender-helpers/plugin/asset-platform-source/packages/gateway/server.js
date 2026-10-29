import express from 'express';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
// asset-clipboard service RETIRED (B0/P5) — the asset-library now serves the
// clipboard API (transient view); the kit's <asset-clipboard> defaults there.

// ROOT = the directory holding the deployed tool folders. Defaults to the runtime
// deploy target, so no env is needed in production. Set ASSET_PLATFORM_ROOT to boot
// the gateway against a different layout (e.g. a staging copy). This env-var indirection
// is why tools are loaded via dynamic import below instead of static imports —
// canonical == runtime with no deploy-time path rewrite (ends the Phase C path drift).
const ROOT = process.env.ASSET_PLATFORM_ROOT || (process.env.HOME || '.') + '/asset-management';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8260;

// Manifest: add new tools here — one line per tool. Each tool's register is loaded
// from ${ROOT}/<name>/server.js at boot.
const TOOLS = [
  { name: 'asset-library' },
  { name: 'image-gen' },
  // Image ops kit — crop/trim/flip/rotate/resize/pad/threshold/invert + to_svg over Library images.
  { name: 'image-ops' },
  // Model Studio core — orchestrates 3D backends (separate HTTP services) from a human-edited config (the design notes).
  { name: 'model-studio' },
  // React component kit (light-DOM Web Components) — coexists with vanilla picker.js
  { name: 'asset-kit' },
  // Asset Library Shell SPA — served at /asset-management/library/ (Phase B rename)
  { name: 'asset-library-shell' },
];

const app = express();
app.use(express.json());

// ── Temporary landing page at the namespace root /asset-management/ ──────────
// the user (Phase B): root is reserved for a future home page (curated library
// highlights + tools showcase). For now serve a minimal placeholder that links
// to the library and lists the tools, so those links never need rewiring when
// the real home lands. The library SPA itself is at /asset-management/library/.
const TOOL_LINKS = [];
function landingHtml() {
  const tools = TOOL_LINKS.map(([id, label]) =>
    `<li><a href="/asset-management/tools/${id}/">${label}</a></li>`).join('\n      ');
  return `<!doctype html><html><head><meta charset="utf-8">
  <title>Asset Management</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1.5rem;
         background:#0f1115;color:#e6e8eb;line-height:1.6}
    h1{font-weight:600;letter-spacing:-.02em} a{color:#5eb1ef;text-decoration:none}
    a:hover{text-decoration:underline} .cta{display:inline-block;margin:1rem 0 2rem;
    padding:.7rem 1.4rem;background:#1f6feb;color:#fff;border-radius:8px;font-weight:600}
    ul{padding-left:1.2rem} .note{color:#8b949e;font-size:.85rem;margin-top:3rem}
  </style></head><body>
  <h1>Asset Management</h1>
  <p>The asset library and its tools. (Temporary landing — a curated home page lands here later.)</p>
  <a class="cta" href="/asset-management/library/">Open the Library →</a>
  <h2>Tools</h2>
  <ul>
      ${tools}
  </ul>
  <p class="note">This is a placeholder. Future: library highlights + tools showcase.</p>
  </body></html>`;
}
app.get(['/asset-management', '/asset-management/'], (_req, res) => {
  res.setHeader('Content-Type', 'text/html').send(landingHtml());
});

// Back-compat: existing /asset-tools/* bookmarks, already-shared raw-byte URLs,
// and AssetReference rawUrls (which baked an absolute /asset-tools/asset-library
// /api/.../file) keep working. Map the old prefix onto the new namespace —
// including the asset-library→library API-segment collapse — then 301.
app.use((req, res, next) => {
  if (!req.path.startsWith('/asset-tools')) return next();
  let p = req.path
    .replace('/asset-tools/asset-library', '/asset-management/library')
    .replace('/asset-tools/library', '/asset-management/library')
    .replace('/asset-tools', '/asset-management/tools');
  // bare /asset-tools or /asset-tools/ → the library
  if (req.path === '/asset-tools' || req.path === '/asset-tools/') p = '/asset-management/library/';
  const qs = req.url.slice(req.path.length); // preserve ?query
  res.redirect(301, p + qs);
});

for (const tool of TOOLS) {
  // Absolute path → file URL so dynamic import is portable across the ROOT layouts.
  const modUrl = pathToFileURL(path.join(ROOT, tool.name, 'server.js')).href;
  // One tool failing to load or register must not keep the gateway from listening for all the
  // others ( a locked DB at asset-library's init left every tool unreachable).
  try {
    const { register } = await import(modUrl);
    await register(app);
    console.log(`Registered tool: ${tool.name}`);
  } catch (e) {
    console.error(`FAILED to register tool ${tool.name} — the others still load:`, e);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`asset-tools-gateway on 0.0.0.0:${PORT}`);
});
