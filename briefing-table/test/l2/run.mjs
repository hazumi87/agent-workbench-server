import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { startProofEngine } from './strict-hosted-fixture.mjs';
import { proveViewerL2 } from './proof-viewer-l2.mjs';
const require = createRequire(import.meta.url);
const results = [], started = Date.now();
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300), kind: 'new-surface', baseline: null });
let browser, engine;
try {
  const appDir = path.resolve(process.env.WB_PROOF_BUILT_APP || '');
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'MANIFEST.json'), 'utf8'));
  if (!process.env.WB_PROOF_APP_PIN || manifest.sourceCommit !== process.env.WB_PROOF_APP_PIN) throw Error('Exact frozen Client pin required');
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const file = path.resolve(appDir, rel);
    if (!file.startsWith(appDir + path.sep) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256) throw Error('Built Client manifest mismatch');
  }
  const { chromium } = require(process.env.WB_PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  if (Number(browser.version().split('.')[0]) !== 148) throw Error('Chromium148 required');
  engine = await startProofEngine({ engineRoot: process.env.WB_LOCAL_ENGINE_ROOT, appDir, setupComplete: true });
  const context = await browser.newContext();
  const app = await context.newPage(); app.setDefaultTimeout(10000);
  await app.goto(engine.base + '/login?next=/app/', { waitUntil: 'load' });
  await app.locator('#username').fill(engine.username); await app.locator('#password').fill(engine.password);
  await Promise.all([app.waitForURL(url => url.pathname.startsWith('/app')), app.locator('button[type="submit"]').click()]);
  await app.waitForFunction(() => window.__wbWeb?.ready === true);
  await app.waitForFunction(async () => (await window.wb.rooms.status()).signedIn === true);
  const cookie = (await context.cookies()).map(c => c.name + '=' + c.value).join('; ');
  console.log('PROFILE strict-hosted-server; offset2000; app=' + manifest.sourceCommit + '; engine=' + process.env.WB_PROOF_ENGINE_PIN + '; browser=' + browser.version() + '; existing-person/setup-complete');
  await proveViewerL2({ app, context, base: engine.base, cookie, check });
} catch (error) {
  check('L2.completed', false, String(error?.message || error));
} finally {
  await browser?.close(); await engine?.stop();
}
for (const item of results) console.log((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.detail ? ' :: ' + item.detail : ''));
const passed = results.filter(r => r.ok).length, failed = results.filter(r => !r.ok).length;
console.log(JSON.stringify({ kind: 'new-surface', baseline: null, results, duration_ms: Date.now() - started }));
console.log(`PASS ${passed} FAIL ${failed}`);
process.exitCode = failed || !passed ? 1 : 0;
