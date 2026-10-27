/** L2: actual viewer + rooms core + native-browser adapter, with inert engine delivery. */
export async function proveViewerL2({ app, context, base, cookie, check }) {
  const executions = [];
  let phase = 'control';
  await context.exposeBinding('__proofAttachmentExecuted', (_source, label) => executions.push({ phase, label }));
  const control = await context.newPage();
  try {
    await control.setContent(`<script>globalThis.__proofAttachmentExecuted('html')</script><svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.__proofAttachmentExecuted('svg')"></svg>`);
    await control.waitForTimeout(100);
    check('L2.html-execution-positive', executions.some(e => e.phase === 'control' && e.label === 'html'));
    check('L2.svg-execution-positive', executions.some(e => e.phase === 'control' && e.label === 'svg'));
    if (!['html', 'svg'].every(label => executions.some(e => e.phase === 'control' && e.label === label))) throw Error('Both active attachment controls must execute');
  } finally { await control.close(); }
  phase = 'viewer';
  const call = (route, { method = 'GET', body, headers = {} } = {}) => fetch(base + route, { method, headers: { cookie, ...(!['GET','HEAD'].includes(method) ? { origin: base } : {}), ...headers }, body, redirect: 'manual' });
  const made = await call('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Owned L2 viewer proof' }) });
  const room = await made.json();
  const roomId = room.room?.id ?? room.id;
  if (!made.ok || typeof roomId !== 'string') throw Error('Owned real room required for viewer proof');
  const files = [
    { name: 'proof-control.png', type: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64') },
    { name: 'proof-active.svg', type: 'image/svg+xml', body: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.__proofAttachmentExecuted('svg')"><rect width="2" height="2"/></svg>`) },
    { name: 'proof-active.html', type: 'text/html', body: Buffer.from(`<script>globalThis.__proofAttachmentExecuted('html')</script><p>Attachment proof</p>`) },
  ];
  for (const file of files) {
    const upload = await call(`/api/rooms/${encodeURIComponent(roomId)}/assets`, { method: 'POST', headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(file.name) }, body: file.body });
    const answer = await upload.json();
    if (upload.status !== 200 || typeof answer.name !== 'string') throw Error(`Real owned attachment upload required (${upload.status})`);
    file.name = answer.name;
  }
  await app.evaluate(async () => { await window.wb.rooms.list(true); });
  // Import the actual served renderer component; all data and native operations
  // still go through the built app's real wb.rooms facade and rooms core.
  await app.evaluate(async () => {
    const { createViewer } = await import('/app/src/renderer/rooms/viewer.js');
    const viewer = createViewer({ image: (roomId, name) => window.wb.rooms.image(roomId, name).then(r => r && r.ok ? r.value : null), download: (...a) => window.wb.rooms.download(...a), openWindow: (...a) => window.wb.rooms.openWindow(...a) });
    viewer.el.dataset.proofL2 = 'yes'; document.body.append(viewer.el); window.__l2Viewer = viewer;
  });
  const ownedPages = [];
  const observePage = page => ownedPages.push(page);
  context.on('page', observePage);
  try {
    for (const file of files) {
      await app.evaluate(({ roomId, name }) => window.__l2Viewer.open([{ roomId, name, who: 'Proof', ts: Date.now() }], 0), { roomId, name: file.name });
      const selector = '.wr-viewer[data-proof-l2="yes"]';
      await app.waitForFunction(selector => !!document.querySelector(selector + ' img')?.getAttribute('src'), selector, { timeout: 10000 });
      if (file.type === 'image/png') {
        await app.waitForFunction(selector => { const img = document.querySelector(selector + ' img'); return img?.getAttribute('src')?.startsWith('data:image/png') && img.naturalWidth > 0; }, selector, { timeout: 10000 });
        check('L2.raster-viewer-positive', true);
        continue;
      }
      const route = `/api/rooms/${encodeURIComponent(roomId)}/assets/raw/${encodeURIComponent(file.name)}`;
      const raw = await call(route);
      check(`L2.${file.type === 'image/svg+xml' ? 'svg' : 'html'}.raw-inert`, raw.status === 200 && /attachment/i.test(raw.headers.get('content-disposition') || '') && raw.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(raw.headers.get('content-security-policy') || ''), JSON.stringify({ status: raw.status, headers: Object.fromEntries(['content-type','content-disposition','x-content-type-options','content-security-policy'].map(name => [name, raw.headers.get(name)])) }));
      await raw.arrayBuffer();
      let navigated = false;
      const observe = request => { if (request.url() === base + route && request.isNavigationRequest()) navigated = true; };
      context.on('request', observe);
      try {
        await app.locator(selector + ' button[aria-label="Open in a window"]').click();
        for (let i = 0; i < 30 && !navigated; i++) await app.waitForTimeout(100);
        check(`L2.${file.type === 'image/svg+xml' ? 'svg' : 'html'}.open-window-real-route`, navigated);
        await app.waitForTimeout(150);
        check(`L2.${file.type === 'image/svg+xml' ? 'svg' : 'html'}.no-script-execution`, executions.every(e => e.phase !== 'viewer'), JSON.stringify(executions.filter(e => e.phase === 'viewer')));
      } finally { context.off('request', observe); }
    }
  } finally {
    context.off('page', observePage);
    for (const page of ownedPages) if (!page.isClosed()) await page.close();
    await app.evaluate(() => { window.__l2Viewer.hide(); window.__l2Viewer.el.remove(); delete window.__l2Viewer; });
  }
}
