/** H5: hosted browser requests meet Origin/Host and JSON gates before mutation. */
import { proof, scratchEngine, upgradeStatus } from './_hosting-proof.mjs';
await proof('H5', async check => {
  const engine = await scratchEngine();
  try {
    const good = await engine.request('/api/logos', { method: 'POST', value: { name: 'proof', svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>' }, headers: { origin: engine.base } });
    check(good.status === 200 && !!good.body?.logo?.id, 'same-origin signed-in JSON creates a logo (positive control)');
    if (!good.body?.logo?.id) throw new Error('Positive control could not establish a mutable resource');
    const path = `/api/logos/${good.body.logo.id}`;
    const createdRoom = await engine.request('/api/rooms', { method: 'POST', value: { name: 'H5 proof room' } });
    const roomId = createdRoom.body?.id ?? createdRoom.body?.room?.id;
    check(createdRoom.status === 200 && !!roomId, 'a disposable room exists for the cross-router matrix');
    if (!roomId) throw new Error('Cannot establish room-router positive control');
    const routerSamples = [
      ['rooms', 'POST', `/api/rooms/${roomId}/line`, { body: 'must-not-be-posted' }],
      ['recipes', 'POST', '/api/recipes', { id: 'cross-origin-proof', name: 'must-not-create', target: 'local', vendor: 'cli-manager' }],
      ['settings', 'PUT', '/api/settings/auto-approve', { default: 'off' }],
      ['identity/account', 'POST', '/account/password', { current: 'wrong-proof-password', next: 'New-proof-only!47' }],
      ['concierge', 'POST', '/api/concierge/signoffs/missing-proof/answer', { answer: 'approve' }],
      ['tasks', 'POST', `/api/rooms/${roomId}/tasks`, { title: 'must-not-create' }],
      ['plugin install', 'POST', '/api/modules/plugins', {}],
    ];
    for (const [router, method, route, value] of routerSamples) {
      const refused = await engine.request(route, { method, value, headers: { origin: 'https://attacker.invalid' } });
      check(refused.status === 403 && /origin/.test(refused.body?.error ?? ''), `${router}: cross-origin mutation is refused before routing; got ${refused.status}`);
      const absent = await engine.request(route, { method, value, headers: { origin: null } });
      check(absent.status === 403 && /origin/.test(absent.body?.error ?? ''), `${router}: cookie mutation without Origin is refused; got ${absent.status}`);
    }
    for (const origin of ['https://attacker.invalid', engine.base.replace('127.0.0.1', 'localhost'), engine.base.replace('http:', 'https:'), 'null']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const result = await engine.request(method === 'POST' ? '/api/logos' : path,
          { method, value: { name: 'must-not-change', svg: '<svg/>' }, headers: { origin } });
        check(result.status === 403, `cross-origin ${method} refused (${origin}); got ${result.status}`);
      }
      check(await upgradeStatus(engine.base, engine.cookie, origin) === 403, `cross-origin WS upgrade refused (${origin})`);
    }
    const absent = await engine.request('/api/logos', { method: 'POST', value: { name: 'missing-origin', svg: '<svg/>' }, headers: { origin: null } });
    check(absent.status === 403, 'cookie mutation without Origin is refused');
    const rebindHeaders = { host: 'attacker.invalid', origin: 'http://attacker.invalid' };
    const rebound = await engine.request('/api/logos', { method: 'POST', value: { name: 'rebound', svg: '<svg/>' }, headers: rebindHeaders });
    check(rebound.status === 421, `matching attacker Origin+Host cannot bypass the configured Host allowlist; got ${rebound.status}`);
    for (const method of ['GET', 'HEAD']) {
      const denied = await engine.request('/health', { method, signedIn: false, headers: rebindHeaders });
      check(denied.status === 421, `unlisted Host is refused on public ${method} before routing; got ${denied.status}`);
    }
    check(await upgradeStatus(engine.base, engine.cookie, 'http://attacker.invalid', '/pty', { host: 'attacker.invalid' }) === 421, 'rebound WS Host is refused before upgrade');
    const crossSite = await engine.request('/api/logos', { method: 'POST', value: { name: 'cross-site', svg: '<svg/>' }, headers: { 'sec-fetch-site': 'cross-site' } });
    check(crossSite.status === 403, 'cross-site fetch metadata is refused even with a matching Origin');
    const after = await engine.request('/api/logos');
    check(after.body?.logos?.length === 1 && after.body.logos[0].name === 'proof', 'cross-origin attempts neither add, alter nor delete data');
    const beforeTypes = await engine.request('/api/logos');
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=proof']) {
      const result = await engine.request('/api/logos', { method: 'POST', raw: JSON.stringify({ name: 'not-json', svg: '<svg/>' }),
        headers: { origin: engine.base, 'content-type': type } });
      check(result.status === 415, `JSON route refuses ${type}`);
    }
    const final = await engine.request('/api/logos');
    check(JSON.stringify(final.body) === JSON.stringify(beforeTypes.body), 'wrong-content-type requests have no effect');
    const sameOrigin = await upgradeStatus(engine.base, engine.cookie, engine.base);
    check(sameOrigin === 101, 'signed-in same-origin WS opens (positive control)');
    const beforeReads = await engine.request('/api/logos');
    for (const method of ['GET', 'HEAD']) await engine.request('/api/logos?action=delete', { method });
    const afterReads = await engine.request('/api/logos');
    check(JSON.stringify(beforeReads.body) === JSON.stringify(afterReads.body), 'GET and HEAD reads do not mutate the protected resource');
    for (const wsPath of ['/term', '/window-agent', '/api/fabric/relay']) {
      const status = await upgradeStatus(engine.base, engine.cookie, 'https://attacker.invalid', wsPath);
      check(status === 403, `${wsPath}: cross-origin upgrade is refused by Origin admission; got ${status}`);
      const rebound = await upgradeStatus(engine.base, engine.cookie, 'http://attacker.invalid', wsPath, { host: 'attacker.invalid' });
      check(rebound === 421, `${wsPath}: unlisted Host is refused before path-specific checks; got ${rebound}`);
    }
    const filePath = `/api/rooms/${roomId}/files/notes/proof.txt`;
    const uploadHeaders = { 'content-type': 'text/plain', 'if-none-match': '*' };
    const raw = await engine.request(filePath, { method: 'PUT', raw: 'safe proof bytes', headers: uploadHeaders });
    check(raw.status === 200, `declared raw-PUT upload accepts same-origin bytes; got ${raw.status}`);
    const read = await engine.request(filePath);
    check(read.status === 200 && read.text === 'safe proof bytes', 'raw upload persists only the expected bytes');
    for (const origin of ['https://attacker.invalid', null]) {
      const rejected = await engine.request(filePath, { method: 'PUT', raw: 'must-not-replace', headers: { ...uploadHeaders, origin } });
      check(rejected.status === 403, 'raw upload exception retains cross-origin and missing-Origin admission');
    }
    const multipartHeaders = { 'content-type': 'multipart/form-data; boundary=proof', 'x-filename': 'proof.multipart' };
    const multipart = '--proof\r\nContent-Disposition: form-data; name="file"; filename="proof.txt"\r\n\r\nsafe proof bytes\r\n--proof--\r\n';
    const uploadPath = `/api/rooms/${roomId}/files/files`;
    const accepted = await engine.request(uploadPath, { method: 'POST', raw: multipart, headers: multipartHeaders });
    check(accepted.status === 200, `declared byte-upload path admits multipart content type same-origin; got ${accepted.status}`);
    for (const origin of ['https://attacker.invalid', null]) {
      const rejected = await engine.request(uploadPath, { method: 'POST', raw: multipart, headers: { ...multipartHeaders, origin } });
      check(rejected.status === 403, 'multipart upload exception retains cross-origin and missing-Origin admission');
    }
  } finally { await engine.close(); }
});
