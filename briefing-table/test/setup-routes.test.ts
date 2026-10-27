/** installedState: three answers. true when found; null (cannot tell, with a reason) in a split-account setup; false only when the search was complete. */
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HARBOR_WB_TABLE = join(mkdtempSync(join(tmpdir(), 'wb-setup-')), 'mapping.db');
const { installedState, AGENT_VENDORS } = await import('../src/server/setup-routes.ts');
let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
ok(installedState('sh').installed === true, 'found: true');
ok(installedState('nope-not-installed-xyz').installed === false, 'not found, same account: false');
const split = installedState('nope-not-installed-xyz', { ...process.env, HARBOR_WB_PANE_TOKEN_DELIVERY: 'env' });
ok(split.installed === null && /different account/.test(split.reason ?? ''), 'not found, split accounts: null with a reason (never a false "not installed")');
ok(installedState('sh', { ...process.env, HARBOR_WB_PANE_TOKEN_DELIVERY: 'env' }).installed === true, 'found stays true in a split setup');
ok(AGENT_VENDORS.every((v) => v.signIn[0] === v.bin && v.signIn.every((a) => /^[a-z-]+$/.test(a))), 'every sign-in entry is a fixed plain argv starting with its own program');
{
  /* the trust list is keyed on the REAL path: a symlinked launch path matches, an unlisted folder does not */
  const { table } = await import('../src/table/endpoint.ts');
  const { isFolderTrusted } = await import('../src/server/settings-routes.ts');
  const base = mkdtempSync(join(tmpdir(), 'wb-trust-'));
  mkdirSync(join(base, 'real'));
  mkdirSync(join(base, 'other'));
  symlinkSync(join(base, 'real'), join(base, 'link'));
  table.setEngineSetting('folderTrust', { folders: [{ path: realpathSync(join(base, 'real')), trustedAt: 1, by: null }] });
  ok(isFolderTrusted(join(base, 'real')) && isFolderTrusted(join(base, 'link')) && isFolderTrusted(join(base, 'real', 'sub')), 'a listed folder, a symlink to it and a child are trusted');
  ok(!isFolderTrusted(join(base, 'other')) && !isFolderTrusted(null) && !isFolderTrusted('/'), 'an unlisted folder, none and / are not');
}
console.log('\n[the engine profile the page keys on: hosted + bareShell, additive]');
{
  const { handle } = await import('../src/server/setup-routes.ts');
  const { Readable } = await import('node:stream');
  const call = async (method: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method; req.url = '/api/settings/setup'; req.headers = { 'content-type': 'application/json' };
    const out: { status: number; json: any } = { status: 0, json: null };
    const res: any = { writeHead(st: number) { out.status = st; }, setHeader() {}, end(x?: string) { try { out.json = JSON.parse(String(x ?? '')); } catch { out.json = null; } } };
    await handle(req, res, '/api/settings/setup', { human: true, dispatch: async () => ({ status: 200, text: '{}' }) });
    return out;
  };
  const prev = process.env.HARBOR_WB_HOSTED;
  delete process.env.HARBOR_WB_HOSTED;
  let r = await call('GET');
  ok(r.status === 200 && r.json.hosted === false && r.json.bareShell === true, 'not hosted: hosted=false, bareShell=true');
  ok('completedAt' in r.json && 'defaultFolder' in r.json, '...and the existing fields are still there');
  process.env.HARBOR_WB_HOSTED = '1';
  r = await call('GET');
  ok(r.status === 200 && r.json.hosted === true && r.json.bareShell === false, 'HOSTED: hosted=true, bareShell=false');
  ok('completedAt' in r.json && 'defaultFolder' in r.json, '...existing fields unchanged');
  r = await call('PUT', { complete: true });
  ok(r.status === 200 && r.json.hosted === true && r.json.bareShell === false && typeof r.json.completedAt === 'number', 'the PUT answer carries the same profile (a page that replaces its state with it keeps the fields)');
  const bad = await call('PUT', { hosted: false, bareShell: true, complete: true });
  const again = await call('GET');
  ok(again.json.hosted === true && again.json.bareShell === false, 'a client cannot set them: they are derived from the engine, not stored');
  if (prev === undefined) delete process.env.HARBOR_WB_HOSTED; else process.env.HARBOR_WB_HOSTED = prev;
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
