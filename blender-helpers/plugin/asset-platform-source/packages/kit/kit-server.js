// asset-kit — serves the Asset Platform React component kit bundle behind the
// asset-tools gateway, COEXISTING with the vanilla picker.js kit. Built from the
// pnpm monorepo at <repo> (package @asset/kit) → a single
// self-registering IIFE (dist/asset-kit.js, light-DOM Web Components, tokens
// self-injected). Deploy = rebuild there + copy dist/asset-kit.js here.
//
// This tool ONLY static-serves the kit + a smoke page. It does NOT touch any
// backend; ported components (e.g. <asset-clipboard>) talk to the existing
// asset-library/asset-clipboard APIs directly. Decision the design notes;
// the design notes Step 1a (gateway coexistence).
//
// NOTE: this tool dir has NO node_modules (other tools symlink a shared one).
// To avoid coupling the gateway's startup to a fragile symlink, this module
// imports ONLY node built-ins — no `express`. It uses the express `app` the
// gateway passes in (sendFile/get are app methods, not separate deps).
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE = '/asset-management/tools/asset-kit';
const DIST = path.join(__dirname, 'dist');

export async function register(app) {
  // CORS read-only (mirrors asset-library) so the kit bundle can be loaded
  // cross-origin (e.g. the GPU host register page) just like picker.js.
  app.use(BASE, (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // The kit bundle (single self-registering IIFE) + its emitted stylesheet.
  app.get(`${BASE}/asset-kit.js`, (req, res) =>
    res.type('application/javascript').sendFile(path.join(DIST, 'asset-kit.js')));
  app.get(`${BASE}/style.css`, (req, res) =>
    res.type('text/css').sendFile(path.join(DIST, 'style.css')));

  // A tiny smoke page proving the kit loads behind the gateway (the <asset-hello>
  // gate-spike element). Served at the tool root.
  app.get([`${BASE}`, `${BASE}/`], (req, res) =>
    res.sendFile(path.join(__dirname, 'index.html')));
}
