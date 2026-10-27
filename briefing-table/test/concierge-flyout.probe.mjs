/**
 * PROBE (not in npm test: needs a browser). The Concierge icon and fly-out in a
 * real Chromium, desktop and phone width: the icon appears when the Concierge is
 * on, opens the fly-out over the agent chat, the reply shows live wb: chips and
 * a dead link as text, the spoken line shows the voice mark, and on a phone the
 * sheet is a full-width bottom sheet with no sideways scroll. Screenshots land
 * in the directory named by PROBE_OUT (default: a temp dir, printed).
 *
 * Her voice (Owner [ref] / [ref]): a fake mic plays six bursts; STT, the Sonnet
 * sandbox and TTS are stubbed, and Owner's note scenario runs in the fly-out:
 * mic + indicator + gear in the header, the settings fly-out, the note card
 * filling in over the chat, her question, and the test-only "Would do" bubble.
 *
 *   node test/concierge-flyout.probe.mjs
 *   CHROMIUM=/path/to/chrome node test/concierge-flyout.probe.mjs
 *
 * A fake transcript is written for the Concierge pane under a temp
 * HARBOR_WB_CLAUDE_PROJECTS, and the engine reads it through a local target
 * (HARBOR_WB_TARGETS), so nothing real is touched.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HOST = '127.0.0.1';
const PORT = P(516);
const DEAD = P(517);
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'concierge-flyout-probe';
const CHROME = process.env.CHROMIUM || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => existsSync(p));

let passed = 0;
let failed = 0;
const ok = (c, m) => {
  (c ? passed++ : failed++);
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) =>
  new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });

/* the fake mic: 48 kHz mono PCM16, six 1 s tone bursts 3.5 s apart */
const BURSTS = [[1, 2], [4.5, 5.5], [8, 9], [11.5, 12.5], [15, 16], [18.5, 19.5]];
function wav(rate, secs, loud) {
  const n = Math.round(rate * secs);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    if (loud(t)) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * t) * 0.5 * 32767), 44 + i * 2);
  }
  return buf;
}

const silent = wav(16000, 0.3, () => false); // the stubbed TTS clip

async function run() {
  const { chromium } = await import('playwright');
  for (const p of [PORT, DEAD]) await assertFree(p, 'concierge-flyout.probe.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'wb-cg-probe-'));
  const out = process.env.PROBE_OUT || tmp;
  const db = join(tmp, 'mapping.db');
  const micPath = join(tmp, 'mic.wav');
  writeFileSync(micPath, wav(48000, 24, (t) => BURSTS.some(([a, b]) => t >= a && t < b)));
  const projects = join(tmp, 'claude-projects');
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: db, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) throw new Error(r.err);
  };
  await seed({ recipes: [{ id: 'rec-cg', name: 'Concierge', projectDir: '/srv/x/concierge', vendor: 'claude-code', agent: 'concierge' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  const engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: HOST, HARBOR_WB_TABLE: db, HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
      HARBOR_WB_CLAUDE_PROJECTS: projects, HARBOR_WB_NODE: 'testnode', HARBOR_WB_PANE_TOKENS: '1',
      HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'local', kind: 'local', shell: 'bash' }] }),
    }),
  });
  engine.stdout.on('data', (d) => (log += d));
  engine.stderr.on('data', (d) => (log += d));
  let browser = null;
  try {
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      if (await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)) break;
    }
    await seed({ sessions: [{ paneid: 'recipe:rec-cg', recipe_id: 'rec-cg', vendor: 'claude-code', agent: 'concierge', session_id: 'cg-session-0001', state: 'live' }] });
    const cookieRes = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}`, redirect: 'manual' });
    const cookie = (cookieRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const H = { cookie, 'content-type': 'application/json' };
    const room = await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Alpha' }) })).json();
    await fetch(`${BASE}/api/concierge`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: true, primary: 'rec-cg' }) });
    const dir = join(projects, '-srv-x-concierge');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const mid = String.fromCharCode(0xb7);
    const lines = [
      { type: 'user', message: { role: 'user', content: `[chat ${mid} @user ${mid} voice] where is the Alpha room?` }, timestamp: new Date(now - 60000).toISOString(), uuid: 'u1' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Alpha is here: wb:room/${room.id} and the Workbench is wb:manager. The old room wb:room/nope is gone.` }] }, timestamp: new Date(now - 30000).toISOString(), uuid: 'a1' },
    ];
    writeFileSync(join(dir, 'cg-session-0001.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micPath}`, '--autoplay-policy=no-user-gesture-required'] });
    for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }]) {
      console.log(`\n[${vp.name}]`);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.name === 'phone', hasTouch: vp.name === 'phone' });
      await ctx.addCookies(cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), domain: HOST, path: '/' })));
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${BASE}/manager.html`);
      const btn = page.locator('.cg-btn').first();
      await btn.waitFor({ state: 'visible', timeout: 8000 });
      ok(await btn.isVisible(), 'the Concierge icon shows in the Workbench header');
      await btn.click();
      await page.locator('.cg-sheet').waitFor({ timeout: 5000 });
      if (process.env.PROBE_DEBUG) {
        await sleep(3000);
        console.log('DEBUG chat:', JSON.stringify(await page.evaluate(() => fetch('/api/sessions/' + encodeURIComponent('recipe:rec-cg') + '/chat').then((r) => r.json()))).slice(0, 600));
        console.log('DEBUG body:', (await page.locator('.cg-sheet').innerText()).slice(0, 400));
      }
      await page.locator('.ac-wb-chip').first().waitFor({ timeout: 8000 });
      ok((await page.locator('.ac-wb-chip').count()) === 2, 'the reply shows two live wb: chips');
      ok((await page.locator('.ac-wb-dead').count()) === 1, 'and the dead link as text with its note');
      ok((await page.locator('.ac-voice').count()) === 1, 'the spoken line carries the voice mark');
      const box = await page.locator('.cg-sheet').boundingBox();
      if (vp.name === 'phone') {
        ok(Math.round(box.width) === vp.width, `phone: a full-width bottom sheet (${Math.round(box.width)}px)`);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        ok(!sideways, 'phone: no sideways scroll');
      } else {
        ok(box.width <= 440 && box.x <= 1, `desktop: a side sheet on the left (${Math.round(box.width)}px)`);
      }
      await page.screenshot({ path: join(out, `concierge-${vp.name}.png`) });
      ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
      await ctx.close();
    }
    await voiceScenario(browser, cookie, out);
    console.log(`\nscreenshots: ${out}`);
  } finally {
    if (browser) await browser.close();
    engine.kill('SIGKILL');
    await sleep(200);
    if (!process.env.PROBE_OUT) {
      /* keep the screenshots when nobody named a folder: print where they are */
    } else {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

async function voiceScenario(browser, cookie, out) {
  console.log('\n[voice]');
  const scenario = [
    "We need to think about the way we take user information on the form. Actually, Olivia let's move this to a note.",
    'So the form needs to have three fields, and those are first name, last name and email address. The form also needs a submit button.',
    "Olivia, let's change that to four fields, and add a checkbox for accepting the terms and there should be a link to our terms.",
    'After the form submission then we should have a thank you page.',
    "Ok Olivia, let's send the note.",
    "Let's send it to the lead in the Northwind Team Workrooms, and tell them that I had some ideas for the form.",
  ];
  const N1 = 'We need to think about the way we take user information on the form.';
  const N2 = `${N1}\nThe form needs three fields: first name, last name and email address. It also needs a submit button.`;
  const N3 = `${N1}\nThe form needs four fields: first name, last name, email address and a checkbox for accepting the terms, with a link to our terms. It also needs a submit button.`;
  const N4 = `${N3}\nAfter the form is submitted there is a thank you page.`;
  const TASK = 'Send the note to the Northwind Team Workrooms lead: Owner had some ideas for the form';
  const answers = [
    { mode: 'note', note: N1, say: 'Starting a note.' },
    { mode: 'note', note: N2, say: '' },
    { mode: 'note', note: N3, say: 'Making the change.' },
    { mode: 'note', note: N4, say: '' },
    { mode: 'asking', note: N4, say: 'Where are we sending the note?', task: 'send the note' },
    { mode: 'conversation', note: N4, say: "I'd send it to the Workrooms lead.", task: TASK },
  ];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies(cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), domain: HOST, path: '/' })));
  const brain = [];
  const tts = [];
  const other = [];
  let heard = 0;
  await ctx.route(/\/api\/voice\/test\/stt(\?|$)/, (route) => route.fulfill({ json: { text: scenario[heard++] ?? '', word_count: 3 } }));
  await ctx.route(/\/api\/voice\/test\/tts$/, (route) => {
    tts.push(JSON.parse(route.request().postData() || '{}').text);
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: silent });
  });
  await ctx.route(/\/api\/voice\/test\/brain$/, async (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    brain.push(req);
    await sleep(300);
    const a = answers[scenario.indexOf(req.utterance)] ?? { mode: req.mode, note: req.note, say: '' };
    await route.fulfill({ json: { intent: 'dictate', why: '', would: '', task: '', ...a, via: 'sonnet', model_ms: 250, ms: 300 } });
  });
  await ctx.route(/\/api\/voice\/characters$/, (route) => route.fulfill({ json: { characters: [{ id: 'olivia', name: 'Olivia' }] } }));
  ctx.on('request', (r) => {
    if (r.method() !== 'GET' && !/\/api\/voice\/test\/(stt|tts|brain)(\?|$)|\/api\/concierge\/seen$|\/api\/presence\/device$/.test(r.url())) other.push(`${r.method()} ${r.url()}`);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/manager.html`);
  await page.locator('.cg-btn').first().click();
  await page.locator('.cg-mic').waitFor({ timeout: 8000 });
  ok(await page.locator('.cg-head .cg-mic').isVisible() && await page.locator('.cg-head .cg-gear').isVisible(), 'the fly-out header has the mic and the gear (voice is on by default)');
  ok(!(await page.locator('.cg-ind').isVisible()), '...and no speaking indicator while the mic is off');
  await page.locator('.cg-gear').click();
  ok(await page.locator('.cg-set').isVisible() && (await page.locator('.cg-set .cg-set-row').count()) === 4, 'the gear opens the voice settings over the box (sensitivity, pause, voice, speak)');
  await page.locator('.cg-set').screenshot({ path: join(out, 'concierge-voice-settings.png') });
  await page.locator('.cg-set .cg-nc-x').click();
  ok(await page.locator('.cg-set').isHidden(), '...and its ✕ closes it');

  const until = async (fn, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(150);
    }
    console.log(`  (waited ${ms} ms for ${what})`);
    return false;
  };
  const card = () => page.evaluate(() => {
    const c = document.querySelector('.cg-notecard');
    return { open: !!c && !c.hidden, mode: c?.querySelector('.cg-nc-mode')?.textContent ?? '', text: c?.querySelector('.cg-nc-text')?.textContent ?? '', said: c?.querySelector('.cg-nc-said')?.hidden ? '' : c?.querySelector('.cg-nc-said')?.textContent ?? '' };
  });
  const locals = () => page.evaluate(() => [...document.querySelectorAll('.cg-sheet .entry')].filter((li) => li.querySelector('.ac-test')).map((li) => ({ who: li.classList.contains('by-user') ? 'you' : 'her', voice: !!li.querySelector('.ac-voice'), text: li.querySelector('.entry-body')?.textContent ?? li.textContent })));

  await page.locator('.cg-mic').click();
  ok(await until(async () => (await page.locator('.cg-ind').getAttribute('data-state')) !== 'off', 3000, 'the indicator'), 'the mic opens: the indicator shows');
  ok(await until(async () => (await card()).open, 9000, 'the note card'), 'the first line opened the note card over the chat');
  let c = await card();
  ok(c.mode === 'Taking a note' && c.text === N1 && c.said === 'Starting a note.', '...seeded with what was said, her "Starting a note." on the card', c);
  let l = await locals();
  ok(l.length === 1 && l[0].who === 'you' && l[0].voice && l[0].text.includes('move this to a note'), 'the line before the note is your bubble, marked voice + test', l);
  ok(brain[0]?.mode === 'conversation' && brain[0]?.utterance === scenario[0] && brain[0]?.name, 'it went to the Sonnet sandbox with the state', brain[0]);
  ok(await until(async () => (await card()).text === N2, 8000, 'dictation'), 'dictation fills in the card');
  ok((await locals()).length === 1, '...and adds no chat bubble');
  ok(await until(async () => (await card()).text === N3, 8000, 'the edit'), '"Olivia, change that to four fields…" edits the note in place');
  c = await card();
  ok(c.said === 'Making the change.', '...and she says so on the card', c);
  ok(await until(async () => (await card()).text === N4, 8000, 'more dictation'), 'more dictation fills in');
  await page.locator('.cg-sheet').screenshot({ path: join(out, 'concierge-voice-note.png') });
  ok(await until(async () => (await card()).mode === 'Asking you', 8000, 'asking'), '"send the note": the card turns to asking');
  c = await card();
  ok(c.said === 'Where are we sending the note?' && tts.includes('Where are we sending the note?'), '...she asks where it goes, out loud', c);
  ok(await until(async () => !(await card()).open, 8000, 'the card closing'), 'the answer finished it: the card closes');
  l = await locals();
  const would = l.find((x) => x.text.startsWith('Would do:'));
  ok(l.some((x) => x.who === 'her' && x.text === "I'd send it to the Workrooms lead.") && would && would.text.includes(TASK) && would.text.includes('After the form is submitted') && /Test: nothing was sent/.test(would.text), 'her answer and what she WOULD do (with the note) are bubbles, marked test', l);
  ok(l.indexOf(would) === l.length - 1, '...the "Would do" after her words', l.map((x) => x.text.slice(0, 30)));
  ok(other.length === 0, `nothing but STT / TTS / Sonnet (and the page's read marker and presence) left the page: nothing was sent${other.length ? ': ' + other.join(' | ') : ''}`);
  await page.locator('.cg-sheet').screenshot({ path: join(out, 'concierge-voice-done.png') });
  await page.locator('.cg-mic').click();
  ok(await until(async () => (await page.locator('.cg-ind').getAttribute('data-state')) === 'off', 3000, 'mic off'), 'the mic closes');
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close();
}

run()
  .catch((e) => {
    failed++;
    console.log(`  FAIL run aborted: ${e?.stack ?? e}`);
  })
  .finally(() => {
    console.log(`PASS ${passed} FAIL ${failed}`);
    process.exit(failed ? 1 : 0);
  });
