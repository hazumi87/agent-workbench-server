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
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
