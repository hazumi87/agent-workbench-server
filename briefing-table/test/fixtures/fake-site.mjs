/* A stand-in for the hosted install's `site` command (remote-ops), for test/basic-real.probe.mjs ONLY.
 *   node fake-site.mjs new <name>   cwd = the sites dir: makes <slug>/ with .site.json, prints a line
 *   node fake-site.mjs status       cwd = a project dir: prints the remote-ops TEXT form of `site status`
 * State is files the probe can flip: <dir>/.published (public yes), <dir>/.dirty (unsaved changes). */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const slugify = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
if (cmd === 'new') {
  const name = rest.join(' ');
  const slug = slugify(name);
  const dir = join(process.cwd(), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.site.json'), JSON.stringify({ slug, id: 'abcdefghijklmn', name, public: false }));
  console.log(`created ${slug}`);
} else if (cmd === 'status') {
  const meta = JSON.parse(readFileSync(join(process.cwd(), '.site.json'), 'utf8'));
  const pub = existsSync(join(process.cwd(), '.published'));
  console.log(`preview (private, tailnet only): https://preview.example/${meta.slug}`);
  console.log(pub ? 'PUBLIC: yes, since 2026-10-07T23:13:00Z' : 'PUBLIC: no (private)');
  if (pub) { console.log(`public link: https://${meta.slug}.example`); }
  if (existsSync(join(process.cwd(), '.dirty'))) { console.log('unsaved changes: yes'); }
} else {
  console.error(`fake-site: unknown command ${cmd}`);
  process.exit(2);
}
