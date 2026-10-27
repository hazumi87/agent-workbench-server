#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scopes = JSON.parse(fs.readFileSync(path.join(root, 'ci/dependency-scopes.json'), 'utf8'));
const found = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'package-lock.json') found.push(path.relative(root, dir).split(path.sep).join('/'));
  }
}
walk(root);
if (JSON.stringify(found.sort()) !== JSON.stringify(Object.keys(scopes).sort())) throw new Error('Lockfile inventory differs from ci/dependency-scopes.json; classify every added or removed dependency set');
for (const [dir, scope] of Object.entries(scopes)) {
  if (!['server-runtime', 'web-build-and-browser', 'source-input-only'].includes(scope)) throw new Error('Unknown dependency scope');
  if (process.argv.includes('--install') && scope === 'source-input-only') continue;
  console.log(`${dir}\t${scope}`);
}
