/**
 * The SHIPPED handbook (docs/handbook): every topic in manifest.json is served by the bt handbook tool, byte for byte, and nothing else is. The H1 retrieval proof on the vendored bytes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const hb = await import('../src/engine/handbook.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };
const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'docs', 'handbook');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
delete process.env.HARBOR_WB_HANDBOOK_DIR;

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { topics: { id: string; path: string; title: string }[] };
const ids = manifest.topics.map((t) => t.id).sort();
const listed = hb.topics();
ok(manifest.topics.length === 9 && ids.join() === listed.map((t) => t.topic).join(), `the tool lists exactly the manifest's topics (${ids.join(', ')})`);
ok(manifest.topics.every((t) => t.path === `${t.id}.md`), 'every manifest path is <id>.md');
for (const t of manifest.topics) {
  const file = readFileSync(join(dir, t.path));
  const got = hb.read(t.id);
  ok(!!got && !got.truncated && sha(got.text) === sha(file), `${t.id}: served byte for byte (sha256 ${sha(file).slice(0, 12)}), ${file.length} bytes`);
  ok(file.length < hb.MAX_BYTES, `${t.id}: under the ${hb.MAX_BYTES} byte cap`);
}
ok(hb.read('manifest') === null, 'manifest.json is not a topic');
ok(readdirSync(dir).filter((n) => n.endsWith('.md')).length === 9, 'only the nine topic files ship');
ok(!existsSync(join(dir, '..', 'handbook-review')), 'docs/handbook-review is NOT shipped');
const all = manifest.topics.map((t) => readFileSync(join(dir, t.path), 'utf8')).join('\n');
ok(!/\/opt\/|\/home\/|homeserver|tailscale|\.ts\.net|svc-ops|homelab|vrpc|homebase\b/i.test(all), 'no internal host, path or homelab name in the shipped text');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
