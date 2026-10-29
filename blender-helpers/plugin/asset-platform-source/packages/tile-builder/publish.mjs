#!/usr/bin/env node
// Publish a tile to the Library: node publish.mjs <composition.json> --set tint|hue|colour --category <family> --subject <word> --density quiet|busy [--theme dark|light|any]
//   [--parent <asset id>] [--name <file base>]
// Renders the composition, uploads the full-size tile labelled `bg tile · <set> · <category> · <subject> · <density>` (the seamless-tiles skill;
// category = the subject family: animals, biomes, objects, geometric, moods, road-signs, textures; --theme = the room theme it suits, kept in meta), and keeps the composition
// JSON on the asset as its derived_op ({tool:'tile-builder', op:'compose', params:{composition}}), so the tile can be re-edited and replayed.
// Prints {id, label, url, stats, warnings}. The Library is TILE_LIBRARY_URL (default the local gateway).
import fs from 'node:fs';
import path from 'node:path';
import { renderTile, stats } from './lib/render.mjs';

const LIBRARY = (process.env.TILE_LIBRARY_URL || 'http://127.0.0.1:8260/asset-management/library/api').replace(/\/$/, '');
const SETS = ['tint', 'hue', 'colour'], THEMES = ['dark', 'light', 'any'], DENSITIES = ['quiet', 'busy'];
const CATEGORIES = ['animals', 'biomes', 'objects', 'geometric', 'moods', 'road-signs', 'textures'];

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; return args.splice(i, 2)[1]; };
const set = opt('--set'), theme = opt('--theme', 'any'), category = opt('--category'), subject = opt('--subject'), density = opt('--density');
const parent = opt('--parent'), name0 = opt('--name');
const file = args[0];
const bad = (m) => { console.error(m); process.exit(2); };
if (!file) bad('usage: node publish.mjs <composition.json> --set tint|hue|colour --category <family> --subject <word> --density quiet|busy [--theme dark|light|any] [--parent id] [--name base]');
if (!SETS.includes(set)) bad(`--set must be one of ${SETS.join(', ')}`);
if (!THEMES.includes(theme)) bad(`--theme must be one of ${THEMES.join(', ')}`);
if (!CATEGORIES.includes(category)) bad(`--category must be one of ${CATEGORIES.join(', ')}`);
if (!subject || /[·\n]/.test(subject)) bad('--subject is required (one short word or phrase)');
if (!DENSITIES.includes(density)) bad(`--density must be one of ${DENSITIES.join(', ')}`);

const comp = JSON.parse(fs.readFileSync(file, 'utf8'));
const tile = await renderTile(comp, path.dirname(path.resolve(file)));
const st = await stats(tile);
const warnings = [];
if (set === 'tint' && !st.tint_set_ok) warnings.push(`not a valid tint tile: grey ${st.p1_grey_pct}-${st.p99_grey_pct}% (mean ${st.mean_grey_pct}%), chroma ${st.mean_chroma_pct}% — a tint tile is greyscale within 35-65%, mean about 50%`);
const local = [...new Set((comp.elements || []).map(e => e.src).filter(s => !/^(https?:\/\/|library:)/.test(s)))];
if (local.length) warnings.push(`elements from local files (${local.join(', ')}) cannot be re-rendered from the Library copy; use library:<id> sources`);

const label = `bg tile · ${set} · ${category} · ${subject} · ${density}`;
const base = name0 || `${subject}-${density}-${set}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const w = comp.w ?? 1024;
const form = new FormData();
form.set('file', new Blob([tile], { type: 'image/png' }), `${base}-${w}.png`);
form.set('label', label);
form.set('source', 'tile-builder');
form.set('subtype', 'image');
if (parent) form.set('parent_id', parent);
form.set('derived_op', JSON.stringify({ tool: 'tile-builder', op: 'compose', params: { composition: comp } }));
form.set('meta', JSON.stringify({ bg_tile: { set, category, theme, subject, density, w, h: comp.h ?? 1024, ...st } }));
const r = await fetch(`${LIBRARY}/assets/upload`, { method: 'POST', body: form });
const j = await r.json().catch(() => ({}));
if (!r.ok || !j.asset) { console.error(`upload failed: HTTP ${r.status} ${JSON.stringify(j)}`); process.exit(1); }
console.log(JSON.stringify({ id: j.asset.id, label, url: `${LIBRARY}/assets/${j.asset.id}/file`, stats: st, warnings }, null, 2));
