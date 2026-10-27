/* THE TAB SET SURVIVES A RELOAD, and F5 no longer eats the window.
 *
 * Owner, 2026-09-17: "i hit f5 to refresh the cli manager … it cleared all the
 * tabs." test/shell-tabs.test.mjs proves the RULES (which set comes back, what
 * is refused); only a browser can prove the WIRING — that the shell writes its
 * set on every change, reads it on load, and that a reload keystroke inside a
 * tab reloads THE IFRAME and leaves the shell standing.
 *
 * A PROBE, not part of `npm test`. Like passkey-browser.probe.mjs it SPINS ITS
 * OWN ENGINE on a scratch port with a temp table, so it never touches :7420,
 * the real data/, a broker, or — the rule that matters most here — one of
 * Owner's live panes. The tabs it opens are the repo's own mock pages: no
 * recipe is launched and no pty is ever created.
 *
 * Headless Chromium is the right engine for this one (unlike the scrollbar and
 * viewport probes, which need real Edge): nothing here is screen-, zoom- or
 * scrollbar-shaped. sessionStorage, keydown and iframe reloads behave
 * identically headless.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* Scratch ports — the port table is in test/_scratch.mjs; P() refuses the
   live engine and the REAL pty-broker. */
const PORT = P(6);
const DEAD_BROKER_PORT = P(13); // told to the engine; nothing may listen there
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-shell-tabs-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAB_A = '/mock-session.html?probe=a';
const TAB_B = '/mock-session.html?probe=b';
const TAB_C = '/mock-session.html?probe=c';
const shellUrl = (tabs) => `${BASE}/app/shell.html?kind=manager&debug=1&tabs=${tabs.map(encodeURIComponent).join(',')}`;

/** The shell's own model, read out of the page. */
const readTabs = (p) => p.evaluate(() => {
  const strip = document.querySelector('.hwb-tabs');
  return {
    frames: [...document.querySelectorAll('#stage iframe')].map((f) => ({
      src: f.getAttribute('src'),
      shown: f.style.display !== 'none',
    })),
    /* Defensive: a window down to ONE tab is not `.is-tabbed`, and a page that
       ended up somewhere else entirely (a /login redirect) has no strip at all.
       Both should be REPORTED — a throw here reads as a probe bug, and the
       first two runs of this probe lost that distinction to an exception. */
    where: location.pathname,
    chips: strip ? [...strip.querySelectorAll('.hwb-tab[data-tab] .tname')].map((e) => e.textContent) : [],
    stored: (() => {
      try { return JSON.parse(sessionStorage.getItem('hwb.shell.tabset.v1') || 'null'); } catch { return null; }
    })(),
  };
});

/* PORT GUARD. An aborted run leaves its engine listening, and the next run
   then silently talks to THAT one — a stale build with a different token,
   whose symptom is a login failure nobody would connect to a leaked process
   (2026-09-17, and it happened here first time out). Refuse instead. */
try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    console.log(`        netstat -ano | grep :${PORT}   then taskkill //F //T //PID <pid>`);
    process.exit(1);
  }
} catch { /* nothing there: what we want */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'shell-tabs.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-shell-probe-'));
let engine = null;
let browser = null;

try {
  engine = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '', // 8204 is the real server service — a test never dials it
      HARBOR_WB_BROKER_AUTOSTART: '0', // never touch the real scheduled task
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), // nothing listens there; no pty is opened
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      /* A KNOWN token, into a TEMP file: the scratch engine must not mint one
         into the repo's own secrets/ (it does that when neither is set), and
         the probe needs the value to log the page in. Every page here is behind
         auth — a shell that 302s to /login renders no tab strip at all, which
         is what the first run of this probe found. */
      HARBOR_WB_TOKEN: 'probe-shell-tabs-token',
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
    }),
  });
  let engineLog = '';
  engine.stdout.on('data', (d) => { engineLog += d; });
  engine.stderr.on('data', (d) => { engineLog += d; });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();

  /* Sign in once; the cookie then covers the shell, its iframes and every
     asset. Same form the close-button probe drives. */
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  ok(!page.url().includes('/login'), 'signed in to the scratch engine', page.url().replace(BASE, ''));

  /* ---------------------------------------------------------------------
     1. A SHELL OPENED WITH TWO TABS WRITES ITS SET DOWN. */
  await page.goto(shellUrl([TAB_A, TAB_B]), { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  let s = await readTabs(page);
  ok(s.frames.length === 2, 'the shell opened both tabs from ?tabs=', s.frames.length);
  ok(!!s.stored, 'and wrote the set to sessionStorage');
  ok(s.stored && s.stored.tabs.length === 2, '...with both tabs in it', s.stored && s.stored.tabs.length);

  /* Open a third the way the Manager does — {hwbOpenTab} from a tab's iframe.
     This also proves the set is written on a MUTATION, not just at load.
     IT MUST BE SENT FROM INSIDE THE FRAME: the shell matches `e.source`
     against each tab's contentWindow, so a postMessage issued from the shell's
     own context is ignored (the 2026-09-15 note says so, and the first run of
     this probe proved it by quietly not opening a tab). */
  const frameA = page.frames().find((f) => f.url().includes('probe=a'));
  ok(!!frameA, "the first tab's frame is reachable");
  await frameA.evaluate((url) => {
    parent.postMessage({ hwbOpenTab: { url, title: 'Probe C' } }, '*');
  }, TAB_C);
  await sleep(900);
  s = await readTabs(page);
  ok(s.frames.length === 3, 'a third tab opened', s.frames.length);
  ok(s.stored.tabs.length === 3, 'and the stored set grew with it', s.stored.tabs.length);
  const activeBefore = s.stored.activeIndex;
  ok(s.stored.tabs[activeBefore].url.includes('probe=c'), 'the newly-opened tab is the active one', activeBefore);

  /* ---------------------------------------------------------------------
     2. THE DEFECT ITSELF: reload the SHELL and the window must come back.
        This is what F5-in-a-tab did (and what the menu's Reload does on
        purpose) — the top-level document reloads from a URL carrying ONE tab. */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);
  s = await readTabs(page);
  ok(s.frames.length === 3, 'after a full page reload ALL THREE tabs are back', s.frames.length);
  const urls = s.frames.map((f) => f.src).join(' ');
  ok(urls.includes('probe=a') && urls.includes('probe=b') && urls.includes('probe=c'),
    'and they are the same three, not the one the URL named', urls.replace(/[^ ]*mock-session.html/g, '…'));
  const shownIdx = s.frames.findIndex((f) => f.shown);
  ok(s.frames[shownIdx] && s.frames[shownIdx].src.includes('probe=c'),
    'the ACTIVE tab is preserved too', s.frames[shownIdx] && s.frames[shownIdx].src.split('?')[1]);

  /* ---------------------------------------------------------------------
     3. F5 WITH FOCUS IN A TAB RELOADS THE IFRAME, NOT THE SHELL.
        The marker is the whole test: it lives on the shell's window, so if the
        shell reloaded it is gone. A reloaded IFRAME is proven by its own
        counter, set on each of its loads. */
  await page.evaluate(() => { window.__shellMarker = 'alive-1'; });
  await page.evaluate(() => {
    /* count loads of the active frame from the shell's side */
    window.__frameLoads = 0;
    const f = [...document.querySelectorAll('#stage iframe')].find((x) => x.style.display !== 'none');
    f.addEventListener('load', () => { window.__frameLoads += 1; });
  });
  const frame = page.frames().find((f) => f.url().includes('probe=c'));
  ok(!!frame, 'found the active tab\'s frame to type into');
  await frame.evaluate(() => { document.body.focus(); });
  await frame.press('body', 'F5');
  await sleep(1200);
  const marker = await page.evaluate(() => window.__shellMarker || null);
  ok(marker === 'alive-1', 'F5 inside a tab did NOT reload the shell — the marker survived', String(marker));
  ok(await page.evaluate(() => window.__frameLoads) >= 1, 'but the ACTIVE IFRAME did reload',
    await page.evaluate(() => window.__frameLoads));
  s = await readTabs(page);
  ok(s.frames.length === 3, 'and no tab was lost', s.frames.length);

  /* ---------------------------------------------------------------------
     3b. THE SAME, WITH FOCUS IN THE CLI MANAGER TAB — Owner's actual case
         (2026-09-20: "if I hit F5 on the cli manager tab, it would refresh
         the entire app and kill all the tabs"). The hub is a DIFFERENT page
         from a session tab (manager.html, its own scripts and key handling),
         so 3's pass on a session tab does not cover it. */
  /* Open the real manager page as a tab, the way the hub chip does. */
  await frame.evaluate(() => {
    parent.postMessage({ hwbOpenTab: { url: '/manager.html', title: 'CLI Manager' } }, '*');
  });
  await sleep(1200);
  await page.evaluate(() => {
    const hub = [...document.querySelectorAll('#stage iframe')]
      .find((f) => f.src.includes('manager.html'));
    window.__hubLoads = 0;
    if (hub) { hub.addEventListener('load', () => { window.__hubLoads += 1; }); }
    window.__hubFound = !!hub;
  });
  const hubPresent = await page.evaluate(() => window.__hubFound);
  if (hubPresent) {
    const hubFrame = page.frames().find((f) => f.url().includes('manager.html'));
    await hubFrame.evaluate(() => { document.body.focus(); });
    await hubFrame.press('body', 'F5');
    await sleep(1400);
    ok(await page.evaluate(() => window.__shellMarker) === 'alive-1',
      'F5 in the CLI MANAGER tab did NOT reload the shell');
    ok(await page.evaluate(() => window.__hubLoads) >= 1, '...but the manager tab itself reloaded',
      await page.evaluate(() => window.__hubLoads));
    s = await readTabs(page);
    ok(s.frames.length === 4, '...and every tab survived (3 + the manager tab)', s.frames.length);

    /* 3d. ACCOUNT MOVED TO THE STATUS MENU (2026-09-28): an EMBEDDED manager
       (this IS that case — a hub tab inside the shell) must hide its header
       "Account" link so it isn't offered twice. The standalone (no shell)
       case is proven at the end of this probe, in its own page/context. */
    const acctHiddenEmbedded = await hubFrame.evaluate(() => document.getElementById('accountBtn')?.hidden);
    ok(acctHiddenEmbedded === true, 'embedded (hub tab): the header Account link is hidden', acctHiddenEmbedded);

    /* 3c. AN AUX TAB'S CLOSE-OR-END POPOVER. The bundle wires the 1d popover to
       EVERY tab's close button, so closing Icons offered 'End session' and a 3s
       countdown for a page that owns no pty (Owner, 2026-09-20: "it should only
       do it on pty brokered pages"). Nothing could ever have been killed - the
       shell ignores end-session for a tab with no paneid - but the affordance
       is the defect. Aux tabs must close at once; a SESSION tab must still get
       the popover, which is the half a naive fix breaks. */
    /* Posted from INSIDE a tab's iframe: the shell matches e.source against each
       frame's contentWindow, so a post from the top window is ignored (and the
       failure reads as "no tab opened", not as a rejected message). */
    await hubFrame.evaluate(() => {
      parent.postMessage({ hwbOpenTab: { url: '/icons.html', title: 'Icons' } }, '*');
    });
    await sleep(1600);
    /* The newly-opened tab is the active one - matching on the label would
       depend on whose title wins, the caller's or the page's. */
    const auxId = await page.evaluate(() => {
      const el = document.querySelector('.hwb-tab.is-active[data-tab]:not(.is-hub)');
      return el ? el.dataset.tab : null;
    });
    ok(!!auxId, 'the Icons page opened as a tab', auxId);
    if (auxId) {
      await page.click(`.hwb-tab[data-tab="${auxId}"] .tclose`);
      await sleep(500);
      ok(!(await page.$('.hwb-closepop')), 'an AUX tab shows NO close-or-end popover');
      ok(!(await page.$(`.hwb-tab[data-tab="${auxId}"]`)), '...and it closed at once, no countdown');
      s = await readTabs(page);
      ok(s.frames.length === 4, '...leaving the other tabs alone', s.frames.length);
    }
    /* The session tab keeps the popover — dismissed with Escape, which closes
       that ONE tab (the bundle's documented "close the tab now"). */
    const sessTab = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.hwb-tab[data-tab]:not(.is-hub) .tname')]
        .find((n) => n.textContent.trim().startsWith('Probe'));
      return el ? el.closest('.hwb-tab').dataset.tab : null;
    });
    if (sessTab) {
      await page.click(`.hwb-tab[data-tab="${sessTab}"] .tclose`);
      await sleep(500);
      ok(!!(await page.$('.hwb-closepop')), 'a SESSION tab STILL gets the popover');
      await page.keyboard.press('Escape');
      await sleep(700);
      ok(!(await page.$(`.hwb-tab[data-tab="${sessTab}"]`)),
        '...and Escape closes that tab now, session kept in the broker');
      /* Put the window back to the four tabs the rest of this file expects. */
      await hubFrame.evaluate((u) => {
        parent.postMessage({ hwbOpenTab: { url: u, title: 'Probe C' } }, '*');
      }, TAB_C);
      await sleep(1300);
      s = await readTabs(page);
      ok(s.frames.length === 4, '...and the window is back to four tabs', s.frames.length);
    }
  } else {
    ok(false, 'the shell has a CLI Manager tab to press F5 in (none found)');
  }

  /* Ctrl+R from the shell chrome itself takes the same path. */
  await page.evaluate(() => {
    window.__frameLoads = 0;
    const f = [...document.querySelectorAll('#stage iframe')].find((x) => x.style.display !== 'none');
    if (f) { f.addEventListener('load', () => { window.__frameLoads += 1; }); }
  });
  await page.keyboard.press('Control+r');
  await sleep(1000);
  ok(await page.evaluate(() => window.__shellMarker) === 'alive-1', 'Ctrl+R on the shell chrome does not reload it either');
  ok(await page.evaluate(() => window.__frameLoads) >= 1, 'it reloads the active tab');

  /* ---------------------------------------------------------------------
     3d. THE HUB CHIP IS ALWAYS THERE, AND IT IS THE WAY TO THE MANAGER.
        Owner, 2026-09-21: "I want the chip always present at the top level ...
        the + is going to be used for summoning and groups and not to show the
        cli manager." The chip used to be REMOVED from a window holding no
        Manager tab — which is the torn-off window, i.e. exactly the one with no
        other way back. Tearing off is how he found it. */
  ok(!!(await page.$('.hwb-tab.is-hub')), 'the hub chip is present with a Manager tab in the window');
  ok(await page.$eval('.hwb-newtab', (e) => e.hidden || getComputedStyle(e).display === 'none'),
    'the + is not offering the Manager any more (reserved for summon/groups)');

  /* Close the Manager tab and the chip must SURVIVE, now offering to open one. */
  /* A TORN-OFF WINDOW is the case that found this: one session tab, no Manager.
     The Manager renders ONLY as the hub chip (no data-tab, no ✕), so the honest
     way to reach that state is a window opened with a session tab alone —
     which is exactly what the host creates on a tear-off. */
  {
    const lone = await context.newPage();
    await lone.goto(shellUrl([TAB_A]), { waitUntil: 'domcontentloaded' });
    await sleep(1400);
    const chip = await lone.$('.hwb-tab.is-hub');
    ok(!!chip, 'a window with NO Manager tab still shows the hub chip');
    ok(await lone.evaluate(() => [...document.querySelectorAll('#stage iframe')]
      .every((f) => !(f.getAttribute('src') || '').includes('manager.html'))),
      '...and it genuinely holds no Manager yet');
    if (chip) {
      await chip.click();
      await sleep(1600);
      ok(await lone.evaluate(() => [...document.querySelectorAll('#stage iframe')]
        .some((f) => (f.getAttribute('src') || '').includes('manager.html'))),
        '...clicking it opens a Manager in THIS window (never yanks you to another)');
    }
    await lone.close();
  }

  /* ---------------------------------------------------------------------
     4. THE PER-TAB REFRESH (Owner: "the tab's sub-bar no longer has a
        refresh on it").
        IT MOVED IN v21: the shell's own strip button was removed as a
        duplicate when the the design system bundle took over the tab row — the bundle
        draws a ⟳ INSIDE each tab and emits `hwb:refresh {id}`, which the
        shell routes to the same per-tab reload. So the button to click is
        the bundle's, and its absence here would mean the bundle stopped
        drawing it — still exactly the regression this section guards. */
  /* WHICH ⟳, and WHICH FRAME — both were wrong the first time and each fails
     as "the button is dead":
       * every tab carries a ⟳, so a bare `.hwb-tab .trefresh` picks tab ONE's
         while tab four is shown, reloading a frame nobody is watching;
       * shell.html hides the ⟳ on the ACTIVE tab once it is narrower than
         158px (the title needs the room; F5 covers that tab) — with four tabs
         open that is the normal case, so the active tab's button is not
         clickable either.
     So: click an UNSELECTED tab's ⟳ — the affordance as designed — and watch
     the frame belonging to THAT tab id, not the visible one. */
  const refreshId = await page.evaluate(() => {
    const b = document.querySelector('.hwb-tab:not(.is-active) .trefresh');
    return b ? b.dataset.refresh : null;
  });
  ok(!!refreshId, 'an unselected tab carries a ⟳ (v21: drawn by the bundle)', refreshId);
  /* Watch EVERY frame: a tab's id (`t1`) is the shell's own handle and appears
     nowhere in the iframe's src, so there is no way to pick the one frame from
     the DOM. Nothing else reloads in this second, so any load is the click's. */
  await page.evaluate(() => {
    window.__frameLoads = 0;
    [...document.querySelectorAll('#stage iframe')]
      .forEach((f) => f.addEventListener('load', () => { window.__frameLoads += 1; }));
  });
  if (refreshId) {
    /* The button only reaches full opacity on hover; it is laid out and
       hit-testable either way, so dispatch the click rather than depending on
       a hover the headless run has no pointer for. */
    await page.evaluate((id) => {
      document.querySelector(`.trefresh[data-refresh="${CSS.escape(id)}"]`)?.click();
    }, refreshId);
  }
  await sleep(1000);
  ok(await page.evaluate(() => window.__frameLoads) >= 1, '...and it reloads that tab');

  /* THE ACTIVE TAB'S ⟳, WITH A REAL MOUSE CLICK — the case that shipped broken.
     The host's tear-off gesture takes pointer capture on the STRIP for any
     press on a chip, and its exemption list named .tclose and the `+` but not
     the ⟳ that v21 added. With capture held, the mouseup lands on the strip and
     the browser never generates a click on the button: dead control, no error,
     nothing logged. Owner: "refresh button by tabs is failing ... i have to hit
     F5". A programmatic .click() CANNOT catch this — it skips the pointer
     sequence entirely — so this drives the mouse. */
  const activeRefresh = await page.$('.hwb-tab.is-active .trefresh');
  ok(!!activeRefresh, 'the active tab carries a ⟳ too');
  if (activeRefresh) {
    await page.evaluate(() => {
      window.__hwbRefreshEvents = [];
      document.addEventListener('hwb:refresh', (e) => window.__hwbRefreshEvents.push(e.detail.id), true);
    });
    const box = await activeRefresh.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(700);
    ok((await page.evaluate(() => window.__hwbRefreshEvents.length)) >= 1,
      '...and a REAL mouse press on it refreshes, rather than starting a tab drag',
      JSON.stringify(await page.evaluate(() => window.__hwbRefreshEvents)));
  }
  ok(await page.evaluate(() => window.__shellMarker) === 'alive-1', '...without touching the shell');
  s = await readTabs(page);
  ok(s.frames.length === 4, '...or the tab set', s.frames.length);

  /* ---------------------------------------------------------------------
     5. WHOLE-APPLICATION ACTIONS ON THE TOP-LEFT STATUS ICON.
        The division is the point: everything above acts on ONE TAB; these two
        act on the window. */
  await page.click('.hwb-act');
  await sleep(200);
  const items = await page.$$eval('.hwb-actmenu .hwb-actmenu-item', (els) => els.map((e) => e.textContent));
  /* four since Assemble room (the design notes §3.1: a whole-window action);
     five since Settings (the global Settings page, web/settings.html);
     six since Account (moved here from the CLI Manager header, 2026-09-28) */
  ok(items.length === 6, 'the status menu lists six actions', items.join(' | '));
  ok(items.includes('Settings'), '...including Settings');
  ok(items.includes('Account'), '...including Account');
  ok(items.some((t) => /^Assemble room from this window's tabs/.test(t)), '...including Assemble room from this window\'s tabs…');
  ok(items.some((t) => /^Reload Workbench/.test(t)), '...including Reload Workbench (all tabs)');
  ok(items.some((t) => /^Reset Workbench/.test(t)), '...and Reset Workbench');
  ok(await page.$('.hwb-actmenu .hwb-actmenu-sep') !== null, '...with the whole-window group separated');

  /* 5a. "Account" resolves the URL like the manager's header link (no
     web/ui-config.json in this scratch engine, so it falls back to the
     relative page) and opens it through the ONE external-link door
     (web/open-external.mjs): a plain browser gets window.open, the native
     host's WebView2 gets {cmd:'openExternal', url} posted to it instead —
     and NEVER both (openExternal picks one route). The menu is already open
     from the assertions above; the click closes it (spec.run wraps
     closeActMenu()), same as every other item here. */
  const ACCOUNT_URL = `${BASE}/account.html`;
  await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  await page.click('.hwb-actmenu .hwb-actmenu-item[data-act="account"]');
  await sleep(500);
  let opened = await page.evaluate(() => window.__opened);
  ok(opened.length === 1 && opened[0][0] === ACCOUNT_URL && opened[0][1] === '_blank' && opened[0][2] === 'noopener,noreferrer',
    'Account, plain browser: window.open(<engine>/account.html, _blank, noopener,noreferrer)', JSON.stringify(opened));

  await page.evaluate(() => {
    window.__posted = [];
    window.__opened = [];
    window.chrome = { webview: { postMessage: (m) => window.__posted.push(m) } };
  });
  await page.click('.hwb-act');
  await sleep(200);
  await page.click('.hwb-actmenu .hwb-actmenu-item[data-act="account"]');
  await sleep(500);
  const posted = await page.evaluate(() => window.__posted);
  const openedInWebview = await page.evaluate(() => window.__opened);
  ok(posted.length === 1 && posted[0].cmd === 'openExternal' && posted[0].url === ACCOUNT_URL,
    'Account, native host: {cmd:openExternal, url:<engine>/account.html} posted to chrome.webview', JSON.stringify(posted));
  ok(openedInWebview.length === 0, '...and window.open was NOT also called', openedInWebview.length);
  await page.evaluate(() => { delete window.chrome; });

  await page.click('.hwb-act'); // the Account click above closed the menu (same as every item here)
  await sleep(200);
  await page.click('.hwb-actmenu .hwb-actmenu-item[data-act="reload"]');
  await sleep(1500);
  s = await readTabs(page);
  ok(s.frames.length === 4, 'Reload reloads the shell and all four tabs come back', s.frames.length);
  ok(await page.evaluate(() => window.__shellMarker || null) === null,
    '...and it really was a shell reload (the marker is gone)');

  await page.click('.hwb-act');
  await sleep(200);
  await page.click('.hwb-actmenu .hwb-actmenu-item[data-act="reset"]');
  await sleep(1500);
  s = await readTabs(page);
  /* THIS window's URL names TWO tabs (a and b); the third was opened at
     runtime. Reset must leave exactly what the URL names and nothing else —
     that is the whole promise, "start from your URL alone". */
  ok(s.frames.length === 2, 'Reset drops the stored set — only the URL\'s tabs are left', s.frames.length);
  const resetUrls = s.frames.map((f) => f.src).join(' ');
  ok(resetUrls.includes('probe=a') && resetUrls.includes('probe=b'), '...which are the ones the shell URL carries');
  ok(!resetUrls.includes('probe=c'), '...and the tab opened at runtime is gone');
  ok(s.stored && s.stored.tabs.length === 2, '...with a fresh set written from there', s.stored && s.stored.tabs.length);

  /* ---------------------------------------------------------------------
     6. A NEW WINDOW DOES NOT INHERIT — the tear-off case. sessionStorage is
        per top-level browsing context, which is exactly why it was chosen over
        localStorage; a fresh context proves the scoping rather than assuming
        it. */
  /* storageState carries COOKIES (so the new window is signed in) and NOT
     sessionStorage — which is precisely the distinction under test. Without it
     the new window lands on /login and the assertion below would "pass" for
     entirely the wrong reason. */
  const ctx2 = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    storageState: await context.storageState(),
  });
  const page2 = await ctx2.newPage();
  await page2.goto(shellUrl([TAB_B]), { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const s2 = await readTabs(page2);
  ok(s2.frames.length === 1, 'a NEW window opens only what its URL named', s2.frames.length);
  ok(s2.frames[0].src.includes('probe=b'), '...it did not inherit the other window\'s set',
    s2.frames[0].src.split('?')[1]);
  await ctx2.close();

  /* ---------------------------------------------------------------------
     7. CLOSING A TAB PERSISTS TOO — a set that only ever grows would restore
        tabs the user deliberately closed, which is the same defect wearing the
        opposite sign. */
  await page.goto(shellUrl([TAB_A, TAB_B]), { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await page.evaluate(() => {
    const chip = document.querySelector('.hwb-tabs .hwb-tab[data-tab]');
    chip.querySelector('.tclose').click();
  });
  await sleep(2200); // the close handshake's 1500ms ack guard
  s = await readTabs(page);
  ok(s.stored && s.stored.tabs.length === s.frames.length,
    'the stored set matches the window after a close', `${s.stored && s.stored.tabs.length} vs ${s.frames.length}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const after = await readTabs(page);
  ok(after.frames.length === s.frames.length, 'and a closed tab does NOT come back on reload', after.frames.length);

  /* ---------------------------------------------------------------------
     8. STANDALONE MANAGER (no shell, no hamburger to carry it): the header
        "Account" link stays visible — the mirror of 3d's embedded check. A
        fresh page in the same (signed-in) context, navigated straight to
        /manager.html rather than through a shell tab. */
  const soloPage = await context.newPage();
  await soloPage.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const acctHiddenStandalone = await soloPage.evaluate(() => document.getElementById('accountBtn')?.hidden);
  ok(acctHiddenStandalone === false, 'standalone (plain browser tab): the header Account link stays visible', acctHiddenStandalone);
  await soloPage.close();

  /* ---------------------------------------------------------------------
     9. NEEDS YOU, SEEN (window-chrome v33, ticket). A session page reports
        `attention-seen` (solo.js NATIVE_STATE for the engine's `waiting-seen`,
        a block the human acked but has not answered); the shell maps it
        through the bundle's alias table to the tab state `waiting-seen`: a
        static coral hairline, NO demand flash — and it still counts in the
        window's "N blocked". */
  await page.goto(shellUrl([TAB_A, TAB_B, TAB_C]), { waitUntil: 'domcontentloaded' });
  await sleep(1400);
  const tell = async (probe, hwbState, title) => {
    const f = page.frames().find((x) => x.url().includes(`probe=${probe}`));
    await f.evaluate(([st, t]) => parent.postMessage({ hwbState: st, title: t }, '*'), [hwbState, title]);
  };
  await tell('a', 'attention', 'Unseen A');
  await tell('b', 'attention-seen', 'Seen B');
  await tell('c', 'active-idle', 'Idle C');
  await sleep(700);
  const look = await page.evaluate(() => {
    const byName = (n) => [...document.querySelectorAll('.hwb-tabs .hwb-tab[data-tab]')].find((t) => t.querySelector('.tname')?.textContent === n);
    const one = (n) => {
      const t = byName(n);
      if (!t) { return null; }
      const cs = getComputedStyle(t);
      return { cls: [...t.classList].filter((c) => c.startsWith('st-')).join(' '), anim: cs.animationName, shadow: cs.boxShadow };
    };
    const agg = document.querySelector('.hwb-bar > .hwb-agg') || document.querySelector('.hwb-agg');
    return { a: one('Unseen A'), b: one('Seen B'), c: one('Idle C'), agg: agg ? agg.textContent.trim() : null, winState: document.getElementById('win')?.dataset.state };
  });
  ok(look.b?.cls === 'st-waiting-seen', 'an attention-seen page is a waiting-seen TAB (through the alias table)', look.b?.cls);
  ok(look.b?.anim === 'none', '...with no demand flash (computed animation-name none)', look.b?.anim);
  ok(/inset/.test(look.b?.shadow ?? '') && /1px/.test(look.b?.shadow ?? ''), '...and a static 1px inset hairline', look.b?.shadow);
  ok(look.a?.cls === 'st-waiting' && look.a?.anim !== 'none', 'the UNSEEN tab still demand-flashes', look.a && `${look.a.cls} ${look.a.anim}`);
  ok(look.c?.cls === 'st-idle' && look.c?.anim === 'none', 'an idle tab stays still', look.c && `${look.c.cls} ${look.c.anim}`);
  ok(/^2\b/.test(look.agg ?? ''), 'the window\'s blocked count includes the seen block (2, not 1)', look.agg);
  ok(look.winState === 'waiting', 'the window aggregate ranks the unseen block first', look.winState);
  await tell('a', 'active-idle', 'Unseen A');
  await sleep(500);
  const seenOnly = await page.evaluate(() => document.getElementById('win')?.dataset.state);
  ok(seenOnly === 'waiting-seen', 'with only a seen block left, the window aggregate is waiting-seen (it outranks idle)', seenOnly);
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* sqlite holds it on Windows */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
