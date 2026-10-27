/**
 * THE LOCAL-MODE MODULES LOAD ON PLAIN NODE (lead order 15993): Node's own type stripping refuses anything that is not erasable TypeScript
 * (constructor parameter properties, enums, namespaces), and test/agent-share-config.test.mjs already loads one of these files that way.
 * A new file that slips one in would pass under tsx and fail there. Each module is imported by a bare `node`, no tsx.
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv } from './_scratch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = ['engine/local-mode.ts', 'engine/local-data.ts', 'engine/memory-cap.ts', 'engine/note-copies.ts', 'engine/local-file-store.ts', 'engine/history-export.ts', 'engine/seed-recipe.ts', 'engine/agent-share.ts'];
let passed = 0;
let failed = 0;
for (const m of MODULES) {
  const url = pathToFileURL(join(ROOT, 'src', m)).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('loaded')`], { env: childEnv(), encoding: 'utf8' });
  const good = r.status === 0 && r.stdout.includes('loaded');
  if (good) {
    passed++;
    console.log(`  ok ${m} loads on plain Node`);
  } else {
    failed++;
    console.log(`  FAIL ${m}: ${(r.stderr || r.stdout).split('\n').find((l) => /Error|ERR_/.test(l)) ?? 'did not load'}`);
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
