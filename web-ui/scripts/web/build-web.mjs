#!/usr/bin/env node
// Builds the self-contained WEB BUNDLE: static renderer files, wb-web.js, index.html and MANIFEST.json (the
// CSP and a sha256 per file). The bundle is data, not code: the engine (or scripts/web/serve.mjs) serves the
// directory as is, so mounting it is a copy. Build-time only; esbuild is a pinned devDependency.
//   node scripts/web/build-web.mjs [--out dist-web/web-app] [--nm <node_modules with @xterm>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkClaims } from '../../src/renderer/attachment-claims.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const web = path.join(root, 'web');
const require = createRequire(import.meta.url);

function loadEsbuild() {
  const tries = [root, process.env.WB_ESBUILD_FROM].filter(Boolean);
  for (const base of tries) {
    try { return require(require.resolve('esbuild', { paths: [base] })); } catch (e) { /* next */ }
  }
  throw new Error('esbuild is not installed (npm ci), or set WB_ESBUILD_FROM to a folder whose node_modules has it');
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** index.html for the web: web CSP, local URLs re-rooted from src/renderer/ to the bundle root, wb-web.js
 *  before everything, a slice's mounts after renderer.js. Pure: tests call it with strings. */
// the app's generic ">_" mark in the brand blue, as a data: URL (img-src allows data:), so there is no request to fail
export const FAVICON_LINK = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#3b5ba9"/><path d="M7 8l4 4-4 4M13 16h4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>')}">`;
export const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
export function transformIndex(html, { csp, mounts }) {
  const out = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp.meta}">`);
  const rewritten = out.replace(/\b(href|src)="([^"]+)"/g, (whole, attr, value) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value)) return whole;
    return `${attr}="${path.posix.normalize(path.posix.join('src/renderer', value))}"`;
  });
  const first = rewritten.indexOf('<script');
  if (first < 0) throw new Error('index.html has no script tag');
  let page = rewritten.slice(0, first) + '<script src="wb-web.js"></script>\n' + rewritten.slice(first);
  // a phone lays a page out at 980 px and shrinks it unless the page says it is mobile-ready (every built HTML document carries this)
  if (!/<meta\s+name="viewport"/i.test(page)) page = /<meta charset="utf-8">/i.test(page) ? page.replace(/<meta charset="utf-8">/i, (m) => m + '\n' + VIEWPORT_META) : page.replace('<head>', '<head>\n' + VIEWPORT_META);
  // an icon of our own: without one the browser asks for /favicon.ico and logs a 404 on every load (quality item 14)
  if (!/<link[^>]+rel="icon"/i.test(page)) page = page.replace('</head>', FAVICON_LINK + '\n</head>');
  // Desktop scope/help is not a promise the browser build can make.
  page = page.replace('Appearance <em>(all windows)</em>', 'Appearance')
    .replace('System color paints the title bar and menus. ', '');
  const styles = (mounts.styles || []).map((s) => `<link rel="stylesheet" href="${s}">\n`).join('');
  const scripts = (mounts.scripts || []).map((s) => `<script type="module" src="${s}"></script>\n`).join('');
  page = page.replace('</head>', styles + '</head>').replace('</body>', scripts + '</body>');
  return page;
}

const MODULE_CLASSES = new Set(['cli-manager', 'status-monitor', 'concierge', 'workrooms', 'tool', 'widget']);
/** The bundled-module catalog the renderer boots with: main.js scanModules() for the modules the web build ships
 *  (web/features.json "modules"). Same fields, same checks; `url` is relative to the page and made absolute at init. */
export function moduleCatalog(rootDir, ids) {
  const manifestCheck = require(path.join(rootDir, 'src', 'module-manifest.js'));
  const out = [];
  for (const id of ids) {
    const mdir = path.join(rootDir, 'modules', id);
    const man = readJson(path.join(mdir, 'module.json'));
    if (!man || man.id !== id || !MODULE_CLASSES.has(man.class)) throw new Error('web module is missing or invalid: ' + id);
    // the module host (slice 8): a tool carries its checked tool part and actions, a widget its widget part, exactly as
    // main.js scanModules() gives them; a manifest that fails its check fails the build, loud
    let tool = null, widget = null;
    if (man.class === 'tool') {
      const t = manifestCheck.checkToolManifest(man);
      if (!t.ok) throw new Error('web module ' + id + ': ' + t.reason);
      const adoc = readJson(path.join(mdir, t.tool.actions));
      const ac = adoc ? manifestCheck.checkActions(adoc, t.tool) : { ok: false, reason: t.tool.actions + ' is missing or not JSON' };
      if (!ac.ok) throw new Error('web module ' + id + ': ' + ac.reason);
      tool = { ...t.tool, actions: ac.actions };
      // an attachment tool's claims (the design notes R1.1): which files it opens, checked as the page matches them
      if (man.claims !== undefined) {
        if (!t.tool.contexts.includes('message-attachment')) throw new Error('web module ' + id + ': claims are for the message-attachment context');
        const cc = checkClaims(man.claims);
        if (!cc.ok) throw new Error('web module ' + id + ': ' + cc.reason);
        tool.claims = man.claims;
      }
    }
    if (man.class === 'widget') {
      const w = manifestCheck.checkWidgetManifest(man);
      if (!w.ok) throw new Error('web module ' + id + ': ' + w.reason);
      widget = w.widget;
    }
    const schemaPath = typeof man.settings === 'string' && manifestCheck.relpathOk(man.settings) ? path.join(mdir, man.settings) : null;
    const schema = schemaPath && fs.existsSync(schemaPath) ? readJson(schemaPath) : null;
    out.push({
      id: man.id, name: String(man.name || man.id).slice(0, 60), version: String(man.version || '0'), description: String(man.description || '').slice(0, 300),
      class: man.class, parent: typeof man.parent === 'string' ? man.parent : null,
      icon: typeof man.icon === 'string' && /^[a-z0-9_]{1,40}$/.test(man.icon) ? man.icon : 'extension',
      entry: typeof man.entry === 'string' && manifestCheck.relpathOk(man.entry) ? man.entry : null,
      main: typeof man.main === 'string' && manifestCheck.relpathOk(man.main) ? man.main : null,
      settingsSchema: schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null,
      permissions: Array.isArray(man.permissions) ? man.permissions.filter((x) => typeof x === 'string') : [],
      requires: Array.isArray(man.requires) ? man.requires.filter((x) => typeof x === 'string') : [],
      core: man.core === true, defaultEnabled: man.enabled !== false, source: 'bundled', url: `modules/${id}/`, error: null, tool,
      ...(widget ? { widget } : {}),
    });
  }
  return out;
}

function walk(dir, list = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, list); else list.push(full);
  }
  return list;
}

/** Relative references inside a JS or CSS file that point outside src/renderer (imports, url(), @import). */
function relativeRefs(file, text) {
  const refs = new Set();
  const add = (spec) => { if (spec && spec.startsWith('.')) refs.add(path.resolve(path.dirname(file), spec.split('?')[0].split('#')[0])); };
  if (/\.(?:m?js)$/.test(file)) {
    for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
  } else if (/\.html$/.test(file)) {
    for (const m of text.matchAll(/\b(?:href|src)="([^"#]+)"/g)) if (!/^[a-z][a-z0-9+.-]*:/i.test(m[1])) add(m[1]);
  } else if (/\.css$/.test(file)) {
    for (const m of text.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)) add(m[2]);
    for (const m of text.matchAll(/@import\s*(?:url\()?\s*['"]([^'"]+)['"]/g)) add(m[1]);
  }
  return [...refs];
}

/** Every file the build READS but does not copy as itself (index.html is transformed, the JSON configs and the build code shape the output).
 *  With the copied files and wb-web.js's esbuild inputs it is the complete source closure of the bundle (--inputs). */
export const BUILD_ONLY_INPUTS = ['package.json', 'package-lock.json', 'scripts/web/build-web.mjs', 'src/module-manifest.js', 'src/renderer/index.html',
  'web/csp.json', 'web/mounts.json', 'web/features.json'];

export async function build({ out, nm, sourceCommit, inputs } = {}) {
  if (sourceCommit !== undefined && !/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('--source-commit takes a full 40-character commit hash');
  if (inputs !== undefined && !inputs) throw new Error('--inputs takes a file path');
  const esbuild = loadEsbuild();
  const pkg = readJson(path.join(root, 'package.json'));
  const csp = readJson(path.join(web, 'csp.json'));
  const mounts = readJson(path.join(web, 'mounts.json'));
  const features = readJson(path.join(web, 'features.json'));
  const outDir = path.resolve(root, out || 'dist-web/web-app');
  const nodeModules = path.resolve(nm || process.env.WB_NODE_MODULES || path.join(root, 'node_modules'));
  fs.mkdirSync(outDir, { recursive: true });

  // 1. static files: all of src/renderer, then whatever they reference outside it, until nothing new appears
  const catalog = moduleCatalog(root, features.modules || []);
  const queue = walk(path.join(root, 'src', 'renderer'));
  for (const m of catalog) queue.push(...walk(path.join(root, 'modules', m.id)));
  const copied = new Map(); // relative path in the bundle -> source file
  const fromRoot = (file) => path.relative(root, file).split(path.sep).join('/');
  const sourceFor = (abs) => {
    if (fs.existsSync(abs)) return abs;
    const rel = path.relative(root, abs);
    if (rel.startsWith('node_modules' + path.sep)) {
      const alt = path.join(nodeModules, rel.slice('node_modules'.length + 1));
      if (fs.existsSync(alt)) return alt;
    }
    return null;
  };
  while (queue.length) {
    const abs = queue.pop();
    const rel = fromRoot(abs);
    if (copied.has(rel)) continue;
    const src = sourceFor(abs);
    if (!src) throw new Error('referenced file is missing: ' + rel);
    copied.set(rel, src);
    if (/\.(?:m?js|css|html)$/.test(abs)) for (const ref of relativeRefs(abs, fs.readFileSync(src, 'utf8'))) queue.push(ref);
  }
  // the xterm files index.html loads by <script>/<link>
  for (const rel of ['node_modules/@xterm/xterm/css/xterm.css', 'node_modules/@xterm/xterm/lib/xterm.js',
    'node_modules/@xterm/addon-fit/lib/addon-fit.js', 'node_modules/@xterm/addon-serialize/lib/addon-serialize.js']) {
    const src = sourceFor(path.join(root, rel));
    if (!src) throw new Error('xterm file missing (set --nm): ' + rel);
    copied.set(rel, src);
  }
  const files = {};
  for (const [rel, src] of copied) {
    if (rel === 'src/renderer/index.html') continue;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    files[rel] = fs.readFileSync(dest);
  }
  // 2. index.html
  const html = transformIndex(fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8'), { csp, mounts });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  files['index.html'] = Buffer.from(html);

  // 3. wb-web.js: the real preload and the real rooms core, behind web/shims
  const shim = (n) => path.join(web, 'shims', n);
  const aliases = { electron: 'electron.js', fs: 'fs.js', 'node:fs': 'fs.js', path: 'path.js', 'node:path': 'path.js', ws: 'ws.js',
    crypto: 'crypto.js', 'node:crypto': 'crypto.js', http: 'empty.js', https: 'empty.js' };
  const plugin = {
    name: 'web-shims',
    setup(b) {
      b.onResolve({ filter: /^(?:electron|fs|node:fs|path|node:path|ws|crypto|node:crypto|http|https)$/ }, (a) => ({ path: shim(aliases[a.path]) }));
      b.onResolve({ filter: /^rooms-scoped$/ }, () => ({ path: path.join(root, 'src', 'rooms', 'scoped.js') }));
      b.onResolve({ filter: /^client-real$/ }, () => ({ path: path.join(root, 'src', 'rooms', 'client.js') }));
      b.onResolve({ filter: /^\.\/client(?:\.js)?$/ }, (a) => (a.importer === path.join(root, 'src', 'rooms', 'index.js') ? { path: path.join(web, 'client-web.js') } : undefined));
    },
  };
  const handlerFiles = fs.readdirSync(path.join(web, 'handlers')).filter((f) => f.endsWith('.js')).sort();
  const ordered = ['platform.js', 'rooms.js', ...handlerFiles.filter((f) => f !== 'platform.js' && f !== 'rooms.js')].filter((f) => handlerFiles.includes(f));
  const entry = [
    // the ENGINE says whether this browser is signed in (the marker only follows it), and the page's localStorage becomes the
    // per-person facade (cleared on sign-out), both BEFORE the rooms core or any app code reads storage
    `const probe = require(${JSON.stringify(path.join(web, 'session-probe.js'))});`,
    `const answer = probe.askEngine();`,
    `globalThis.__wbPersonStorage = require(${JSON.stringify(path.join(web, 'person-storage.js'))}).install({ answer });`,
    `probe.syncMarker({ answer, fs: require('fs') });`,
    `require(${JSON.stringify(path.join(root, 'src', 'preload.js'))});`,
    `const rt = require(${JSON.stringify(path.join(web, 'runtime.js'))});`,
    `rt.boot([${ordered.map((f) => `require(${JSON.stringify(path.join(web, 'handlers', f))}).register`).join(', ')}]);`,
  ].join('\n');
  const meta = { version: pkg.version, argv: features.argv, modules: catalog };
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'wb-web-entry.js' },
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'warning',
    plugins: [plugin], inject: [shim('globals.js')], banner: { js: `globalThis.__WB_WEB__ = ${JSON.stringify(meta)};` },
    legalComments: 'none', metafile: true, // the metafile names wb-web.js's inputs; it changes no output byte
  });
  const bundle = Buffer.from(result.outputFiles[0].contents);
  fs.writeFileSync(path.join(outDir, 'wb-web.js'), bundle);
  files['wb-web.js'] = bundle;

  // 3b. csp.json at the bundle root: the engine reads the policy from the app dir (it checks its own floor and scopes script-src itself)
  const cspFile = fs.readFileSync(path.join(web, 'csp.json'));
  fs.writeFileSync(path.join(outDir, 'csp.json'), cspFile);
  files['csp.json'] = cspFile;

  // 4. the manifest: version, source commit, the CSP, and a hash for every file
  // --source-commit names the commit the source came from when the tree is not that checkout (a source export); without it, git HEAD as before
  let commit = sourceCommit || '';
  if (!commit) try { commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (e) { /* not a checkout */ }
  const manifest = { version: pkg.version, sourceCommit: commit, csp: csp.header, cspMeta: csp.meta,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, buf]) => [rel, { sha256: sha256(buf), bytes: buf.length }])) };
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 1) + '\n');

  // 5. (--inputs only) the source closure, written OUTSIDE the bundle so the bundle's bytes and MANIFEST are the same with or without it:
  //    each copied file's source, wb-web.js's esbuild inputs (the metafile, kept beside it) and the build-only inputs, as paths from the repo root
  let inputsFile = null;
  if (inputs) {
    inputsFile = path.resolve(inputs);
    const rel = path.relative(outDir, inputsFile);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('--inputs must be outside the bundle folder');
    const posix = (p) => p.split(path.sep).join('/');
    const fromSource = (src) => {
      const r = path.relative(root, src);
      if (!r.startsWith('..') && !path.isAbsolute(r)) return posix(r);
      return 'node_modules/' + posix(path.relative(nodeModules, src)); // a file read from --nm keeps its node_modules path
    };
    const copiedFrom = Object.fromEntries([...copied].filter(([r]) => r !== 'src/renderer/index.html').sort(([a], [b]) => (a < b ? -1 : 1)).map(([r, src]) => [r, fromSource(src)]));
    // the entry is generated above (stdin, named wb-web-entry.js), not a file: it is not a source input
    const bundledFrom = Object.keys(result.metafile.inputs).filter((k) => k !== '<stdin>' && k !== 'wb-web-entry.js')
      .map((k) => posix(path.relative(root, path.resolve(process.cwd(), k)))).sort();
    const xtermVersions = Object.fromEntries(['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-serialize'].map((p) => [p, readJson(path.join(nodeModules, p, 'package.json')).version]));
    const doc = { format: 'workbench-web-build-inputs', formatVersion: 1, version: pkg.version, sourceCommit: commit, node: process.version,
      esbuild: esbuild.version, packages: xtermVersions, buildOnly: BUILD_ONLY_INPUTS, copied: copiedFrom, bundled: bundledFrom,
      manifestSha256: sha256(fs.readFileSync(path.join(outDir, 'MANIFEST.json'))) };
    fs.mkdirSync(path.dirname(inputsFile), { recursive: true });
    fs.writeFileSync(inputsFile, JSON.stringify(doc, null, 1) + '\n');
    fs.writeFileSync(inputsFile.replace(/(\.json)?$/, '.metafile.json'), JSON.stringify(result.metafile) + '\n');
  }
  return { outDir, files: Object.keys(files).length, bundleBytes: bundle.length, manifest, inputsFile };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const r = await build({ out: arg('--out'), nm: arg('--nm'), sourceCommit: arg('--source-commit'), inputs: arg('--inputs') });
  console.log(JSON.stringify({ out: r.outDir, files: r.files, wbWebBytes: r.bundleBytes, ...(r.inputsFile ? { inputs: r.inputsFile } : {}) }));
}
