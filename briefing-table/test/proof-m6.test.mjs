/** M6: execute the corpus after BOTH actual sanitization paths, without a CSP masking bugs. */
import { chromium } from 'playwright';
import { proof, scratchEngine } from './_hosting-proof.mjs';
import { svgCorpus, benignSvg } from './fixtures/proof-svg-corpus.mjs';
await proof('M6', async check => {
  const engine = await scratchEngine();
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.WB_PROOF_BROWSER_EXECUTABLE ? { executablePath: process.env.WB_PROOF_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext();
    await context.addCookies(engine.cookie.split('; ').map(pair => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: engine.base })));
    await context.route('**/*', route => route.request().url().startsWith(engine.base + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.route(engine.base + '/__proof_document', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto(engine.base + '/__proof_document');
    await page.addScriptTag({ url: engine.base + '/vendor/dompurify/purify.min.js' });
    const client = await page.evaluate(async input => {
      const { sanitizeSvg } = await import('/logo-modal.mjs');
      return input.map(svg => sanitizeSvg(svg));
    }, [benignSvg, ...svgCorpus.map(item => item.svg)]);
    check(typeof client[0] === 'string' && client[0].includes('<path'), 'actual client sanitizer retains benign SVG drawing');
    const serverBenign = await engine.request('/api/logos', { method: 'POST', value: { name: 'benign-proof', svg: benignSvg } });
    check(serverBenign.status === 200 && serverBenign.body?.logo?.svg?.includes('<path'), 'actual server storage retains benign SVG drawing');
    async function execute(svg) {
      const rendering = await browser.newPage();
      try {
        // No engine CSP here: a lost sanitizer must make this proof fail.
        await rendering.route('**/*', route => route.abort());
        await rendering.evaluate(value => { window.__proofXss = 0; document.body.innerHTML = value; }, svg);
        await rendering.waitForTimeout(100);
        const link = rendering.locator('a').first();
        if (await link.count()) await link.click({ timeout: 1000 });
        await rendering.waitForTimeout(100);
        return await rendering.evaluate(() => window.__proofXss);
      } finally { await rendering.close(); }
    }
    check(await execute(svgCorpus[0].svg) > 0, 'unsanitized foreignObject attack executes (browser positive control)');
    check(await execute(svgCorpus[1].svg) > 0, 'unsanitized javascript link executes (browser positive control)');
    for (let i = 0; i < svgCorpus.length; i++) {
      const payload = svgCorpus[i];
      check(await execute(client[i + 1]) === 0, `client ${payload.name} cannot execute`);
      const stored = await engine.request('/api/logos', { method: 'POST', value: { name: payload.name, svg: payload.svg } });
      if ([400, 422].includes(stored.status)) check(true, `server rejects ${payload.name}`);
      else {
        check(stored.status === 200 && typeof stored.body?.logo?.svg === 'string', `server ${payload.name} returns actual stored markup`);
        if (stored.status === 200 && typeof stored.body?.logo?.svg === 'string') check(await execute(stored.body.logo.svg) === 0, `server ${payload.name} cannot execute`);
      }
    }
  } finally { await browser?.close(); await engine.close(); }
});
