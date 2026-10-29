/*
 * Where asset-studio reads its settings — ONE copy, used by the app and the
 * scripts (scripts/lib/tool.mjs).
 *
 *   config    config.example.json, overlaid by config.local.json (git-ignored).
 *             imageGenUrl (asset-platform image-gen API), libraryUrl (the Library
 *             data API), libraryWebUrl (the Library page), shareUrl (file-share), port (0 = ephemeral), engineUrl + engineTokenFile (room
 *             posts, panel registration, binding), defaultBudget.
 *   binding   ~/.local/state/asset-studio/binding.json {room_id, room_name, agent, seat_id, paneid, at}
 *             — the ONE room this app works in (access: exclusive). Written by scripts/bind.sh.
 *             Outside the tool tree on purpose: status/ is group-writable (agents), and `paneid`
 *             is who every room line is posted as. 0600 in a 0700 dir; any other mode reads as unbound.
 *
 * Read on EVERY call (tiny files): a re-bind takes effect without a restart.
 * Env ASSET_STUDIO_IMAGE_GEN_URL / _LIBRARY_URL / _PORT / _STATUS_DIR / _WORK_DIR
 * override (tests). Zero dependencies (node >= 20).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATUS_DIR = process.env.ASSET_STUDIO_STATUS_DIR || path.join(ROOT, 'status');
export const WORK_DIR = process.env.ASSET_STUDIO_WORK_DIR || path.join(ROOT, 'work');
export const BINDING = process.env.ASSET_STUDIO_BINDING || path.join(os.homedir(), '.local', 'state', 'asset-studio', 'binding.json');

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const trimUrl = (u) => (typeof u === 'string' ? u.trim().replace(/\/+$/, '') : '');

export function readConfig() {
  const base = readJson(path.join(ROOT, 'config.example.json')) ?? {};
  const local = readJson(path.join(ROOT, 'config.local.json')) ?? {};
  const cfg = { ...base, ...local };
  cfg.imageGenUrl = trimUrl(process.env.ASSET_STUDIO_IMAGE_GEN_URL || cfg.imageGenUrl);
  cfg.libraryUrl = trimUrl(process.env.ASSET_STUDIO_LIBRARY_URL || cfg.libraryUrl);
  cfg.libraryWebUrl = trimUrl(cfg.libraryWebUrl);
  cfg.shareUrl = trimUrl(process.env.ASSET_STUDIO_SHARE_URL || cfg.shareUrl);   // file-share (the room's files)
  // where color_match stages a file for the Library to index (must be readable by the gateway)
  cfg.libraryStaging = process.env.ASSET_STUDIO_STAGING || cfg.libraryStaging || '';   // the Library page, for the panel's "Open in Library"
  const port = Number(process.env.ASSET_STUDIO_PORT ?? cfg.port);
  cfg.port = Number.isInteger(port) && port >= 0 && port < 65536 ? port : 0;
  const n = Number(cfg.defaultBudget);
  cfg.defaultBudget = Number.isInteger(n) && n > 0 ? n : 12;        // images per room
  // the model domain: the 3D core (asset-platform gateway tool) and the Watch share
  cfg.coreUrl = trimUrl(process.env.ASSET_STUDIO_CORE_URL || cfg.coreUrl);
  cfg.watchBase = trimUrl(process.env.ASSET_STUDIO_WATCH_BASE || cfg.watchBase);
  const m = Number(cfg.defaultModelBudget);
  cfg.defaultModelBudget = Number.isInteger(m) && m > 0 ? m : 5;   // model jobs per room
  return cfg;
}

/* {room_id, room_name, agent, seat_id, paneid, at} or null (not bound to a room yet). */
export function readBinding() {
  try {
    const st = fs.statSync(BINDING);
    if (st.uid !== process.getuid() || st.mode & 0o077) return null;   // fail closed: not ours, or others can touch it
  } catch {
    return null;
  }
  const b = readJson(BINDING);
  return b && typeof b.room_id === 'string' && b.room_id ? b : null;
}

/* The briefing-table engine, for the room's Assets: {url, headers} or {error}. The token
   never leaves this process. Env ASSET_STUDIO_ENGINE_URL / _ENGINE_TOKEN_FILE override (tests). */
export function readEngine() {
  const cfg = readConfig();
  const url = trimUrl(process.env.ASSET_STUDIO_ENGINE_URL || cfg.engineUrl);
  const tokenFile = (process.env.ASSET_STUDIO_ENGINE_TOKEN_FILE || cfg.engineTokenFile || '').trim();
  if (!url || !tokenFile) return { error: 'engineUrl / engineTokenFile not configured' };
  try {
    return { url, headers: { authorization: `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}` } };
  } catch (e) {
    return { error: `cannot read the engine token file (${e.code || e.message})` };
  }
}
