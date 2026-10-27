/** M14: inventory every available HTML response, including configured app/module pages. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { proof, scratchEngine, root } from './_hosting-proof.mjs';
function htmlFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? htmlFiles(path, base) : entry.isFile() && path.endsWith('.html') ? ['/' + relative(base, path).replaceAll('\\', '/')] : [];
  });
}
await proof('M14', async check => {
  const engine = await scratchEngine();
  try {
    const paths = new Set([...htmlFiles(join(root, 'web')), '/', '/login', '/account', '/settings', '/app/', '/app/index.html']);
    for (const path of htmlFiles(engine.appDir)) paths.add('/app' + path);
    const catalog = await engine.request('/api/modules');
    if (catalog.status === 200 && Array.isArray(catalog.body?.modules)) {
      for (const module of catalog.body.modules) {
        const entry = typeof module.ui === 'string' ? module.ui : module.ui?.entry ?? 'index.html';
        if (module.enabled) paths.add(`/app/modules/${encodeURIComponent(module.id)}/ui/${entry}`);
      }
    }
    const extra = JSON.parse(process.env.WB_PROOF_EXTRA_HTML_ROUTES ?? '[]');
    if (!Array.isArray(extra) || extra.some(path => typeof path !== 'string' || !path.startsWith('/'))) throw new Error('Extra HTML inventory must be an array of local paths');
    for (const path of extra) paths.add(path);
    let documents = 0, appDocuments = 0, moduleDocuments = 0;
    for (const path of [...paths].sort()) {
      const response = await engine.request(path);
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) {
        console.log(`INVENTORY ${path}: not an HTML response (${response.status})`);
        continue;
      }
      documents++;
      if (path.startsWith('/app/')) appDocuments++;
      if (/\/modules\/[^/]+\/ui\//.test(path)) moduleDocuments++;
      const csp = response.headers.get('content-security-policy') ?? '';
      check(/(?:^|;)\s*frame-ancestors\s+'self'\s*(?:;|$)/i.test(csp), `${path} frame-ancestors is self only`);
      check(response.headers.get('x-frame-options')?.toUpperCase() === 'SAMEORIGIN', `${path} X-Frame-Options is SAMEORIGIN`);
    }
    check(documents >= 3, 'inventory contains actual served documents (positive control)');
    check(appDocuments >= 3, 'configured app HTML fixtures exercise the actual /app serving path');
    console.log(`INVENTORY html=${documents} app=${appDocuments} module/plugin=${moduleDocuments} catalog=${catalog.status}`);
    // A release with app/module pages must exercise those pages, not merely list
    // their absent routes. Until integration they are explicitly unverified.
    if (!appDocuments) console.log('NOT VERIFIED /app HTML: surface not installed in this engine fixture');
    if (!moduleDocuments) console.log('NOT VERIFIED module/plugin HTML: no enabled surface in this engine fixture');
    // Exercise the shipped manifest through the real app-serving path. Inert
    // HTML isolates the engine floor; this is not an application runtime/sandbox proof.
    const shipped = JSON.parse(readFileSync(new URL('./fixtures/proof-client-csp.json', import.meta.url), 'utf8'));
    const safe = "default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; style-src 'none'; object-src 'none'";
    const cases = [
      ['reviewed Client manifest with ws:/wss:', shipped, false],
      ['manifest missing frame-ancestors', { header: safe.replace("frame-ancestors 'self'; ", '') }, false],
      ['manifest with scheme-only script source', { header: safe.replace("script-src 'self'", "script-src 'self' https:") }, false],
      ['manifest with wildcard connect source', { header: safe.replace("connect-src 'self'", "connect-src 'self' https://*.example.invalid") }, false],
      ['manifest with external script origin', { header: safe.replace("script-src 'self'", "script-src 'self' https://evil.example") }, false],
      ['manifest with unsafe-inline script', { header: safe.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") }, false],
      ['safe manifest', { header: safe }, true],
    ];
    for (const [name, manifest, accepted] of cases) {
      writeFileSync(join(engine.appDir, 'csp.json'), JSON.stringify(manifest));
      const response = await engine.request('/app/index.html');
      const header = response.headers.get('content-security-policy') ?? '';
      const directives = new Map(header.split(';').map(part => part.trim().split(/\s+/)).filter(parts => parts[0]).map(([name, ...sources]) => [name.toLowerCase(), sources]));
      check(response.status === 200 && response.headers.get('content-type')?.includes('text/html'), `${name}: real configured /app HTML is served`);
      check(JSON.stringify(directives.get('frame-ancestors')) === JSON.stringify(["'self'"]), `${name}: framing floor survives shipped manifest`);
      for (const directive of ['connect-src', 'script-src']) {
        const sources = directives.get(directive);
        check(Array.isArray(sources) && sources.length > 0 && sources.every(source => !source.includes('*') && !/^[a-z][a-z0-9+.-]*:$/i.test(source)), `${name}: ${directive} has no wildcard or scheme-only source`);
      }
      // style-src is the observable marker: rejected manifests fall back to
      // the engine default, while the safe manifest must actually be used.
      check((directives.get('style-src')?.join(' ') === "'none'") === accepted, `${name}: ${accepted ? 'accepted' : 'rejected in favor of engine default'}`);
    }

  } finally { await engine.close(); }
});
