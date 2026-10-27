/**
 * Pre-trusting a Basic user's own folders: merges, never clobbers, refuses what it cannot parse.
 */
import { withTrusted } from '../src/engine/hosted-trust.ts';

let failed = 0;
let total = 0;
const ok = (c: unknown, m: string) => { total++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const dirs = ['/home/u/dev', '/home/u/dev/code/hello-world'];

{
  const r = withTrusted(null, dirs);
  ok(r.ok && r.changed, 'a missing file is created');
  const j = r.ok ? JSON.parse(r.text) : {};
  ok(j.projects?.['/home/u/dev']?.hasTrustDialogAccepted === true && j.projects?.['/home/u/dev/code/hello-world']?.hasTrustDialogAccepted === true, 'both folders are trusted');
}
{
  const cur = JSON.stringify({ userID: 'abc', oauthAccount: { x: 1 }, projects: { '/other': { allowedTools: ['a'], hasTrustDialogAccepted: false }, '/home/u/dev': { history: [1], hasTrustDialogAccepted: false } } });
  const r = withTrusted(cur, dirs);
  const j = r.ok ? JSON.parse(r.text) : {};
  ok(r.ok && r.changed, 'an existing file is updated');
  ok(j.userID === 'abc' && j.oauthAccount?.x === 1, 'every other top-level key survives');
  ok(j.projects['/other'].hasTrustDialogAccepted === false && j.projects['/other'].allowedTools[0] === 'a', 'another project is untouched');
  ok(j.projects['/home/u/dev'].history[0] === 1 && j.projects['/home/u/dev'].hasTrustDialogAccepted === true, 'the folder keeps its other fields and gains trust');
}
{
  const first = withTrusted(null, dirs);
  const again = first.ok ? withTrusted(first.text, dirs) : first;
  ok(again.ok && !again.changed, 'a second run changes nothing');
}
ok(!withTrusted('{not json', dirs).ok, 'invalid JSON is refused, not rewritten');
ok(!withTrusted('[1]', dirs).ok, 'a non-object file is refused');
ok(!withTrusted('{"projects":[]}', dirs).ok, 'a bad "projects" is refused');
ok(!withTrusted('{"projects":{"/home/u/dev":5}}', dirs).ok, 'a bad project entry is refused');
console.log(`PASS ${total - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
