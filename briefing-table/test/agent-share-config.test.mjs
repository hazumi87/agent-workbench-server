// The file store has no default address: unset means "not set up", said clearly, never a fallback to another network.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';


// The repo's suite runner wants a closing "PASS n FAIL m" line, so these run through a tiny counter.
const queue = [];
let after = () => {};
const test = (name, fn) => queue.push([name, fn]);
test.after = (fn) => { after = fn; };

const share = await import(pathToFileURL(resolve(process.env.SHARE_MODULE || 'src/engine/agent-share.ts')).href);
const KEY = 'HARBOR_WB_AGENT_SHARE_URL';
const was = process.env[KEY];
const set = (v) => (v === undefined ? delete process.env[KEY] : (process.env[KEY] = v));

test('unset or blank: shareBase throws ShareNotConfigured naming the setting; no author address appears anywhere', () => {
  for (const v of [undefined, '', '   ']) {
    set(v);
    assert.throws(() => share.shareBase(), (e) => e instanceof share.ShareNotConfigured && /HARBOR_WB_AGENT_SHARE_URL/.test(e.message) && /asset-store\.md/.test(e.message) && !/100\.108|8215/.test(e.message));
    assert.equal(share.shareConfigured(), false);
  }
});

test('not an http(s) address: refused with its own reason', () => {
  for (const v of ['not a url', 'ftp://x.example.com', 'file:///etc']) {
    set(v);
    assert.throws(() => share.shareBase(), share.ShareNotConfigured, v);
  }
});

test('a good address is used as is, trailing slashes trimmed; refUrl and folderUrl build on it', () => {
  set('http://127.0.0.1:9000///');
  assert.equal(share.shareBase(), 'http://127.0.0.1:9000');
  assert.equal(share.shareConfigured(), true);
  assert.equal(share.refUrl('rooms/a b/x.png'), 'http://127.0.0.1:9000/raw/rooms/a%20b/x.png');
  assert.equal(share.folderUrl('rooms/r1'), 'http://127.0.0.1:9000/rooms/r1/');
});

test('unset: upload and move answer 503 with the clear message and make no network call; refUrl and fetchRaw throw it', async () => {
  set(undefined);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('should not be called'); };
  try {
    const u = await share.upload('rooms/r1', 'a.txt', 'text/plain', Buffer.from('hi'));
    assert.ok(!u.ok && u.status === 503 && u.field === 'file-store' && /not set up/.test(u.error), JSON.stringify(u));
    const m = await share.move('rooms/r1/a.txt', 'rooms/_removed');
    assert.ok(!m.ok && m.status === 503 && /not set up/.test(m.error), JSON.stringify(m));
    assert.throws(() => share.refUrl('rooms/r1/a.txt'), share.ShareNotConfigured);
    await assert.rejects(share.fetchRaw('rooms/r1/a.txt', 'GET'), share.ShareNotConfigured);
    await assert.rejects(share.list('rooms/r1'), share.ShareNotConfigured);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});


test('the person-set address (/set store) is used when the variable is unset; the variable wins; a bad stored one is refused', () => {
  set(undefined);
  share.setStoredBase(() => 'http://100.64.0.1:8215');
  assert.equal(share.shareBase(), 'http://100.64.0.1:8215');
  assert.equal(share.shareConfigured(), true);
  assert.equal(share.shareSource(), 'setting');
  set('http://127.0.0.1:9000');
  assert.equal(share.shareBase(), 'http://127.0.0.1:9000');
  assert.equal(share.shareSource(), 'env');
  set(undefined);
  share.setStoredBase(() => 'ftp://nope.example');
  assert.throws(() => share.shareBase(), (e) => e instanceof share.ShareNotConfigured && /set with \/set store must start with http/.test(e.message), 'a stored non-http address is refused with its own reason');
  share.setStoredBase(() => null);
  assert.equal(share.shareSource(), 'none');
  assert.throws(() => share.shareBase(), share.ShareNotConfigured);
  assert.match(new share.ShareNotConfigured().message, /\/set store <address>/, 'the message names the command');
});

test('parseShareAddress: http(s) only, trailing slashes trimmed, never throws', () => {
  assert.deepEqual(share.parseShareAddress(' http://h:1// '), { ok: true, base: 'http://h:1' });
  assert.equal(share.parseShareAddress('nope').ok, false);
  assert.equal(share.parseShareAddress('file:///x').ok, false);
});

test.after(() => set(was));

let pass = 0;
let fail = 0;
for (const [name, fn] of queue) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}
after();
console.log(`\nPASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
