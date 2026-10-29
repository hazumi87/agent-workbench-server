/*
 * The Asset Studio panel's script (task; Aurora mockup room-asset-studio-v1). Served at
 * GET /rooms/:roomId/view.js — a RELATIVE <script src>, so it loads through the engine's
 * panel proxy like tokens.css. Registered scripts:true (allow-scripts, never same-origin).
 *
 * Polls panel.json (2 s while a generation runs, 10 s otherwise) and renders, top to bottom:
 * (1) the running job, (2) the latest generation, (3) current settings, (4) refs,
 * (5) earlier generations, (6) budget. Offline and empty states per the mockup.
 * Tabs: Studio · ★ Favorites · Recycle · Review (design-review items, Aurora).
 *
 * WIDTH (Aurora wide-panel reflow): the frame's OWN width picks a tier from <html data-tiers>
 * (view.mjs TIERS: S < 360 · M · L ≥ 640 · XL ≥ 1000) → t-<tier> + ge-<tier> classes on <html>.
 * L+: Studio splits into a settings column | results; XL: a picked image opens in an in-panel
 * right column instead of the host preview column. A tier change re-renders.
 *
 * Review: a card opens the item's large view IN THIS DOCUMENT (a view state, the DOM swapped) —
 * never by navigating the frame: the host hands the frame its action MessagePort ONCE, on first
 * load, and a navigation or reload loses it (the design notes addendum 3). Versions, the image
 * strip, keys (← → images, [ ] versions, Esc back), swipe and "‹ Review" (back to the list, that
 * card flashed) all stay in-frame. A card thumb opens on THAT image. A room line's link
 * (tool.json `links` review/:n) opens this same panel on that item, in the host's preview column:
 * the same rating form and Send (view.mjs page({base:'../', open})); review/<n>?plain=1 = the old page.
 * #review/<n>[/v<k>] on load, or {panel:'focus', ref:'review/<n>'} from the host, opens an item.
 * Ratings are PER IMAGE and BATCHED : the large view's "Rate this image (k of N)"
 * form — 👍/👎 + comment — AUTO-SAVES (no Save button) THAT image's UNSENT draft in
 * the app (review_feedback on the port — nothing reaches the room): a thumb at once, a comment when
 * typing stops, on leaving the box and with the next tap. Flipping images swaps the form to that image's rating;
 * unsaved typing is kept per image and never carried to another image. Review has three levels (v3 nav,
 * Aurora 13f29fb): the list (chips Open · Done · All; a card says "N unsent") → a review's SUMMARY (its
 * note, a row per image, the user's overall note, the status bar with Begin / Edit review and Submit) →
 * the FOCUS page (pager, Mark, 👍/👎, comment, references, Info). Submit sends THAT review (review_send)
 * to the agent that asked for it. An older version than the latest gets a "You're viewing
 * vK — vL is the latest · Go to vL" banner (read-only ratings).
 *
 * VIEW ONLY. The frame has an opaque origin — no clipboard, no storage, no navigation — so
 * everything that leaves it goes to the host as a message:
 *   app -> host  {panel:'height', px}       every render / image load
 *                {panel:'count', n}         images used of the budget, for the cell header
 *                {panel:'preview', item}    a thumbnail click / Enter: the room's preview column
 *                {panel:'open', url, title} FALLBACK only: a host that never answered 'preview-state'
 *   app -> port  {panel:'action', name:'review_feedback', params:{n}, input:{image, verdict?, comment?}}  auto-save (image 1-based; neither = discard)
 *                {panel:'action', name:'review_note', params:{n}, input:{note}}   the overall note, auto-saved
 *                {panel:'action', name:'review_send', params:{n}, input?:{note}}  Submit, on the summary
 *                                           ONLY from a click; one action in flight, ≥ 500 ms apart
 *   host -> app  {panel:'preview-state', key}  the shown image gets the 2px --text outline
 *                {panel:'focus', ref}          open a review item (in-frame)
 *                {host:'port'} + ports[0]      the action port, kept for the frame's life
 *   port -> app  {host:'action-result', name, ok, error?}  → "✓ Saved" / "✓ Review sent (N)" + a re-poll, or the error
 *                {host:'app-status', actions:'enabled'|'held'|'unregistered'}  right after the port and on
 *                every change: not enabled = "Approval needed to use this · Open Settings" by
 *                the rating form / Send review, both disabled; the view itself keeps working
 *   app -> port  {panel:'open-settings'}   the "Open Settings" click only, ≤ 1/s: the host opens Settings → Apps
 *
 * Every value is written with textContent — a prompt is data, never markup. Every URL built
 * here is RELATIVE (panel.json, thumb/<id>, file/<id>); the absolute ones sent to the host
 * come from new URL(rel, location.href).
 */
(function () {
  'use strict';

  var FAST_MS = 2000;
  var EARLIER_MAX = 12; // Studio view: batches shown under Latest (the rest stay reachable via Favorites/Recycle/Library)
  var SLOW_MS = 10000;
  var PREVIEW_ACK_MS = 700;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var OFF = 'M3 3l18 18M7 18h10a4 4 0 0 0 1.6-7.7M16.2 7.4A6 6 0 0 0 6.1 10 4 4 0 0 0 7 18';

  var root = document.getElementById('ap');
  if (!root || root.getAttribute('data-off')) {
    return;
  }
  var data = null;
  var byKey = {}; // asset id -> {gen, index, asset}
  var picked = null;
  var hostPreviews = false;
  var surface = null; // where the host shows this frame ({host:'surface'}): 'rail' = the tab list only, the rest the full app
  var railOpen = null; // the tab whose page the rail last opened in the preview column
  var ackTimer = null;
  var pollTimer = null;
  var lastSig = '';
  var tab = 'studio'; // which folder the user is looking at: studio (renders + favorites) | favorites | recycle | review
  var html = document.documentElement;
  var tier = 's';
  var detail = null; // XL: the image key shown in the in-panel right column
  var curN = null; // Review: the item last opened (its card is lifted)
  var flashN = null; // Review: flash this card once (coming back from its large view)
  var openAsk = null; // Review: {n, v} to open once panel.json has arrived
  // a room line's link opens THIS panel at review/<n> (view.mjs page({base:'../'})): its URLs go one level up
  var BASE = document.documentElement.getAttribute('data-base') || '';
  var preloaded = {}; // file URLs already fetched ahead of a tap
  var cmpMode = 'hold'; // comparing with a review's Original: 'hold' (press and hold the image) | 'slider' (new left, original right)
  var split = 50; // the slider's position, % from the left
  var lastAr = 1; // the last review image's aspect: the next one's box starts at it (most are square)
  var goneN = null; // Review: an item that was asked for but isn't there
  var showResolved = false;
  var toastTimer = null;
  var large = null; // Review: {n, v, i} — the item shown large, in-frame
  var port = null; // the host's action port (addendum 3); sent once, so this frame never navigates
  // the MODEL domain (Model Studio's Studio + Watch, DESIGN.md): its part of panel.json is data.model
  var mPicked = null; // a model asset the user picked from the room's set (else: the latest output)
  var viewer = null; // {key, box, handle} — the 3D viewer, kept across renders
  var WATCH_MS = 3000;
  var wt = { view: 'frames', jobs: null, err: '', job: null, picked: false, man: null, gone: false, cam: null, at: null, follow: true, seen: 0, want: null, shown: null, bad: false, badKey: null, mode: null, vmode: 'pbr', hidden: {}, refOn: false, partsOpen: false, look: null, wide: false, ui: null, mv: null, glb: null, sig: '' };
  var mLayout = 'rail'; // Model Studio's Watch PAGE layout (a frame-filling Watch) is not carried over yet: Watch flows
  function pagey() {
    return mLayout === 'page';
  }
  // the large view's rating form, for ONE image: {key 'n:v:i', n, v, i (0-based), verdict up|down|null, comment, msg, bad}
  var fb = { key: null, n: null, v: null, i: 0, verdict: null, comment: '', msg: '', bad: false };
  var edits = {}; // 'n:v:i' -> {verdict, comment}: unsaved typing on an image you flipped away from (it stays THAT image's)
  var sbar = { msg: '', bad: false }; // the Send review bar's status ("✓ Review sent (3)" or the error)
  var act = { busy: null, last: 0, timer: null, done: null }; // ONE panel action in flight (its name), ≥ 500 ms apart
  var appStatus = 'enabled'; // the host's {host:'app-status'}: held / unregistered = actions blocked until approved
  var settingsAt = 0; // the last {panel:'open-settings'} (≤ 1/s)
  var FB_GAP_MS = 500;
  var FB_WAIT_MS = 15000;
  var NOTE_MAX = 1500; // the overall note, as review_note / review_send take it
  var FB_TYPE_MS = 700; // a comment saves this long after the last keystroke (still inside the keystroke's activation)
  var typeTimer = null;

  /* width tiers — the one table is <html data-tiers="m:360 l:640 xl:1000"> (view.mjs TIERS) */
  var TIERS = (html.getAttribute('data-tiers') || '').split(' ').map(function (p) {
    var kv = p.split(':');
    return [kv[0], Number(kv[1])];
  }).sort(function (a, b) {
    return a[1] - b[1];
  });
  function applyTier() {
    var w = html.clientWidth;
    var t = 's';
    var cls = [];
    TIERS.forEach(function (x) {
      if (w >= x[1]) {
        t = x[0];
        cls.push('ge-' + x[0]);
      }
    });
    cls.push('t-' + t);
    html.className = cls.join(' ');
    var changed = t !== tier;
    tier = t;
    return changed;
  }
  function ge(t) {
    return html.classList.contains('ge-' + t);
  }
  applyTier();

  function post(msg) {
    try {
      parent.postMessage(msg, '*');
    } catch (e) {
      /* opened standalone */
    }
  }
  function reportHeight() {
    post({ panel: 'height', px: Math.ceil(document.body.getBoundingClientRect().height) }); // content, not the frame: html.scrollHeight never drops below the frame, so a grown frame could never shrink
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function abs(rel) {
    return new URL(rel, location.href).href;
  }
  function cap(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function ago(iso) {
    var min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
    if (!(min >= 0)) return '';
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    if (min < 1440) return Math.floor(min / 60) + 'h ago';
    return Math.floor(min / 1440) + 'd ago';
  }
  var NAMED = [[1, '1:1'], [16 / 9, '16:9'], [9 / 16, '9:16'], [4 / 3, '4:3'], [3 / 4, '3:4'], [3 / 2, '3:2'], [2 / 3, '2:3'], [21 / 9, '21:9'], [5 / 4, '5:4'], [4 / 5, '4:5']];
  function ratioName(r) {
    for (var i = 0; i < NAMED.length; i++) if (Math.abs(NAMED[i][0] - r) < 0.02) return NAMED[i][1];
    return r.toFixed(2);
  }
  function aspectOf(s) {
    if (s.width && s.height) return ratioName(s.width / s.height);
    if (s.aspect === 'auto') return 'auto (ref)';
    return ratioName(Number(s.aspect) || 1);
  }
  function modeOf(draft) {
    return draft ? 'draft' : 'full';
  }
  function section(label, right) {
    var sec = el('div', 'ap-sec');
    if (label) {
      var l = el('div', 'ap-lbl', label);
      if (right) l.appendChild(el('span', 'r', right));
      sec.appendChild(l);
    }
    return sec;
  }
  function meter(pct) {
    var m = el('div', 'meter' + (pct === null ? ' indet' : ''));
    var i = el('i');
    if (pct !== null) i.style.width = Math.max(0, Math.min(100, pct)) + '%';
    return add(m, i);
  }
  function img(src) {
    var i = el('img');
    i.alt = '';
    i.loading = 'lazy';
    i.src = src;
    return i;
  }
  /* the "this is 3D, not a photo" badge : a small solid cube, three shaded faces, in the tile's top-left corner — an overlay,
     never part of the picture, on every model tile whether it shows a picture or the placeholder */
  function cubeBadge() {
    var NS = 'http://www.w3.org/2000/svg';
    var b = el('span', 'cubeb');
    b.setAttribute('role', 'img');
    b.setAttribute('aria-label', '3D model');
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    [['M10 2 L17 6 L10 10 L3 6 Z', '#eef2f6'], ['M3 6 L10 10 L10 18 L3 14 Z', '#a9b4c0'], ['M17 6 L10 10 L10 18 L17 14 Z', '#6b7683']].forEach(function (f) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', f[0]);
      p.setAttribute('fill', f[1]);
      p.setAttribute('stroke', 'rgba(0,0,0,.45)');
      p.setAttribute('stroke-width', '.7');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    });
    b.appendChild(svg);
    return b;
  }
  /* a model's tile: its picture if it has one, else a plain 3D placeholder (a GLB has no thumbnail until one is rendered) */
  function meshThumb(id) {
    var i = img(BASE + 'thumb/' + encodeURIComponent(id));
    i.addEventListener('error', function () {
      var ph = el('span', 'ph3d', '3D');
      if (i.parentNode) i.parentNode.replaceChild(ph, i);
    });
    return i;
  }
  function thumb(a, g, i) {
    var t = el('div', 'th');
    if (a.bin === 'favorites') {
      var st = el('span', 'star', '★');
      st.setAttribute('aria-hidden', 'true');
      t.appendChild(st);
    }
    t.setAttribute('role', 'button');
    t.tabIndex = 0;
    t.setAttribute('data-key', a.id);
    t.setAttribute('aria-label', 'gen ' + g.gen + ', image ' + (i + 1) + ' of ' + g.count);
    t.title = 'gen ' + g.gen + ' · ' + (i + 1) + ' of ' + g.count;
    byKey[a.id] = { g: g, i: i, a: a };
    return add(t, img(BASE + 'thumb/' + encodeURIComponent(a.id)));
  }
  function pending() {
    return add(el('div', 'th pending'), el('span'));
  }
  function inTab(a) {
    return tab === 'studio' ? a.bin !== 'recycle' : a.bin === tab;
  }
  function gridOf(g) {
    var grid = el('div', 'grid');
    g.assets.forEach(function (a, i) {
      if (inTab(a)) grid.appendChild(thumb(a, g, i));
    });
    if (g.state === 'running') for (var k = g.assets.length; k < g.count; k++) grid.appendChild(pending());
    return grid;
  }
  function failNote(g) {
    var why = g.state === 'cancelled' ? 'cancelled' : g.state === 'lost' ? 'lost (engine restart) — nothing charged' : 'failed' + (g.error ? ': ' + g.error : '');
    return el('div', 'fail', cap(why, 160));
  }
  function shown(g) {
    return g.assets.filter(inTab).length;
  }
  function genHead(g) {
    // "gen 8 · man-left · 2 · 10m ago" — the label keeps its brighter weight (Aurora re-check)
    var h = el('div', 'gen-h', 'gen ' + g.gen + ' ·');
    if (g.label) add(h, el('span', 'lbl', g.label), el('span', '', '·'));
    h.appendChild(document.createTextNode((shown(g) || g.count) + ' · ' + ago(g.at)));
    if (g.draft) h.appendChild(el('span', 'draft', 'draft'));
    return h;
  }

  function runningSec(g) {
    var p = g.progress;
    var idx = p && typeof p.index === 'number' ? Math.min(p.index + 1, g.count) : g.assets.length + 1;
    var pct = null;
    // Indeterminate (sliding, no %) until the engine reports a real step (Aurora review, 1808535).
    if (p && p.progress && p.progress.total && (p.progress.step > 0 || p.index > 0)) pct = Math.round(((p.index + (p.progress.step || 0) / p.progress.total) / g.count) * 100);
    var job = el('div', 'job');
    add(job, el('span', 'dot'), el('span', '', 'Generating ' + idx + ' of ' + g.count + ' · ' + modeOf(g.draft) + ' · ' + aspectOf(g.settings)));
    if (pct !== null) job.appendChild(el('span', 'pct', pct + '%'));
    return add(section(), job, meter(pct));
  }
  function latestSec(g) {
    var right = 'gen ' + g.gen + (g.label ? ' · ' + g.label : '') + ' · ' + (g.state === 'running' ? 'running' : (shown(g) || g.count) + ' · ' + ago(g.at) + (g.draft ? ' · draft' : ''));
    var sec = section('Latest', right);
    if (g.assets.length || g.state === 'running') sec.appendChild(gridOf(g));
    if (g.state !== 'running' && g.state !== 'done') sec.appendChild(failNote(g));
    return sec;
  }
  function settingsSec(d) {
    var s = d.settings;
    // v3: the settings are reference, not where you work — one line, folded ("Settings · Krea 2 Turbo · 3:1 · random seed · 4 ▾")
    var det = el('details', 'setfold');
    det.appendChild(add(el('summary'), el('b', '', 'Settings'), document.createTextNode(' ' + [d.model_name || 'default', aspectOf(s), s.seed == null ? 'random seed' : 'seed ' + s.seed, s.count].join(' \u00b7 '))));
    var sec = det;
    var p = el('div', 'prompt' + (s.prompt ? '' : ' none'), s.prompt || 'No prompt yet.');
    if (s.prompt) p.title = cap(s.prompt, 1000);
    sec.appendChild(p);
    if (s.negative_prompt) {
      var n = el('div', 'neg');
      add(n, el('b', '', 'not: '), document.createTextNode(s.negative_prompt));
      sec.appendChild(n);
    }
    var dl = el('dl', 'facts');
    [['model', d.model_name || 'default'], ['aspect', aspectOf(s)], ['seed', s.seed == null ? 'random' : s.seed],
      ['steps', s.num_inference_steps == null ? 'default' : s.num_inference_steps], ['mode', modeOf(s.draft)], ['count', s.count]]
      .forEach(function (kv) {
        add(dl, el('dt', '', kv[0]), el('dd', '', kv[1]));
      });
    add(sec, dl);
    sec.appendChild(refsSec(d));
    return add(section(), sec);
  }
  function refsSec(d) {
    var sec = section('Refs');
    var row = el('div', 'refs');
    if (!d.refs.length) row.appendChild(el('span', 'ref-note', 'No references'));
    d.refs.forEach(function (id, i) {
      var r = el('div', 'ref');
      r.title = i === 0 ? 'main subject' : 'reference ' + (i + 1);
      add(row, add(r, img(BASE + 'thumb/' + encodeURIComponent(id)), el('span', 'tag', i === 0 ? '1 main' : String(i + 1))));
    });
    if (d.refs.length) row.appendChild(el('span', 'ref-note', 'main subject first'));
    return add(sec, row);
  }
  function earlierSec(gens, label) {
    var sec = section(label || 'Earlier');
    gens.forEach(function (g) {
      var box = add(el('div', 'gen'), genHead(g));
      box.appendChild(g.assets.length ? gridOf(g) : failNote(g));
      sec.appendChild(box);
    });
    return sec;
  }
  function budgetSec(b) {
    var sec = section('Budget');
    if (b.used >= b.max_images * 0.8) root.classList.add('low');
    var line = el('div', 'budget');
    var mins = b.until ? Math.ceil((Date.parse(b.until) - Date.now()) / 60000) : null;
    var time = mins === null ? '' : mins > 0 ? ' · ' + mins + ' min left' : ' · time is up';
    add(line, el('span', 'n', b.used), el('span', 'of', '/ ' + b.max_images + ' images' + time + (b.used >= b.max_images || (mins !== null && mins <= 0) ? ' · used; ask the agent to raise it' : '')));
    return add(sec, line, meter((b.used / b.max_images) * 100));
  }
  function offSec() {
    var box = el('div', 'off');
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', OFF);
    s.appendChild(p);
    var t = el('div', 't');
    add(t, el('b', '', 'Image generation is offline.'), document.createTextNode("The agent will say when it's back. Earlier results stay in the Library."));
    return add(box, s, t);
  }
  function emptySec() {
    var e = el('div', 'empty');
    add(e, el('b', '', 'No images yet.'), document.createTextNode('Describe what you want in the room; the agent sets it up here.'));
    return e;
  }

  function count(bin) {
    return (data.counts && data.counts[bin]) || 0; // the server counts every batch; panel.json only carries this tab's
  }
  function waiting() { // "Needs your response": a Vote or Feedback still waiting on you; a Status never is
    return (data.reviews || []).filter(function (it) {
      return it.needs;
    }).length;
  }
  /* Asset Studio's tabs (DESIGN.md): Images · Models · Review, and under Images / Models that domain's own:
     Renders · ★ Favorites · Recycle  /  Jobs · Watch. tab = the page shown: studio | favorites | recycle | models | watch | review. */
  var GROUP = { studio: 'images', favorites: 'images', recycle: 'images', models: 'models', watch: 'models', review: 'review' };
  function tabBtn(key, full, short, n, on, attr) {
    var b = add(el('button', 'tab' + (on ? ' on' : '')), el('span', 'full', full), el('span', 'short', short));
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.setAttribute('aria-label', full.replace('★ ', ''));
    b.setAttribute(attr || 'data-tab', key);
    if (n !== null && n !== undefined) b.appendChild(el('span', 'c', n));
    return b;
  }
  /* The part's header (v3 nav): ONE row of navigation. Beside the rail (the preview column) the rail rows ARE the
     part switcher, so the header is just the part's name and its status chip; where no rail is beside it (a phone,
     the full page) the three parts are one segmented switcher on top. Inside a part, ways to narrow its list are
     chips (Images: All · ★ Favorites · Recycle; Models: Jobs · Watch), never another tab row. */
  var PARTS = [['studio', 'Images'], ['models', 'Models'], ['review', 'Review']];
  function partStatus(d, part) {
    var m = d.model || {};
    if (part === 'images') return (d.generations || []).some(function (g) { return g.state === 'running'; }) ? ['rendering', 'go'] : ['idle', ''];
    if (part === 'models') return m.core && !m.core.ok ? ['3D offline', 'down'] : m.running ? ['working', 'go'] : ['idle', ''];
    var w = waiting();
    return [w + ' open', w ? 'go' : ''];
  }
  function tabsBar() {
    var wrap = el('div', 'tabset');
    var g = GROUP[tab], d = data, m = d.model || {};
    if (surface !== 'preview') {
      var sw = el('div', 'partsw');
      sw.setAttribute('role', 'tablist');
      PARTS.forEach(function (p) {
        var on = GROUP[p[0]] === g;
        var key = p[0] === 'studio' ? String(d.counts ? (d.counts.images || 0) - (d.counts.recycle || 0) : 0) : p[0] === 'models' ? (m.core && !m.core.ok ? 'off' : String(m.n_jobs || 0)) : String(waiting());
        var b = add(el('button', 'tab psw' + (on ? ' on' : '')), el('span', 'full', p[1]), el('span', 'short', p[1]), el('span', 'c', key));
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.setAttribute('data-tab', p[0]);
        sw.appendChild(b);
      });
      wrap.appendChild(sw);
    }
    var st = partStatus(d, g);
    if (surface === 'preview') wrap.appendChild(add(el('div', 'parthead'), el('h2', '', g === 'images' ? 'Images' : g === 'models' ? 'Models' : 'Review'), el('span', 'pchip ' + st[1], st[0]))); // with a switcher, the switcher is the header
    var sub = g === 'images' ? [['studio', 'All', (d.counts ? (d.counts.images || 0) - (d.counts.recycle || 0) : null)], ['favorites', '★ Favorites', count('favorites')], ['recycle', 'Recycle', count('recycle')]]
      : null; // Models' chips (All · Running · Done) sit on its list, like Review's
    if (sub) {
      var row = el('div', 'chips');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Show');
      sub.forEach(function (t) {
        var b = add(el('button', 'tab chipf' + (tab === t[0] ? ' on' : '')), document.createTextNode(t[1]));
        if (t[2] !== null && t[2] !== undefined) b.appendChild(el('span', 'n', ' ' + t[2]));
        b.type = 'button';
        b.setAttribute('data-tab', t[0]);
        b.setAttribute('aria-pressed', tab === t[0] ? 'true' : 'false');
        row.appendChild(b);
      });
      wrap.appendChild(row);
    }
    return wrap;
  }
  /* The rail ("like tasks without the expand"): three rows — Images, Models, Review —
     each a title over a line of stats; a row opens that part in the preview column, where its own tabs
     (Renders · Favorites · Recycle / Jobs · Watch) live. */
  var RAIL_TABS = [['studio', 'Images'], ['models', 'Models'], ['review', 'Review']];
  function railStats(t, d) {
    var m = d.model || {}, c = d.counts || {};
    if (t === 'studio') {
      var running = (d.generations || []).some(function (g) { return g.state === 'running'; });
      return [[running ? 'rendering' : 'idle', running ? 'go' : ''], [(c.queued || 0) + ' queued', ''], [(c.images || 0) + ' produced', 'ok']];
    }
    if (t === 'models') {
      return [[m.core && !m.core.ok ? '3D offline' : m.running ? 'working' : 'idle', m.core && !m.core.ok ? 'down' : m.running ? 'go' : ''],
        [(m.n_queued || 0) + ' queued', ''], [(m.n_outputs || 0) + ' produced', 'ok']];
    }
    // open = waiting on the user; completed = they sent it (replied) or the agent closed it (resolved)
    var all = d.reviews || [];
    var open = waiting();
    return [[open + ' open', open ? 'go' : ''], [all.filter(function (it) { return it.status !== 'waiting'; }).length + ' completed', 'ok']];
  }
  function railNav(d) {
    var nav = el('div', 'railnav');
    nav.setAttribute('role', 'list');
    RAIL_TABS.forEach(function (t) {
      var b = el('button', 'rrow' + (railOpen === t[0] ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('data-open-tab', t[0]);
      b.setAttribute('role', 'listitem');
      var st = el('span', 'rst');
      var parts = railStats(t[0], d).filter(function (x) { return x[0]; });
      parts.forEach(function (x, k) {
        if (k) st.appendChild(document.createTextNode(' · '));
        st.appendChild(el('span', x[1], x[0]));
      });
      add(b, el('span', 'rl', t[1]), st);
      b.setAttribute('aria-label', t[1] + ': ' + parts.map(function (x) { return x[0]; }).join(', ') + ' — open in the preview');
      nav.appendChild(b);
    });
    return nav;
  }
  function openTabInPreview(t) {
    var label = RAIL_TABS.filter(function (x) { return x[0] === t; })[0][1];
    railOpen = t;
    post({ panel: 'preview', view: { path: 'tab/' + t, title: 'Asset Studio · ' + label } });
    lastSig = '';
    render();
  }

  /* ================= the MODEL domain: Model Studio's Studio sections and the 3D viewer ================= */
  /* ---- the viewer: one box per shown asset, kept across renders */
  function viewerBox(id) {
    if (viewer && viewer.key === id) return viewer.box;
    dropViewer();
    var box = el('div', 'mv');
    box.setAttribute('data-key', id);
    viewer = { key: id, box: box, handle: null };
    var mine = viewer;
    // an ABSOLUTE specifier: a classic script fetched from an opaque-origin frame has no base
    // URL for import ("about:blank"), so resolve it against the page here
    box.addEventListener('mv-ready', function () { // the model is in: its pins, and its parts list
      if (viewer !== mine) return;
      syncPins();
      if (!mine.drawn) { mine.drawn = true; lastSig = ''; render(); }
    });
    box.addEventListener('mv-pin', function (e) { // a tag pressed over the model: select it and open its menu at the letter
      openPinMenu(e.detail.id, 'tag');
      lastSig = '';
      render();
    });
    box.addEventListener('mv-pinmenu', function (e) { // a menu item: the same actions as the buttons under the stage
      pinMenu = null;
      pinAction(e.detail.k, e.detail.id);
      lastSig = '';
      render();
    });
    box.addEventListener('mv-error', function (e) { // the model could not be shown: say so in plain words, and keep everything else usable
      if (viewer !== mine || box.querySelector('.mfail')) return;
      var it = data && large && itemOf(data), ver = it && verIdx(it).ver;
      var dlf = ver && (ver.files || []).filter(function (f) { return f.role === 'model'; })[0];
      var fail = el('div', 'mfail');
      fail.setAttribute('role', 'alert');
      add(fail, el('h3', '', 'The 3D view couldn\u2019t load'), el('p', '', 'Why: ' + ((e && e.detail) || 'the model could not be opened') + '.'), el('p', '', 'Your pictures, feedback, response and downloads still work.'));
      var acts = el('div', 'mfa');
      var retry = el('button', 'btn pri', 'Try again');
      retry.type = 'button';
      retry.setAttribute('data-mretry', '1');
      var dl = el('a', 'btn', 'Download the model');
      dl.href = dlf ? BASE + dlf.href : BASE + 'file/' + encodeURIComponent(id);
      dl.setAttribute('download', dlf ? dlf.name : '');
      add(acts, retry, dl);
      fail.appendChild(acts);
      box.classList.add('failed');
      box.appendChild(fail);
    });
    import(new URL(BASE + 'viewer.js', location.href).href).then(function (m) {
      if (viewer === mine) mine.handle = m.mount(box, BASE + 'file/' + encodeURIComponent(id));
    }).catch(function (e) {
      box.dataset.state = 'error';
      box.appendChild(el('div', 'mv-st', 'The 3D viewer could not load (' + cap((e && e.message) || e, 80) + ').'));
    });
    return box;
  }
  function dropViewer() {
    if (viewer && viewer.handle) viewer.handle.dispose();
    viewer = null;
  }

  /* ---- Studio */
  var WORD = { queued: 'queued', running: 'running', done: 'done', error: 'failed', cancelled: 'cancelled', lost: 'lost' };
  function mRunningSec(j) {
    var pct = typeof j.pct === 'number' ? Math.round(j.pct) : null;
    var row = add(el('div', 'job'), el('span', 'dot'), el('span', 't', cap(j.label, 80) + ' · ' + (j.phase || WORD[j.state] || j.state)));
    if (pct !== null) row.appendChild(el('span', 'pct', pct + '%'));
    return add(section('Running', j.provider), row, meter(pct));
  }
  function shownAsset(d) {
    if (mPicked) {
      var hit = (d.assets || []).filter(function (a) { return a.id === mPicked; })[0];
      if (hit) return { asset: hit, title: 'Selected', right: null };
      mPicked = null;
    }
    return d.latest ? { asset: d.latest.asset, title: 'Latest', right: cap(d.latest.label, 60) + ' · ' + ago(d.latest.at) } : null;
  }
  function stageSec(d) {
    var s = shownAsset(d);
    if (!s) {
      dropViewer();
      var e = el('div', 'empty');
      add(e, el('b', '', d.assets && d.assets.length ? 'No output yet.' : 'No models yet.'), document.createTextNode('Ask the agent in the room: it imports assets and runs 3D jobs here.'));
      return e;
    }
    var a = s.asset;
    var sec = add(section(s.title, s.right), null);
    sec.classList.add('stage');
    if (a.view === 'glb') sec.appendChild(viewerBox(a.id));
    else {
      dropViewer();
      var box = el('div', 'mv mv-thumb');
      box.appendChild(img((a.view === 'image' ? BASE + 'file/' : BASE + 'thumb/') + encodeURIComponent(a.id)));
      sec.appendChild(box);
    }
    var c = add(el('div', 'cap'), el('span', 'n', a.label));
    c.firstChild.title = a.label + ' · ' + a.id;
    if (mPicked) {
      var b = el('button', 'btn', 'Latest');
      b.type = 'button';
      b.setAttribute('data-unpick', '1');
      c.appendChild(b);
    }
    if (data.library_web) {
      var o = el('a', 'btn', 'Open in Library');
      o.href = data.library_web + '/?assetid=' + encodeURIComponent(a.id);
      o.target = '_blank';
      o.rel = 'noopener';
      c.appendChild(o);
    }
    sec.appendChild(c);
    if (a.view === 'thumb') sec.appendChild(el('div', 'cap note', 'Too large to show here — open it in the Library.'));
    return sec;
  }
  function jobsSec(d) {
    var sec = section('Jobs', d.n_jobs > d.jobs.length ? d.jobs.length + ' of ' + d.n_jobs : null);
    var ul = el('ul', 'jobs');
    d.jobs.forEach(function (j) {
      var li = el('li');
      li.title = j.job_id;
      add(li, el('span', 's ' + j.state), el('span', 'l', j.label),
        el('span', 'w', (WORD[j.state] || j.state) + (j.state === 'done' ? ' · ' + j.outputs : '') + ' · ' + ago(j.at)));
      if (j.error && (j.state === 'error' || j.state === 'lost')) li.appendChild(el('span', 'e', cap(j.error, 160)));
      ul.appendChild(li);
    });
    return add(sec, ul);
  }
  function assetsSec(d) {
    var sec = section('Room assets', String(d.n_assets));
    var grid = el('div', 'grid');
    d.assets.forEach(function (a) {
      var t = el('button', 'th' + (a.id === mPicked ? ' sel' : ''));
      t.type = 'button';
      t.setAttribute('data-key', a.id);
      t.setAttribute('aria-label', a.label + (a.view === 'glb' ? ' — show in the viewer' : ''));
      t.title = a.label + ' (' + (a.via === 'import' ? 'imported' : 'output') + ')';
      add(t, img(BASE + 'thumb/' + encodeURIComponent(a.id)), el('span', 'k', a.category === 'mesh' ? '3D' : a.category === 'image' ? 'img' : a.category || '?'));
      grid.appendChild(t);
    });
    if (d.n_assets > d.assets.length) sec.appendChild(el('div', 'more', (d.n_assets - d.assets.length) + ' older in get_state'));
    return add(sec, grid);
  }
  function mBudgetSec(b) {
    var sec = section('Budget');
    if (b.used >= b.max_jobs * 0.8) root.classList.add('low');
    var mins = b.until ? Math.ceil((Date.parse(b.until) - Date.now()) / 60000) : null;
    var time = mins === null ? '' : mins > 0 ? ' · ' + mins + ' min left' : ' · time is up';
    var line = add(el('div', 'budget'), el('span', 'n', b.used), el('span', 'of', '/ ' + b.max_jobs + ' jobs' + time + (b.used >= b.max_jobs || (mins !== null && mins <= 0) ? ' · used; ask the agent to raise it' : '')));
    return add(sec, line, meter((b.used / b.max_jobs) * 100));
  }
  function mOffSec(c) {
    var box = el('div', 'off');
    add(box, el('b', '', c.state === 'core-down' || c.state === 'core-slow' ? 'The 3D tools are offline.' : 'No 3D backend is online.'),
      document.createTextNode("The agent will say when it's back. Earlier results stay in the Library."));
    return box;
  }

  /* ================= the MODEL domain: Watch ================= */
  /* ---- Watch: the share's job list + one job's manifest, polled while this tab shows. State is `wt`;
     wtSig() names the STRUCTURE (view, job, cameras …) — a change rebuilds the section (render), anything
     else (a new step, a scrub, a camera pick) repaints in place (watchPaint) so a drag survives a poll. */
  function wtSteps() {
    return wt.man && Array.isArray(wt.man.steps) ? wt.man.steps : [];
  }
  function wtCams() {
    var m = wt.man || {};
    var list = Array.isArray(m.cameras) ? m.cameras.filter(function (c) { return c && typeof c.id === 'string'; }) : [];
    if (!list.length) {
      var seen = {};
      wtSteps().forEach(function (s) {
        Object.keys(s.frames || {}).forEach(function (k) { if (!seen[k]) list.push((seen[k] = { id: k })); });
      });
    }
    return list;
  }
  function wtCam() {
    var list = wtCams();
    var hit = list.filter(function (c) { return c.id === wt.cam; })[0];
    if (!hit) hit = list[0];
    wt.cam = hit ? hit.id : null;
    return hit || null;
  }
  function camName(c) {
    return String(c.label || c.id);
  }
  /* the step on show (an index): the last while following, else the one at wt.at (the nearest earlier if it has gone) */
  function wtIdx() {
    var st = wtSteps();
    if (!st.length) return -1;
    var i = st.length - 1;
    if (!wt.follow) i = Math.max(0, st.filter(function (s) { return s.n <= wt.at; }).length - 1);
    wt.at = st[i].n;
    return i;
  }
  /* the Model view REPLACING the frames (the rail's second view); in page mode both show at once, so never */
  function wtModelView() {
    return wt.view === 'model' && !pagey();
  }
  function wtState() {
    if (wt.jobs === null) return wt.err ? 'err' : 'loading';
    if (!wt.jobs.length) return wt.err ? 'err' : 'empty';
    if (!wt.man) return wt.gone ? 'noframes' : 'loading';
    return wtSteps().length ? 'ready' : 'noframes';
  }
  function wtSig() {
    return [pagey() ? 'page' : wt.view, wtState(), wt.job, (wt.jobs || []).map(function (j) { return j.job; }).join(','), wtCams().map(function (c) { return c.id; }).join(','), wtModes().map(function (m) { return m.id; }).join(','), wt.man && wt.man.model ? 'm' : '-', wtRef() ? 'r' : '-'].join('|');
  }
  /* display modes (manifest.modes, in order). steps[].frames[camera] is a string (one frame, no modes) or {mode: path} */
  var MODE_ID = /^[a-z0-9_-]{1,32}$/;
  function wtModes() {
    var m = wt.man && Array.isArray(wt.man.modes) ? wt.man.modes : [];
    return m.filter(function (x) { return x && typeof x.id === 'string' && MODE_ID.test(x.id); });
  }
  /* the button text: the mode's own "short", else "Plain" for the mode with id plain and A, B, C… for the others in manifest order */
  function modeShort(id) {
    var list = wtModes();
    var m = list.filter(function (x) { return x.id === id; })[0];
    if (m && typeof m.short === 'string' && m.short.trim()) return cap(m.short.trim(), 8);
    if (id === 'plain') return 'Plain';
    var k = list.filter(function (x) { return x.id !== 'plain'; }).map(function (x) { return x.id; }).indexOf(id);
    return k >= 0 ? String.fromCharCode(65 + (k % 26)) : id;
  }
  /* how the captions name a mode: "Plain", or "view B" */
  function modeTag(id) {
    return id === 'plain' ? 'Plain' : 'view ' + modeShort(id);
  }
  function modeFull(id) {
    var m = wtModes().filter(function (x) { return x.id === id; })[0];
    return String((m && m.label) || id);
  }
  /* the accessible name / tooltip: "View B: Wireframe on see-through reference" (the plain mode is just its label) */
  function modeName(id) {
    return id === 'plain' ? modeFull(id) : 'View ' + modeShort(id) + ': ' + modeFull(id);
  }
  /* the mode asked for: the one picked, else the first. null when the job has no modes */
  function wtMode() {
    var list = wtModes();
    var hit = list.filter(function (x) { return x.id === wt.mode; })[0] || list[0];
    wt.mode = hit ? hit.id : null;
    return wt.mode;
  }
  /* the modes a camera has at a step: manifest order first */
  function modesAt(step, camId) {
    var f = step.frames && step.frames[camId];
    if (!f || typeof f !== 'object') return [];
    var order = wtModes().map(function (x) { return x.id; });
    var keys = Object.keys(f).filter(function (k) { return MODE_ID.test(k) && typeof f[k] === 'string' && f[k]; });
    return keys.sort(function (a, b) {
      var x = order.indexOf(a), y = order.indexOf(b);
      return (x < 0 ? 99 : x) - (y < 0 ? 99 : y);
    });
  }
  /* the camera's frame at step i in the wanted mode: {mode} (null = an old-shape single frame) or null */
  function frameIn(step, camId, want) {
    var f = step.frames && step.frames[camId];
    if (typeof f === 'string' && f) return { mode: null };
    if (want && modesAt(step, camId).indexOf(want) >= 0) return { mode: want };
    return null;
  }
  /* What to show for a camera at step i. The mode asked for, at this step; else this camera's other mode at
     this step ('plain' first); else the most recent earlier step that has the mode asked for (else any mode).
     {step, mode, kind: here | mode | earlier, only}  or null when the camera has nothing at or before i. */
  function pickFrame(steps, i, cam) {
    var want = wtMode();
    var here = frameIn(steps[i], cam.id, want);
    if (here) return { step: steps[i], mode: here.mode, kind: 'here' };
    var have = modesAt(steps[i], cam.id);
    if (have.length) return { step: steps[i], mode: have.indexOf('plain') >= 0 ? 'plain' : have[0], kind: 'mode', only: have.length === 1 };
    var k;
    for (k = i - 1; k >= 0; k--) {
      here = frameIn(steps[k], cam.id, want);
      if (here) return { step: steps[k], mode: here.mode, kind: 'earlier' };
    }
    for (k = i - 1; k >= 0; k--) {
      have = modesAt(steps[k], cam.id);
      if (have.length) return { step: steps[k], mode: have.indexOf('plain') >= 0 ? 'plain' : have[0], kind: 'earlier' };
    }
    return null;
  }
  function validPose(c) {
    function v3(a) {
      return Array.isArray(a) && a.length === 3 && a.every(function (x) { return typeof x === 'number' && isFinite(x); });
    }
    return !!c && v3(c.position) && v3(c.target);
  }
  /* a camera's pose for the 3D view: the manifest's wins, else the GLB camera node named by its id or label */
  function poseOf(c) {
    if (validPose(c)) return { position: c.position, target: c.target, fov: typeof c.fov === 'number' ? c.fov : undefined };
    return (wt.glb && (wt.glb[c.id] || wt.glb[c.label])) || null;
  }
  function framePath(job, cam, n, mode) {
    return BASE + 'watch/' + encodeURIComponent(job) + '/frame/' + encodeURIComponent(cam) + '/' + (mode ? encodeURIComponent(mode) + '/' : '') + encodeURIComponent(n) + '.jpg';
  }
  /* looks (steps[].looks[]): pictures the operator opened itself. file / wide are "looks/<n>/<name>.jpg" on the share;
     the route takes <n> and <name>. Anything that does not fit that shape could not be served, so it is left out. */
  var LOOK_PATH = /^looks\/([0-9]{1,9})\/([A-Za-z0-9._-]{1,160}\.jpg)$/;
  function lookUrl(path) {
    var m = LOOK_PATH.exec(String(path || ''));
    return m && m[2].indexOf('..') < 0 ? BASE + 'watch/' + encodeURIComponent(wt.job) + '/look/' + m[1] + '/' + encodeURIComponent(m[2]) : null;
  }
  function looksOf(step) {
    var list = step && Array.isArray(step.looks) ? step.looks : [];
    return list.filter(function (l) { return l && lookUrl(l.file); }).map(function (l) {
      return { file: l.file, wide: lookUrl(l.wide) ? l.wide : null, label: cap(l.label || l.file.split('/').pop().replace(/\.jpg$/, ''), 80) };
    });
  }
  /* the look on show: wt.look (a file path) if the step on show still has it and this is the Frames view, else none */
  function wtLook() {
    if (!wt.look || wtModelView()) return null;
    var i = wtIdx();
    var hit = i < 0 ? null : looksOf(wtSteps()[i]).filter(function (l) { return l.file === wt.look; })[0];
    if (!hit) {
      wt.look = null;
      wt.wide = false;
    }
    return hit || null;
  }
  /* the Model view's own modes (not the Frames ones): how the viewer draws the model. A, B and C need the reference file
     (manifest.reference {file, solid, grid}); their ids are the manifest's modes of the same letters, which supply the labels */
  var VMODES = [
    { id: 'pbr', text: 'PBR', label: 'Full materials' },
    { id: 'lit', text: 'Lit', label: 'Lit, no normal maps' },
    { id: 'color', text: 'A', label: 'Color on gray reference', ref: true },
    { id: 'wire', text: 'B', label: 'Wireframe on see-through reference', ref: true },
    { id: 'refwire', text: 'C', label: 'Grey on reference wireframe', ref: true },
  ];
  var NO_REF = 'This job has no reference model file yet';
  function wtRef() {
    var r = wt.man && wt.man.reference;
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  }
  /* the mode on show: the one picked, unless it needs a reference this job lacks (then Lit, and that sticks) */
  function wtVMode() {
    var hit = VMODES.filter(function (x) { return x.id === wt.vmode; })[0] || VMODES[0];
    if (hit.ref && !wtRef()) hit = VMODES[1];
    if (!wtRef()) wt.refOn = false;
    wt.vmode = hit.id;
    return hit.id;
  }
  function vmodeLabel(x) {
    var m = x.ref ? wtModes().filter(function (y) { return y.id === x.id; })[0] : null;
    return m && typeof m.label === 'string' && m.label.trim() ? cap(m.label.trim(), 80) : x.label;
  }
  function vmodeName(x) {
    return x.ref ? 'View ' + x.text + ': ' + vmodeLabel(x) : vmodeLabel(x);
  }
  /* the reference's opacity in B: the mode's own "alpha", else 0.5 */
  function refAlpha() {
    var m = wtModes().filter(function (y) { return y.id === 'wire'; })[0];
    return m && typeof m.alpha === 'number' && m.alpha > 0 && m.alpha <= 1 ? m.alpha : 0.5;
  }
  function refNames() {
    var r = wtRef() || {};
    var ok = function (s) { return typeof s === 'string' && /^[\w .:-]{1,64}$/.test(s) ? s : undefined; };
    return { solid: ok(r.solid), grid: ok(r.grid) };
  }
  /* hand the viewer the reference (recorded; fetched when it is first ticked on), the mode and the reference tick */
  function applyView(first) {
    var h = wt.mv && wt.mv.handle;
    if (!h) return;
    h.setReference(wtRef() ? BASE + 'watch/' + encodeURIComponent(wt.job) + '/reference.glb' : null, refNames());
    h.setMode(wtVMode(), refAlpha());
    h.setReferenceVisible(wt.refOn && !!wtRef());
    if (first) Object.keys(wt.hidden).forEach(function (n) { h.setVisible(n, false); }); // a viewer made anew (the Model view re-entered) gets the ticks back
  }
  /* "Step <n> / <last n> · Focus: <part>" over the picture and over the 3D view. n is the manifest step's own number (they have gaps), the
     step on show in Frames and the step the preview belongs to in Model. Focus is what that step's verb acted on. steps[].focus is a name (a pair carries its base name, with focus_nodes
     ["x_L", "x_R"]); a step on several subjects has focus_nodes only, shown joined with ", ". Frames: the step on show; Model: the
     step the preview belongs to. The Parts rows named in focus_nodes, or equal to focus, are marked. */
  function nameList(v) {
    return (Array.isArray(v) ? v : []).filter(function (x) { return typeof x === 'string' && x.trim(); }).map(function (x) { return x.trim(); }).slice(0, 40);
  }
  function focusStep(model) {
    var steps = wtSteps();
    if (!model) return steps[wtIdx()];
    var n = wt.man && wt.man.model ? Number(wt.man.model.step) : NaN;
    return steps.filter(function (x) { return x.n === n; })[0];
  }
  function stepFocus(s) {
    var f = s && typeof s.focus === 'string' ? s.focus.trim() : '';
    return f || nameList(s && s.focus_nodes).join(', ');
  }
  /* the manifest's last step number: what the caption's "of M" and the label's "/ M" count to (one number for both) */
  function wtTotal() {
    var st = wtSteps();
    return typeof wt.man.latest === 'number' ? wt.man.latest : st[st.length - 1].n;
  }
  /* the number of the step the picture (or, model: the preview) shows */
  function shownN(model) {
    if (!model) return wtSteps()[wtIdx()].n;
    return wt.man.model && wt.man.model.step != null ? Number(wt.man.model.step) : NaN;
  }
  function wtFocusSet() { // {nodeKey(name): true}: the parts list is the model's, so the model's step
    var s = focusStep(true);
    var set = {};
    nameList(s && s.focus_nodes).concat(s && typeof s.focus === 'string' && s.focus.trim() ? [s.focus.trim()] : []).forEach(function (x) { set[nodeKey(x)] = true; });
    return set;
  }
  /* GLTFLoader's spelling of a node name (spaces to _, no [ ] . : /), so a focus from the manifest finds its row */
  function nodeKey(s) {
    return String(s).replace(/\s/g, '_').replace(/[\[\]./:]/g, '');
  }
  function modelUrl() {
    return BASE + 'watch/' + encodeURIComponent(wt.job) + '/model.glb?step=' + encodeURIComponent(String(wt.man.model.step));
  }
  function dropWatchViewer() {
    if (wt.mv && wt.mv.handle) wt.mv.handle.dispose();
    if (wt.mv && wt.mv.anim && wt.mv.anim.parentNode) wt.mv.anim.parentNode.removeChild(wt.mv.anim);
    wt.mv = null;
    wt.glb = null;
  }

  function watchSec() {
    var st = wtState();
    var sec = el('div', 'ap-sec wt');
    var ui = (wt.ui = { st: st });
    if (!(wt.view === 'model' || pagey()) || st !== 'ready' || !wt.man.model) dropWatchViewer();
    if (st === 'loading' && wt.jobs === null) {
      ui.bare = true;
      return add(sec, el('p', 'wt-msg', 'Loading…'));
    }
    if (st === 'err') {
      ui.bare = true;
      return add(sec, el('p', 'wt-msg', "Can't reach the watch share right now. This tries again every few seconds."));
    }
    if (st === 'empty') {
      ui.bare = true;
      var e = el('div', 'empty');
      return add(sec, add(e, el('b', '', 'Nothing to watch yet.'), document.createTextNode(' Frames appear here while an operator is running Blender steps.')));
    }
    var head = el('div', 'wt-head');
    ui.head = head; // page mode moves it up into the tabs row (render)
    if (!pagey()) { // both views are on show at once on a page: nothing to choose
      var seg = el('div', 'wt-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'What to show');
      [['frames', 'Frames'], ['model', 'Model']].forEach(function (x) {
        var b = el('button', 'wt-sb' + (wt.view === x[0] ? ' on' : ''), x[1]);
        b.type = 'button';
        b.setAttribute('data-wview', x[0]);
        b.setAttribute('aria-pressed', wt.view === x[0] ? 'true' : 'false');
        seg.appendChild(b);
      });
      head.appendChild(seg);
    }
    if (wt.jobs.length > 1) {
      var sel = el('select', 'wt-job');
      sel.setAttribute('data-w', 'job');
      sel.setAttribute('aria-label', 'Job');
      ui.opts = {};
      wt.jobs.forEach(function (j) {
        var o = el('option');
        o.value = j.job;
        ui.opts[j.job] = o;
        sel.appendChild(o);
      });
      ui.sel = sel;
      head.appendChild(sel);
    } else head.appendChild(el('span', 'wt-jobname', wt.job));
    sec.appendChild(head);
    if (st === 'loading' || st === 'noframes') return add(sec, el('p', 'wt-msg', st === 'loading' ? 'Loading…' : 'This job has no frames yet.'));
    if (pagey()) return pageBody(sec, ui);
    if (wt.view === 'model') return modelBody(sec, ui);
    var stage = el('div', 'wt-stage');
    stage.appendChild(framePic(ui));
    camOverlay(stage, ui, false);
    sec.appendChild(stage);
    sec.appendChild(lookStrip(ui));
    var ctl = el('div', 'wt-ctl');
    add(ctl, scrubber(ui), ui.now);
    sec.appendChild(ctl);
    return add(sec, captionEls(ui), ui.warn);
  }
  function framePic(ui) {
    var pic = el('div', 'wt-pic');
    ui.img = el('img');
    ui.img.alt = '';
    ui.img.hidden = true;
    ui.none = el('div', 'wt-none');
    ui.none.hidden = true;
    return add(pic, ui.img, ui.none);
  }
  function lookStrip(ui) {
    ui.looks = el('div', 'wt-looks');
    ui.looks.hidden = true;
    ui.looksRow = el('div', 'wt-lks');
    ui.looksRow.setAttribute('role', 'group');
    ui.looksRow.setAttribute('aria-label', 'Operator looked at');
    ui.lookKeys = [];
    ui.lookStep = null;
    return add(ui.looks, el('div', 'wt-lkh', 'Operator looked at'), ui.looksRow);
  }
  /* the step slider (returned) and the follow button (ui.now: beside it in the rail, in the top row on a page) */
  function scrubber(ui) {
    ui.scrub = el('input', 'wt-scrub');
    ui.scrub.type = 'range';
    ui.scrub.min = '0';
    ui.scrub.step = '1';
    ui.scrub.setAttribute('data-w', 'scrub');
    ui.scrub.setAttribute('aria-label', 'Step');
    ui.now = el('button', 'btn wt-now');
    ui.now.type = 'button';
    ui.now.setAttribute('data-wnow', '1');
    return ui.scrub;
  }
  function captionEls(ui) {
    ui.cap = el('p', 'wt-cap');
    ui.warn = el('p', 'wt-warn');
    ui.warn.setAttribute('role', 'status');
    ui.warn.hidden = true;
    return ui.cap;
  }
  /* the numbered camera buttons: top right over the picture or the 3D view, or (page mode) one row above both */
  function camRow(ui) {
    var row = el('div', 'wt-cams');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Camera');
    ui.cams = {};
    wtCams().forEach(function (c, k) {
      var b = el('button', 'wt-cb', k + 1);
      b.type = 'button';
      b.setAttribute('data-wcam', c.id);
      b.setAttribute('aria-label', 'Camera ' + (k + 1) + ': ' + camName(c));
      b.title = camName(c);
      ui.cams[c.id] = b;
      row.appendChild(b);
    });
    // on a phone (tiers S and M, CSS) the numbered buttons give way to one  ‹ | ›  that steps through the same cameras
    var nav = el('div', 'wt-cnav');
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', 'Camera');
    [['-1', '‹', 'Previous camera'], ['1', '›', 'Next camera']].forEach(function (x, i) {
      if (i) nav.appendChild(el('span', 'wt-cnsep'));
      var b = el('button', 'wt-cn', x[1]);
      b.type = 'button';
      b.setAttribute('data-wcamstep', x[0]);
      b.setAttribute('aria-label', x[2]);
      nav.appendChild(b);
    });
    row.appendChild(nav);
    return row;
  }
  /* the camera buttons (unless a page has them in a row of their own) and the active camera's name (bottom left), over the picture or the 3D view */
  function camOverlay(stage, ui, model, noCams) {
    var row = noCams ? null : camRow(ui);
    ui.name = el('div', 'wt-name');
    var foot = el('div', 'wt-foot'); // the camera's name (left) and, in Frames, the mode picker (right): one row, so they can't overlap
    ui.focus = el('div', 'wt-focus'); // "Step n / last · Focus: <part>", centred on a row of its own above them (truncated with … when long, in full as its tooltip)
    ui.focus.hidden = true;
    ui.focus.appendChild(el('span'));
    foot.appendChild(ui.focus);
    foot.appendChild(ui.name);
    if (model) { // the Model view's own picker: PBR · Lit · A · B · C, bottom right like the Frames one
      var vseg = el('div', 'wt-vmodes');
      vseg.setAttribute('role', 'group');
      vseg.setAttribute('aria-label', 'Model view');
      ui.vmodes = {};
      VMODES.forEach(function (x) {
        var b = el('button', 'wt-vb', x.text);
        b.type = 'button';
        b.setAttribute('data-wvmode', x.id);
        ui.vmodes[x.id] = b;
        vseg.appendChild(b);
      });
      foot.appendChild(vseg);
    }
    if (!model && wtModes().length > 1) {
      var seg = el('div', 'wt-modes');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Display mode');
      ui.modes = {};
      wtModes().forEach(function (m) {
        var b = el('button', 'wt-mb', modeShort(m.id));
        b.type = 'button';
        b.setAttribute('data-wmode', m.id);
        b.setAttribute('aria-label', modeName(m.id));
        b.title = modeName(m.id);
        ui.modes[m.id] = b;
        seg.appendChild(b);
      });
      foot.appendChild(seg);
      ui.modesBox = seg;
    }
    if (!model) { // a look shown in place of a frame has no modes: Close / Wide, when it has a wide companion
      var wide = el('div', 'wt-wide');
      wide.setAttribute('role', 'group');
      wide.setAttribute('aria-label', 'Look framing');
      wide.hidden = true;
      [['0', 'Close'], ['1', 'Wide']].forEach(function (x) {
        var b = el('button', 'wt-wb', x[1]);
        b.type = 'button';
        b.setAttribute('data-wwide', x[0]);
        wide.appendChild(b);
      });
      ui.wideBox = wide;
      foot.appendChild(wide);
    }
    if (model) { // the parts list, top left; the camera buttons give it a column
      if (row) row.classList.add('wt-cams-m');
      var pw = el('div', 'wt-pw');
      ui.partsBtn = el('button', 'wt-pt');
      ui.partsBtn.type = 'button';
      ui.partsBtn.setAttribute('data-wparts', '1');
      ui.partsList = el('div', 'wt-pl');
      ui.partsList.id = 'wt-pl';
      ui.partsList.setAttribute('role', 'group');
      ui.partsList.setAttribute('aria-label', 'Parts');
      ui.partsBtn.setAttribute('aria-controls', 'wt-pl');
      ui.partsKey = null;
      add(pw, ui.partsBtn, ui.partsList);
      stage.appendChild(pw);
    }
    add(stage, row, foot);
  }
  /* the parts list: a row per top-level mesh node of the model (from the viewer), a "Reference" row when the job has one, a mark on
     the focused part. The rows are rebuilt only when the set of parts (or the focus) changes, so a click or a focus ring survives a poll. */
  function paintParts(ui) {
    var h = wt.mv && wt.mv.handle;
    var list = h ? h.parts() : [];
    var focus = wtFocusSet();
    var ref = !!wtRef();
    var key = list.map(function (x) { return x.name; }).join('|') + '#' + (ref ? 'r' : '-') + '#' + Object.keys(focus).join('|');
    ui.partsBtn.textContent = (wt.partsOpen ? '▾' : '▸') + ' Parts';
    ui.partsBtn.setAttribute('aria-expanded', wt.partsOpen ? 'true' : 'false');
    ui.partsBtn.title = wt.partsOpen ? 'Hide the parts list' : 'Show or hide parts of the model';
    ui.partsList.hidden = !wt.partsOpen;
    if (ui.partsKey !== key) {
      ui.partsKey = key;
      while (ui.partsList.firstChild) ui.partsList.removeChild(ui.partsList.firstChild);
      var row = function (text, attr, name, isFocus) {
        var lab = el('label', 'wt-pr' + (isFocus ? ' focus' : ''));
        var box = el('input');
        box.type = 'checkbox';
        box.setAttribute(attr, name);
        if (isFocus) box.setAttribute('aria-label', text + ' (focus)');
        lab.title = text + (isFocus ? ' — focus: the part the last step acted on' : '');
        add(lab, box, el('span', '', text));
        if (isFocus) lab.appendChild(el('i', 'wt-pf', '◆'));
        ui.partsList.appendChild(lab);
        return box;
      };
      list.forEach(function (x) { row(x.name, 'data-wpart', x.name, !!focus[nodeKey(x.name)]); });
      if (ref) row('Reference', 'data-wpart-ref', '1', false);
    }
    Array.prototype.forEach.call(ui.partsList.querySelectorAll('input'), function (box) {
      if (box.hasAttribute('data-wpart-ref')) box.checked = wt.refOn;
      else box.checked = !wt.hidden[box.getAttribute('data-wpart')];
    });
  }
  function modelBody(sec, ui) {
    var m = wt.man.model;
    if (!m || !m.file) return add(sec, el('p', 'wt-msg', "This job has no model preview yet."));
    var stage = el('div', 'wt-stage');
    stage.appendChild(modelBox());
    camOverlay(stage, ui, true);
    ui.mcap = el('p', 'wt-cap');
    return add(sec, stage, wt.mv.anim, ui.mcap);
  }
  /* Page mode: the camera row, the picture and the 3D view as two squares, the Steps list in a column of its own, and the
     looks strip + scrubber + caption across the bottom. ui.mu is the 3D square's own set of overlay parts. */
  function pageBody(sec, ui) {
    var m = wt.man.model;
    var mu = (ui.mu = {});
    sec.classList.add('pg');
    var cams = camRow(ui);
    cams.classList.add('wt-pgc');
    var pair = el('div', 'wt-pgsq'); // the two squares, as large as the height and the width allow (CSS)
    var fs = el('div', 'wt-stage');
    fs.appendChild(framePic(ui));
    camOverlay(fs, ui, false, true);
    var ms = el('div', 'wt-stage');
    if (m && m.file) {
      ms.appendChild(modelBox());
      camOverlay(ms, mu, true, true);
      mu.label = el('div', 'wt-ml');
      mu.label.title = 'The share keeps only the latest preview model, so the 3D view does not follow the scrubber';
      ms.appendChild(mu.label);
    } else {
      ms.classList.add('wt-nomodel');
      ms.appendChild(el('div', 'wt-none', 'This job has no model preview yet.'));
    }
    add(pair, fs, ms);
    var col = el('div', 'wt-pgst');
    var lab = el('div', 'wt-slh', 'Steps');
    ui.stepCount = el('span', 'r');
    lab.appendChild(ui.stepCount);
    ui.stepList = el('div', 'wt-sl');
    ui.stepList.setAttribute('role', 'group');
    ui.stepList.setAttribute('aria-label', 'Steps');
    ui.stepKeys = [];
    ui.stepAt = null;
    add(col, lab, ui.stepList);
    if (typeof ResizeObserver === 'function') { // the list's height settles after the first paint (fonts, the tabs row): keep the step on show in view
      new ResizeObserver(function () {
        if (wt.ui !== ui) return;
        ui.stepAt = null;
        watchPaint();
      }).observe(ui.stepList);
    }
    var bot = el('div', 'wt-pgb');
    var ctl = el('div', 'wt-ctl');
    add(ctl, scrubber(ui), captionEls(ui));
    ui.head.appendChild(ui.now); // follow sits at the top right, with the job
    add(bot, lookStrip(ui), m && m.file ? wt.mv.anim : null, ctl, ui.warn);
    return add(sec, add(el('div', 'wt-pgm'), cams, pair, bot), col); // cameras, squares and controls are one block, from the top: when the squares are limited by width the strip appearing moves nothing above it
  }
  /* the Steps list: a button per manifest step, oldest first. New steps are appended (a scroll or a focus survives a poll);
     the step on show is marked and kept in view when it changes */
  function stepRow(s) {
    var b = el('button', 'wt-sr');
    b.type = 'button';
    b.setAttribute('data-wstep', s.n);
    var f = stepFocus(s);
    b.title = [s.verb, f && 'Focus: ' + f, s.note].filter(Boolean).join(' · ');
    var top = el('span', 'wt-sv');
    add(top, el('b', '', s.verb || 'step'), f && el('i', '', f));
    add(b, el('span', 'wt-sn', s.n), top, el('span', 'wt-st', clock(s.at)), s.note ? el('span', 'wt-so', s.note) : null);
    return b;
  }
  function paintSteps(ui, s) {
    var steps = wtSteps();
    var list = ui.stepList;
    if (!ui.stepKeys.every(function (n, k) { return steps[k] && steps[k].n === n; })) {
      while (list.firstChild) list.removeChild(list.firstChild);
      ui.stepKeys = [];
      ui.stepAt = null;
    }
    steps.slice(ui.stepKeys.length).forEach(function (x) {
      list.appendChild(stepRow(x));
      ui.stepKeys.push(x.n);
    });
    ui.stepCount.textContent = steps.length + (steps.length === 1 ? ' step' : ' steps');
    var on = null;
    Array.prototype.forEach.call(list.children, function (b) {
      var me = Number(b.getAttribute('data-wstep')) === s.n;
      b.classList.toggle('on', me);
      if (me) {
        b.setAttribute('aria-current', 'step');
        on = b;
      } else b.removeAttribute('aria-current');
    });
    if (on && ui.stepAt !== s.n) { // scroll the list itself (scrollIntoView would move the page too)
      ui.stepAt = s.n;
      var top = on.offsetTop, h = on.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + h > list.scrollTop + list.clientHeight) list.scrollTop = top + h - list.clientHeight;
    }
  }
  /* the 3D square says what it shows: always the latest preview (the share keeps no other), dimmed when the picture is another step */
  function paintModelLabel(mu, shownN) {
    var ms = wt.man.model.step;
    var other = ms != null && shownN !== ms;
    mu.label.textContent = 'Model: latest' + (ms != null ? ', step ' + ms : '') + (other ? ' (frame shows step ' + shownN + ')' : '');
    mu.label.classList.toggle('dim', other);
  }
  /* the Model view's viewer: one box per job, moved into each rebuilt layout (a moved canvas keeps its
     WebGL context) and reloaded in place when the manifest's model.step moves */
  function modelBox() {
    if (wt.mv && wt.mv.job === wt.job) return wt.mv.box;
    dropWatchViewer();
    var box = el('div', 'mv wt-mv');
    var mine = (wt.mv = { job: wt.job, box: box, handle: null, url: null, first: true, anim: el('div', 'wt-animhost') });
    box.addEventListener('mv-reffail', function () { // the viewer fell back to Lit and said so on its label line
      if (wt.mv !== mine) return;
      wt.refOn = false;
      if ((VMODES.filter(function (x) { return x.id === wt.vmode; })[0] || {}).ref) wt.vmode = 'lit';
      watchPaint();
    });
    box.addEventListener('mv-ready', function () {
      if (wt.mv !== mine || !mine.handle) return;
      wt.glb = mine.handle.glbCameras();
      if (mine.first) { // the first model opens on the chosen camera, if it has a pose
        mine.first = false;
        snap();
      }
      watchPaint();
    });
    import(new URL(BASE + 'viewer.js', location.href).href).then(function (m) {
      if (wt.mv !== mine) return;
      mine.url = modelUrl();
      mine.handle = m.mount(box, mine.url, { anim: false }); // the stage's corners and foot are taken (parts, cameras, view modes): the clips' row goes in its own line below it
      mine.anim.appendChild(m.animRow(mine.handle, box));
      applyView(true);
    }).catch(function (e) {
      box.dataset.state = 'error';
      box.appendChild(el('div', 'mv-st', 'The 3D viewer could not load (' + cap((e && e.message) || e, 80) + ').'));
    });
    return box;
  }
  function snap() {
    var c = wtCam();
    var p = c && poseOf(c);
    if (p && wt.mv && wt.mv.handle) wt.mv.handle.setCamera(p);
  }

  /* repaint everything that can change without a rebuild */
  function watchPaint() {
    var ui = wt.ui;
    if (!ui || tab !== 'watch') return;
    if (wt.sig !== wtSig()) return watchRefresh(); // the structure moved under a late callback
    if (ui.bare) return;
    (wt.jobs || []).forEach(function (j) {
      if (ui.opts && ui.opts[j.job]) ui.opts[j.job].textContent = j.job + (j.steps != null ? ' · ' + j.steps + ' steps' : '');
    });
    if (ui.sel) ui.sel.value = wt.job;
    if (ui.st !== 'ready') return;
    var cam = wtCam();
    var model = wtModelView();
    var mu = ui.mu; // page mode: the 3D square's own overlay parts (the camera buttons are shared)
    var look = wtLook();
    wtCams().forEach(function (c, k) {
      var b = ui.cams && ui.cams[c.id];
      if (!b) return;
      var on = cam && c.id === cam.id && !look; // a look in view: no camera is
      b.classList.toggle('on', !!on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var none = (model || (mu && mu.label)) && !poseOf(c);
      b.disabled = model && none; // on a page a camera with no saved view still picks its frame; only the 3D view stays put
      b.title = camName(c) + (none ? (model ? ' — no saved view' : ' — no saved 3D view') : '');
      b.setAttribute('aria-label', 'Camera ' + (k + 1) + ': ' + camName(c) + (none ? (model ? ' (no saved view)' : ' (no saved 3D view)') : ''));
    });
    paintLabels(ui, cam, look, model);
    if (mu) paintLabels(mu, cam, null, true);
    if (ui.modesBox) ui.modesBox.hidden = !!look;
    if (ui.wideBox) {
      ui.wideBox.hidden = !(look && look.wide);
      Array.prototype.forEach.call(ui.wideBox.children, function (b) {
        var on = (b.getAttribute('data-wwide') === '1') === !!wt.wide;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    Object.keys(ui.modes || {}).forEach(function (id) {
      ui.modes[id].classList.toggle('on', id === wtMode());
      ui.modes[id].setAttribute('aria-pressed', id === wtMode() ? 'true' : 'false');
    });
    if (model) {
      if (!ui.mcap) return; // this job has no model
      paintModel(ui);
      ui.mcap.textContent = wt.man.model.step != null ? 'Model at step ' + wt.man.model.step : 'Model preview';
    } else {
      if (mu) {
        var cur = wtSteps()[wtIdx()];
        paintSteps(ui, cur);
        if (mu.label) {
          paintModel(mu);
          paintModelLabel(mu, cur.n);
        }
      }
      paintFrames(ui, cam, look);
    }
    if (ui.warn) {
      ui.warn.textContent = wt.err ? 'Lost touch with the watch share — trying again.' : wt.bad ? "That frame couldn't be loaded." : '';
      ui.warn.hidden = !ui.warn.textContent;
    }
    reportHeight();
  }
  /* the camera's name (or the look's) and "Step n / last · Focus: <part>" over a picture or the 3D view; model: the step the preview belongs to */
  function paintLabels(u, cam, look, model) {
    if (u.name) u.name.textContent = look ? look.label : cam ? camName(cam) : '';
    if (u.focus) {
      var n = shownN(model);
      var fc = stepFocus(focusStep(model));
      var lead = (isFinite(n) ? 'Step ' + n + ' / ' + wtTotal() : '') + (isFinite(n) && fc ? ' · ' : '');
      u.focus.firstChild.textContent = lead + (fc ? 'Focus: ' + cap(fc, 120) : '');
      u.focus.firstChild.title = lead + (fc ? 'Focus: ' + fc : '');
      u.focus.hidden = !lead && !fc;
    }
  }
  /* the 3D view's own buttons, parts list and (a newer preview) reload; u is the overlay parts it was built with */
  function paintModel(u) {
    var vm = wtVMode();
    VMODES.forEach(function (x) {
      var b = u.vmodes && u.vmodes[x.id];
      if (!b) return;
      var off = !!x.ref && !wtRef();
      b.classList.toggle('on', x.id === vm);
      b.setAttribute('aria-pressed', x.id === vm ? 'true' : 'false');
      b.disabled = off;
      b.title = off ? NO_REF : vmodeName(x);
      b.setAttribute('aria-label', vmodeName(x) + (off ? ' — ' + NO_REF : ''));
    });
    applyView();
    paintParts(u);
    if (wt.mv && wt.mv.handle && wt.mv.url !== modelUrl()) { // a newer preview: reload, the camera stays where it is
      wt.mv.url = modelUrl();
      wt.mv.handle.load(wt.mv.url);
    }
  }
  /* the "Operator looked at" strip for the step on show: nothing (hidden, no space) when it has no looks. The same step
     gaining looks adds buttons to the row, so a scroll or a focus in it survives a poll. */
  function paintLooks(ui, s, look) {
    var list = looksOf(s);
    ui.looks.hidden = !list.length;
    if (ui.lookStep !== s.n || !ui.lookKeys.every(function (f, k) { return list[k] && list[k].file === f; })) {
      while (ui.looksRow.firstChild) ui.looksRow.removeChild(ui.looksRow.firstChild);
      ui.lookKeys = [];
      ui.lookStep = s.n;
    }
    list.slice(ui.lookKeys.length).forEach(function (l) {
      var b = el('button', 'wt-lk');
      b.type = 'button';
      b.setAttribute('data-wlook', l.file);
      b.setAttribute('aria-label', l.label);
      b.title = l.label;
      var im = el('img');
      im.alt = '';
      im.loading = 'lazy';
      im.src = lookUrl(l.file);
      b.appendChild(im);
      ui.looksRow.appendChild(b);
      ui.lookKeys.push(l.file);
    });
    Array.prototype.forEach.call(ui.looksRow.children, function (b) {
      var on = !!look && b.getAttribute('data-wlook') === look.file;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function paintFrames(ui, cam, look) {
    var steps = wtSteps();
    var i = wtIdx();
    var s = steps[i];
    var total = wtTotal();
    ui.scrub.max = String(steps.length - 1);
    ui.scrub.value = String(i);
    ui.scrub.disabled = steps.length < 2;
    ui.scrub.setAttribute('aria-valuetext', 'Step ' + s.n + ' of ' + total);
    var fresh = wt.follow ? 0 : Math.max(0, steps.length - wt.seen);
    ui.now.textContent = '▶|' + (fresh ? ' ' + fresh + ' new' : '');
    ui.now.classList.toggle('on', wt.follow);
    ui.now.setAttribute('aria-pressed', wt.follow ? 'true' : 'false');
    ui.now.setAttribute('aria-label', 'Jump to the latest step' + (fresh ? ', ' + fresh + ' new' : ''));
    ui.now.title = wt.follow ? 'Following the latest step' : 'Jump to the latest step and follow';
    // the camera's frame in the chosen mode at this step; else (see pickFrame) another mode here, or an earlier step
    var pick = cam && !look ? pickFrame(steps, i, cam) : null;
    var from = pick && pick.step;
    var picker = wtModes().length > 1;
    ui.cap.textContent = '';
    var parts = ['Step ' + s.n + ' of ' + total, s.verb, s.note, clock(s.at)].filter(Boolean);
    ui.cap.appendChild(document.createTextNode(parts.join(' · ')));
    var why = '';
    if (pick && pick.kind === 'mode') why = camName(cam) + ', ' + (pick.only ? modeTag(pick.mode) + ' only' : 'no ' + modeTag(wtMode()) + ' here, showing ' + modeTag(pick.mode));
    else if (pick && pick.kind === 'earlier') why = camName(cam) + (picker && pick.mode ? ' · ' + modeTag(pick.mode) : '') + ', from step ' + from.n;
    // a mode other than plain is named in full (the buttons only carry a letter)
    if (picker && pick && pick.mode && pick.mode !== 'plain') ui.cap.appendChild(document.createTextNode(' · ' + modeName(pick.mode)));
    if (why) ui.cap.appendChild(el('span', 'from', ' · ' + why));
    paintLooks(ui, s, look);
    if (look) { // the look stands in for the camera's frame: its close-up, or the wide companion when asked for
      var path = wt.wide && look.wide ? look.wide : look.file;
      showFrame(ui, lookUrl(path), 'look/' + wt.job + '/' + path, look.label + (path === look.wide ? ' (wide)' : '') + ', step ' + s.n);
      return;
    }
    if (!from) {
      wt.want = wt.shown = null;
      ui.img.hidden = true;
      ui.none.hidden = false;
      ui.none.textContent = (cam ? camName(cam) : 'This') + ' has no frame yet at this step.';
      return;
    }
    showFrame(ui, framePath(wt.job, cam.id, from.n, pick.mode), wt.job + '/' + cam.id + '/' + (pick.mode || '') + '/' + from.n, camName(cam) + (pick.mode ? ' · ' + modeName(pick.mode) : '') + ', step ' + from.n);
  }
  /* preload the frame, THEN swap it in, so the picture never goes blank between two steps */
  function showFrame(ui, src, key, alt) {
    ui.none.hidden = true;
    if (wt.badKey === key) { // it failed; the next poll tries once more
      wt.bad = true;
      return;
    }
    if (wt.shown === key) {
      if (!ui.img.getAttribute('src')) ui.img.src = src; // a rebuilt section: the same picture, from cache
      ui.img.hidden = false;
      return;
    }
    wt.want = key;
    wt.bad = false;
    var pre = new Image();
    pre.onload = function () {
      if (wt.want !== key || wt.ui !== ui) return;
      ui.img.src = src;
      ui.img.alt = alt;
      ui.img.hidden = false;
      wt.shown = key;
      wt.bad = false;
      watchPaint();
    };
    pre.onerror = function () {
      if (wt.want !== key) return;
      wt.badKey = key;
      wt.bad = true;
      watchPaint();
    };
    pre.src = src;
  }

  /* a change in the data: rebuild if the structure moved, else repaint */
  /* a selector for the watch control that has focus, to give it back after a rebuild */
  function wtFocusKey() {
    var a = document.activeElement;
    if (!a || !root.contains(a) || !a.getAttribute) return '';
    var v = a.getAttribute('data-wview');
    return v ? '[data-wview="' + v + '"]' : a.getAttribute('data-w') === 'job' ? '[data-w="job"]' : '';
  }
  function watchRefresh() {
    if (tab !== 'watch' || !data) return;
    if (!wt.ui || wtSig() !== wt.sig) render();
    else watchPaint();
  }
  function setJob(id) {
    wt.job = id;
    wt.man = null;
    wt.gone = false;
    wt.cam = null;
    wt.mode = null;
    wt.hidden = {};
    wt.refOn = !!(VMODES.filter(function (x) { return x.id === wt.vmode; })[0] || {}).ref; // a mode that draws the reference has it ticked
    wt.look = null;
    wt.wide = false;
    wt.at = null;
    wt.follow = true;
    wt.seen = 0;
    wt.shown = wt.want = null;
    wt.bad = false;
    dropWatchViewer();
  }
  function watchPoll() {
    var job = null;
    wt.badKey = null;
    fetch(BASE + 'watch.json', { cache: 'no-cache', credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.ok !== true) throw new Error('watch');
        if (j.error && wt.jobs && wt.jobs.length) wt.err = j.error; // keep what we had
        else {
          wt.jobs = j.jobs || [];
          wt.err = j.error || '';
        }
        var pick = wt.picked ? wt.jobs.filter(function (x) { return x.job === wt.job; })[0] : null;
        var want = pick ? pick.job : wt.jobs.length ? wt.jobs[0].job : null;
        if (!pick) wt.picked = false;
        if (want !== wt.job) setJob(want);
        job = wt.job;
        if (!job || wt.err) return null;
        return fetch(BASE + 'watch.json?job=' + encodeURIComponent(job), { cache: 'no-cache', credentials: 'omit' })
          .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); });
      })
      .then(function (m) {
        if (!m || job !== wt.job) return;
        if (m.body && m.body.ok === true) {
          var first = !wt.man;
          wt.man = m.body;
          wt.gone = false;
          if (wt.follow || first) wt.seen = wtSteps().length;
        } else if (m.status === 404) {
          wt.man = null;
          wt.gone = true;
        } else wt.err = (m.body && m.body.error) || 'share';
      })
      .catch(function () {
        wt.err = 'unreachable';
      })
      .then(function () {
        if (tab !== 'watch') return;
        watchRefresh();
        schedule();
      });
  }

  /* ---- Review: Waiting + Replied (newest activity first), then "Resolved (n) ▸" collapsed */

  /* Favorites / Recycle: that folder's images, grouped by generation, newest first. */
  function folderSecs(d) {
    var gens = d.generations.filter(function (g) {
      return shown(g);
    });
    if (!gens.length) {
      return [el('div', 'empty', tab === 'favorites' ? 'No favorites yet. Tell the agent which images you like.' : 'Recycle is empty. Images the agent sets aside land here, and can always come back.')];
    }
    return [earlierSec(gens, tab === 'favorites' ? 'Favorites' : 'Recycle')];
  }

  /* ---- Review: Waiting (newest activity first), then Replied, then "Resolved (n) ▸" collapsed */
  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
  }
  var STATE_WORD = { waiting: 'Waiting', replied: 'Replied', resolved: 'Resolved' };
  /* The MODE of a submission ("status / preview, feedback requested, voting on versions"): a plain outlined chip on
     every row and heading every submission, in his three words (Aurora: no color per mode). A submission from before it was
     asked says nothing, and is a request for feedback: the thumbs and comments it always had. */
  var PURPOSE_WORD = { status: 'Status', feedback: 'Feedback requested', vote: 'Vote' };
  var PURPOSE_ASK = { status: 'Nothing is asked of you' }; // feedback and vote: only an ask the agent wrote; the chip already says the rest
  function modeChip(purpose) {
    return el('span', 'mode', PURPOSE_WORD[purpose] || PURPOSE_WORD.feedback);
  }
  function askOf(purpose, ver) {
    return (ver && ver.ask) || PURPOSE_ASK[purpose] || '';
  }
  var FILE_WORD = { blend: 'Editable Blender source', model: 'Viewable model', manifest: 'Manifest', images: 'Images', other: 'File' };
  function fmtSize(n) {
    if (typeof n !== 'number' || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576 < 10 ? Math.round(n / 104857.6) / 10 : Math.round(n / 1048576)) + ' MB';
  }
  /* a fold: a colored heading bar that opens and closes (Aurora: level 1). Its state is the viewer's, per key, kept across redraws. */
  var folds = {};
  function foldOpen(key, dflt) {
    return Object.prototype.hasOwnProperty.call(folds, key) ? folds[key] : dflt;
  }
  function fold(key, title, count, dflt, body) {
    var open = foldOpen(key, dflt);
    var box = el('section', 'fold');
    var h = add(el('button', 'hbar'), el('span', 'caret', open ? '\u25be' : '\u25b8'), el('span', 'ht', title), count === null || count === undefined ? null : el('span', 'n', String(count)));
    h.type = 'button';
    h.setAttribute('data-fold', key);
    h.setAttribute('data-fdef', dflt ? '1' : '0');
    h.setAttribute('aria-expanded', open ? 'true' : 'false');
    box.appendChild(h);
    if (open) box.appendChild(body);
    return box;
  }
  /* the files of one version: each named by what it is for, its own name, type and size under it, and a Download (the Blender source is the main button) */
  function downloadsBody(ver) {
    var rows = el('div', 'dlrows');
    ver.files.forEach(function (f) {
      var row = el('div', 'dl');
      var tx = el('div', 'dtx');
      tx.appendChild(el('div', 'dpur', f.label || FILE_WORD[f.role] || FILE_WORD.other));
      tx.appendChild(el('div', 'dnm', [f.name, f.type && f.type.toLowerCase() !== (f.name.split('.').pop() || '').toLowerCase() ? f.type : '', fmtSize(f.size)].filter(Boolean).join(' \u00b7 ')));
      var a = el('a', 'btn' + (f.role === 'blend' ? ' pri' : ''), 'Download');
      a.href = BASE + f.href;
      a.setAttribute('download', f.name);
      a.setAttribute('aria-label', 'Download ' + (f.label || FILE_WORD[f.role] || f.name));
      add(row, tx, a);
      rows.appendChild(row);
    });
    return rows;
  }
  function card(it) {
    var c = el('button', 'card' + (it.n === curN ? ' cur' : ''));
    c.type = 'button';
    c.setAttribute('data-n', it.n);
    var raw = rawItem(it.n); // ratings are read off the Review tab's raw items (0-based image indices)
    var nu = raw ? draftCount(raw) + pendingMarks(raw) : 0;
    var tl = raw ? tally(raw) : null;
    c.setAttribute('aria-label', '#' + it.n + ' ' + it.title + ', ' + (PURPOSE_WORD[it.purpose] || PURPOSE_WORD.feedback) + ', ' + STATE_WORD[it.status] + (it.versions > 1 ? ', version ' + it.versions : '') + (tl ? ', rated ' + tl.getAttribute('aria-label') : '') + (nu ? ', ' + nu + ' not sent' : ''));
    var r1 = add(el('div', 'c1'), el('span', 'num', '#' + it.n), el('span', 'ttl', it.title));
    if (it.versions > 1) r1.appendChild(el('span', 'chip', 'v' + it.latest.v));
    if (it.status === 'resolved') r1.appendChild(add(el('span', 'state resolved'), el('i'), document.createTextNode(STATE_WORD.resolved)));
    if (tl) {
      var fm = add(el('span', 'fbm'), tl);
      fm.title = 'Your ratings on v' + it.latest.v + (nu ? ' — ' + nu + ' not sent yet' : '');
      r1.appendChild(fm);
    }
    if (nu) r1.appendChild(el('span', 'unsent', nu + ' unsent'));
    c.appendChild(r1);
    var cask = askOf(it.purpose, it.latest);
    c.appendChild(add(el('div', 'cm'), modeChip(it.purpose), cask ? el('span', 'cask', cask) : null));
    if (it.latest.note) c.appendChild(el('div', 'c2', it.latest.note));
    var r3 = el('div', 'c3');
    var rawMeshes = (raw && raw.meshes) || {};
    it.latest.images.forEach(function (id, k) {
      var t = img(BASE + 'thumb/' + encodeURIComponent(id));
      t.setAttribute('data-i', k);
      if (rawMeshes[id]) { // a model: its picture or the plain 3D tile, with the cube badge over it
        var w = el('span', 'c3m');
        w.setAttribute('data-i', k);
        t.removeAttribute('data-i');
        t.addEventListener('error', function () {
          var ph = el('span', 'ph3d', '3D');
          if (t.parentNode) t.parentNode.replaceChild(ph, t);
        });
        add(w, t, cubeBadge());
        r3.appendChild(w);
        return;
      }
      t.addEventListener('error', function () { // (older reviews: a model's missing picture, before it was known to be one)
        var ph = el('span', 'ph3d c3ph', '3D');
        ph.setAttribute('data-i', k);
        if (t.parentNode) t.parentNode.replaceChild(ph, t);
      });
      r3.appendChild(t);
    });
    c.appendChild(r3);
    c.appendChild(el('div', 'c4', (it.agent ? '@' + it.agent + ' · ' : '') + clock(it.latest.at)));
    return c;
  }
  function byActivity(a, b) {
    return Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.n - a.n;
  }
  /* The Review list (unified review, Aurora): three groups, each with its own heading and count, in this order —
     "Needs your response" (a Vote or Feedback not yet submitted), "Status" (reports, which never ask; above the next so a new
     one is not buried under every request already answered), "Submitted to agent" (you sent it) — and Resolved folded away at the end. Headings, not a sorted flat list, are what stop a new report burying an old
     request. The badge counts only the first group. A card says "N unsent" on its own. Submit is on each review's summary. */
  function reviewSecs(d) {
    var items = d.reviews || [];
    var sec = section();
    if (goneN !== null) sec.appendChild(el('div', 'gone', 'Review #' + goneN + " isn't here any more"));
    if (!items.length) {
      sec.appendChild(el('div', 'empty', 'No review items yet — an agent adds them with review_add.'));
      return [sec];
    }
    var live = function (it) { return it.status !== 'resolved'; };
    var needs = items.filter(function (it) { return it.needs; }).sort(byActivity);
    var agent = items.filter(function (it) { return !it.needs && it.purpose !== 'status' && live(it); }).sort(byActivity);
    var stat = items.filter(function (it) { return it.purpose === 'status' && live(it); }).sort(byActivity);
    var done = items.filter(function (it) { return !live(it); }).sort(byActivity);
    function group(key, cls, title, list, emptyText) {
      if (!list.length && !emptyText) return;
      var h = add(el('h2', 'hbar ' + cls), el('span', 'ht', title), el('span', 'n', String(list.length)));
      h.setAttribute('data-group', key);
      sec.appendChild(h);
      if (!list.length) return sec.appendChild(el('div', 'empty', emptyText));
      var rows = el('div', 'rlist');
      list.forEach(function (it) { rows.appendChild(card(it)); });
      sec.appendChild(rows);
    }
    group('needs', 'needs', 'Needs your response', needs, 'Nothing needs your response.');
    group('status', 'status', 'Status', stat); // above "Submitted to agent": a new report must not sit under a long list of old requests
    group('agent', 'agent', 'Submitted to agent', agent);
    if (done.length) {
      var rows = el('div', 'rlist');
      done.forEach(function (it) { rows.appendChild(card(it)); });
      sec.appendChild(fold('resolved', 'Resolved', done.length, false, rows));
    }
    return [sec];
  }
  function openReview(n, v, i) {
    curN = n;
    // a card opens the LATEST version (v null), a card thumb on THAT image, the card body on the first;
    // only an explicit ref (review/<n>/v<k>) asks for a version. The form follows the image (fbSync).
    large = { n: n, v: v || null, i: i || 0 };
    if (!sbar.bad) sbar.msg = ''; // "✓ Review sent" was for the list
    render();
    window.scrollTo(0, 0);
  }
  function closeReview() {
    if (!large) return;
    flashN = large.n;
    large = null;
    render();
  }

  /* ---- the large view (in-frame): the item at version v, image i on the stage. Stacked below
     520 px with the image locked to 188 px (the strip + the note's first line stay above the
     fold); image | note side by side from 520. Width caps only, never vh. */
  /* The image on the stage, its box reserved before it loads (aspect from the thumb, a height cap), the
     thumb blurred in it meanwhile; once in, the item's other images are fetched ahead of a tap. */
  function imageBox(it, ver, idx, id) {
    var mesh = it.meshes && it.meshes[id];
    if (mesh) return meshBox(id, mesh);
    var cur = el('div', 'cur');
    cur.style.setProperty('--ar', String(lastAr));
    var ph = img(BASE + 'thumb/' + encodeURIComponent(id));
    ph.className = 'ph';
    ph.loading = 'eager';
    ph.alt = '';
    ph.addEventListener('load', function () {
      if (ph.naturalWidth && ph.naturalHeight) cur.style.setProperty('--ar', String(lastAr = ph.naturalWidth / ph.naturalHeight));
    });
    var big = el('img', 'big');
    big.crossOrigin = 'anonymous'; // the backdrop sample reads its pixels (the file route is CORS-open)
    big.alt = '#' + it.n + ' image ' + (idx + 1) + ' of ' + ver.images.length;
    big.addEventListener('load', function () {
      if (big.naturalWidth && big.naturalHeight) cur.style.setProperty('--ar', String(lastAr = big.naturalWidth / big.naturalHeight));
      cur.classList.add('loaded');
      backdrop(cur, big);
      // then ALL the item's other images, in order (a reviewer looks at every one)
      ver.images.forEach(function (x) {
        var u = BASE + 'file/' + encodeURIComponent(x);
        if (x === id || preloaded[u]) return;
        preloaded[u] = true;
        new Image().src = u;
      });
    });
    big.src = BASE + 'file/' + encodeURIComponent(id);
    if (big.complete && big.naturalWidth) cur.classList.add('loaded'); // already cached: no blur flash
    return add(cur, ph, big, el('span', 'ld', 'Loading…'));
  }
  /* A mesh under review (the model domain's): the 3D viewer on its viewer copy; too big = its thumbnail */
  function meshBox(id, view) {
    var cur = el('div', 'cur mesh');
    var inner = el('div', 'mdl');
    if (view === 'glb') inner.appendChild(viewerBox(id));
    else {
      var box = add(el('div', 'mv mv-thumb'), img(BASE + 'thumb/' + encodeURIComponent(id)));
      inner.appendChild(box);
    }
    return add(cur, inner);
  }
  function itemOf(d) {
    return (d.review_items || []).filter(function (x) { return x.n === large.n; })[0];
  }
  function verIdx(it) {
    var ver = it.versions.filter(function (x) { return x.v === large.v; })[0] || it.versions[it.versions.length - 1];
    var idx = Math.min(Math.max(0, large.i | 0), ver.images.length - 1);
    large.v = ver.v;
    large.i = idx;
    return { ver: ver, idx: idx, latestV: it.versions[it.versions.length - 1].v };
  }
  /* REVIEW, three levels (v3 nav, Aurora 13f29fb; ): the list → the SUMMARY (an overview: what
     you'll be working with — the review's note, a row per image, your overall note, the status and Submit; no
     rating controls) → the FOCUS page, where reviewing happens (pager, Mark, 👍/👎, comment, references, Info).
     Back links: "‹ Review List" · "‹ Summary" · "‹ Focus". Everything saves as you go; Submit only on the summary. */
  function reviewHead(backAttr, backText, it, ver) {
    var head = el('div', 'rv-h');
    var back = el('button', 'back', '\u2039 ' + backText);
    back.type = 'button';
    back.setAttribute(backAttr, '1');
    head.appendChild(back);
    if (!it) return head;
    add(head, add(el('h1'), el('span', 'num', '#' + it.n), document.createTextNode(' \u00b7 ' + it.title)));
    if (it.versions.length > 1) {
      var vers = el('div', 'vers');
      vers.setAttribute('role', 'group');
      vers.setAttribute('aria-label', 'Versions');
      it.versions.forEach(function (x) {
        var b = el('button', 'ver' + (x.v === ver.v ? ' on' : ''), 'v' + x.v);
        b.type = 'button';
        b.setAttribute('data-ver', x.v);
        if (x.v === ver.v) b.setAttribute('aria-current', 'true');
        vers.appendChild(b);
      });
      head.appendChild(vers);
    } else head.appendChild(el('span', 'chip', 'v' + ver.v));
    head.appendChild(modeChip(it.purpose));
    return head;
  }
  /* ---- the submission PACKAGE (unified review P2): named views in one strip (the model first), alternatives as tabs, a PICK between
     them in the request box, and whole-result acceptance by scope. A "package" version is one whose agent said what kind of answer it
     wants (purpose) or named its views / alternatives; an older review keeps its per-image rows and thumbs, exactly as before. */
  function isPkg(ver) {
    return !!(ver.purpose !== undefined || ver.alternatives || ver.captions);
  }
  var altSel = {}; // 'n:v' -> the alternative on show (the tabs only choose what you LOOK at; they never change the pick)
  var pcmt = { n: null, text: '' }; // the pick's comment being typed
  var pcmtTimer = null;
  function pickOf(it, ver) { // the draft pick, else the last one sent on this version
    var d = it.unsent && it.unsent.v === ver.v && it.unsent.pick;
    if (d) return { alt: d.alt, comment: d.comment || '', sent: false };
    var s = (ver.feedback || []).filter(function (f) { return f.pick !== undefined; }).slice(-1)[0];
    return s ? { alt: s.pick, comment: s.comment || '', sent: true } : null;
  }
  function scopeOf(it, ver, scope) {
    var d = it.unsent && it.unsent.v === ver.v && it.unsent.scopes && it.unsent.scopes[scope];
    if (d) return { decision: d.decision, sent: false };
    var s = (ver.feedback || []).filter(function (f) { return f.scope === scope; }).slice(-1)[0];
    return s ? { decision: s.decision, sent: true } : null;
  }
  function altWord(a) {
    return a.id.toUpperCase() + ' · ' + a.label;
  }
  /* the views: alternative tabs above (they choose what is shown; the pick is in the request box), then ONE strip of tiles — the model
     first (a 3D badge), each with its name and its rating; a tile opens that view's review page. Views in no alternative show in every tab. */
  function viewsSec(it, ver) {
    var sec = el('section', 'sum-sec');
    var alts = ver.alternatives || [], sel = null;
    if (alts.length) {
      sel = altSel[it.n + ':' + ver.v];
      if (!alts.some(function (a) { return a.id === sel; })) sel = alts[0].id;
      var tabs = el('div', 'alts');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Alternatives');
      var pk = pickOf(it, ver);
      alts.forEach(function (a) {
        var on = a.id === sel;
        var b = el('button', 'alt' + (on ? ' on' : ''), altWord(a) + (pk && pk.alt === a.id ? ' ✓' : ''));
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.setAttribute('data-alt', a.id);
        tabs.appendChild(b);
      });
      sec.appendChild(tabs);
    }
    var inAlt = {};
    alts.forEach(function (a) { a.images.forEach(function (id) { inAlt[id] = a.id; }); });
    var isMesh = function (id) { return !!(it.meshes && it.meshes[id]); };
    var show = ver.images.map(function (id, k) { return { id: id, k: k }; }).filter(function (x) { return !sel || !inAlt[x.id] || inAlt[x.id] === sel; });
    show.sort(function (a, b) { return (isMesh(a.id) ? 0 : 1) - (isMesh(b.id) ? 0 : 1) || a.k - b.k; });
    sec.appendChild(el('p', 'sum-lbl', 'Views · ' + show.length));
    var strip = el('div', 'vstrip');
    show.forEach(function (x) {
      var f = baseline(it, ver, x.k);
      var name = (ver.captions && ver.captions[x.id]) || '';
      var tile = el('button', 'vt');
      tile.type = 'button';
      tile.setAttribute('data-frow', String(x.k));
      var th = add(el('span', 'ith'), isMesh(x.id) ? meshThumb(x.id) : img(BASE + 'thumb/' + encodeURIComponent(x.id)));
      if (!isMesh(x.id)) numBadge(th, it, x.id); // a model is not "image #4"
      if (isMesh(x.id)) th.appendChild(cubeBadge());
      if (f) th.appendChild(add(el('span', 'vmk'), thumbIcon(f.verdict)));
      add(tile, th, el('span', 'vcap', name));
      tile.setAttribute('aria-label', (isMesh(x.id) ? 'Model' : 'View') + ' ' + (x.k + 1) + (name ? ', ' + name : '') + ' — open to review');
      strip.appendChild(tile);
    });
    sec.appendChild(strip);
    return sec;
  }
  /* the pick, in the request box under the sentence: one row, "Pick A · Warm", "Pick B · Cool", "Neither", then an optional comment */
  function pickBlock(it, ver, latestV) {
    var alts = ver.alternatives || [];
    if (!alts.length) return null;
    var live = !!(port && ver.v === latestV);
    var pk = pickOf(it, ver);
    var box = el('div', 'pickbox');
    var row = el('div', 'pickrow');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'Your pick');
    alts.concat([{ id: 'none' }]).forEach(function (a) {
      var on = !!(pk && pk.alt === a.id);
      var b = el('button', 'pk' + (on ? ' on' : ''), a.id === 'none' ? 'Neither' : 'Pick ' + altWord(a));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.setAttribute('data-pick', a.id);
      b.disabled = !live;
      row.appendChild(b);
    });
    box.appendChild(row);
    if (live) {
      var ta = el('textarea', 'pkc');
      ta.setAttribute('data-pickcmt', String(it.n));
      ta.rows = 2;
      ta.maxLength = 2000;
      ta.placeholder = pk ? 'Why? (optional)' : 'Pick one to add a comment';
      ta.disabled = !pk;
      ta.value = pcmt.n === it.n ? pcmt.text : (pk ? pk.comment : '');
      box.appendChild(ta);
    }
    if (pk && !pk.sent) box.appendChild(el('span', 'unsent', 'unsent'));
    return box;
  }
  /* whole-result acceptance: its own row of scope chips, each Approve / Changes — never implied by a thumb on one view */
  function scopesSec(it, ver, latestV) {
    var scopes = ver.scopes || [];
    if (!scopes.length) return null;
    var live = !!(port && ver.v === latestV);
    var sec = el('section', 'sum-sec');
    sec.appendChild(el('p', 'sum-lbl', 'Accept the whole result'));
    var box = el('div', 'scopes');
    scopes.forEach(function (sc) {
      var cur = scopeOf(it, ver, sc);
      var row = el('div', 'scope');
      row.appendChild(el('span', 'sn', sc));
      [['approve', 'Approve'], ['changes', 'Changes']].forEach(function (d) {
        var on = !!(cur && cur.decision === d[0]);
        var b = el('button', 'sd' + (on ? ' on' : ''), d[1]);
        b.type = 'button';
        b.setAttribute('data-scope', sc);
        b.setAttribute('data-sdec', d[0]);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.setAttribute('aria-label', d[1] + ' ' + sc);
        b.disabled = !live;
        row.appendChild(b);
      });
      if (cur && !cur.sent) row.appendChild(el('span', 'unsent', 'unsent'));
      box.appendChild(row);
    });
    sec.appendChild(box);
    return sec;
  }
  /* local copies until the poll lands (as patchDraft does for ratings) */
  function patchWhole(n, v, fn) {
    var it = rawItem(n);
    if (!it) return;
    if (!it.unsent || it.unsent.v !== v) it.unsent = { v: v, images: {} };
    fn(it.unsent);
    if (it.unsent.scopes && !Object.keys(it.unsent.scopes).length) delete it.unsent.scopes;
    if (!Object.keys(it.unsent.images).length && !it.unsent.item && !it.unsent.pick && !it.unsent.scopes) it.unsent = null;
  }
  function doPick(n, alt) {
    var it = rawItem(n);
    if (!it) return;
    var ver = it.versions[it.versions.length - 1], cur = pickOf(it, ver);
    var clear = !!(cur && !cur.sent && cur.alt === alt); // the same unsent pick again takes it back
    var comment = (pcmt.n === n ? pcmt.text : cur ? cur.comment : '').trim();
    var input = { pick: clear ? '' : alt };
    if (!clear && comment) input.comment = comment;
    var sent = sendAction('review_feedback', { n: String(n) }, input, function (r) {
      if (r.ok === true) {
        patchWhole(n, ver.v, function (u) { if (clear) delete u.pick; else u.pick = { alt: alt, comment: comment, at: new Date().toISOString() }; });
        if (pcmt.n === n) pcmt = { n: null, text: '' };
      } else if (!r.blocked) toast('Not saved: ' + (r.error || 'try again'));
      lastSig = '';
      redraw();
    });
    if (!sent) toast(blocked() ? 'Asset Studio needs approving first (Settings → Apps)' : 'One moment — then tap again');
  }
  function savePickCmt() {
    if (pcmt.n === null) return;
    var job = { n: pcmt.n, text: pcmt.text };
    var it = rawItem(job.n);
    if (!it) return;
    var ver = it.versions[it.versions.length - 1], cur = pickOf(it, ver);
    if (!cur) return;
    var comment = job.text.trim();
    var input = { pick: cur.alt };
    if (comment) input.comment = comment;
    var sent = sendAction('review_feedback', { n: String(job.n) }, input, function (r) {
      if (r.ok === true) {
        patchWhole(job.n, ver.v, function (u) { u.pick = { alt: cur.alt, comment: comment, at: new Date().toISOString() }; });
        if (pcmt.n === job.n && pcmt.text === job.text) pcmt = { n: null, text: '' };
        lastSig = '';
      } else if (!r.blocked) toast('Comment not saved: ' + (r.error || 'try again'));
      if (!typing()) redraw();
    });
    if (!sent) pcmtTimer = setTimeout(savePickCmt, FB_GAP_MS); // an action in flight: try again in a moment
  }
  function doScope(n, scope, decision) {
    var it = rawItem(n);
    if (!it) return;
    var ver = it.versions[it.versions.length - 1], cur = scopeOf(it, ver, scope);
    var clear = !!(cur && !cur.sent && cur.decision === decision);
    var sent = sendAction('review_feedback', { n: String(n) }, { scope: scope, decision: clear ? '' : decision }, function (r) {
      if (r.ok === true) patchWhole(n, ver.v, function (u) { u.scopes = u.scopes || {}; if (clear) delete u.scopes[scope]; else u.scopes[scope] = { decision: decision, at: new Date().toISOString() }; });
      else if (!r.blocked) toast('Not saved: ' + (r.error || 'try again'));
      lastSig = '';
      redraw();
    });
    if (!sent) toast(blocked() ? 'Asset Studio needs approving first (Settings → Apps)' : 'One moment — then tap again');
  }
  var noteOpen = {}; // n -> the review's note shown in full (the summary's "… show")
  var onote = { n: null, text: '' }; // the overall note being typed (saved by review_note a moment after the last key)
  function largeSec(d) {
    if (large.focus) return focusSec(d);
    var it = itemOf(d);
    var box = el('div', 'rv sum');
    if (!it) {
      box.appendChild(reviewHead('data-back', 'Review List'));
      box.appendChild(el('p', 'msg', 'Review #' + large.n + " isn't here any more."));
      return box;
    }
    var vi = verIdx(it), ver = vi.ver, latestV = vi.latestV;
    box.appendChild(reviewHead('data-back', 'Review List', it, ver));
    if (ver.v < latestV) {
      var go = el('button', 'vban-go', 'Go to v' + latestV);
      go.type = 'button';
      go.setAttribute('data-ver', latestV);
      box.appendChild(add(el('p', 'vban'), document.createTextNode('You\u2019re viewing v' + ver.v + ' \u2014 v' + latestV + ' is the latest \u00b7 '), go));
    }
    // what changed, then the request in one sentence (the package's own fields; older items have neither, and say "Feedback wanted")
    if (ver.summary) box.appendChild(add(el('section', 'sum-sec'), el('p', 'sum-lbl', 'What changed'), el('p', 'rnote', ver.summary)));
    var rq = el('div', 'ask');
    rq.setAttribute('data-ask', it.purpose || 'feedback');
    var asked = askOf(it.purpose, ver);
    if (asked) rq.appendChild(el('p', 'asks', asked));
    var pb = pickBlock(it, ver, latestV);
    if (pb) rq.appendChild(pb); // the answer to the request stays with the request
    if (ver.v === latestV) rq.appendChild(statusBar(it, ver)); // the request and its control are one block (Aurora ruling 5)
    if (rq.firstChild) box.appendChild(rq);
    // the review's note: two lines, then "… show"; expanded, "hide"
    var ns = el('section', 'sum-sec');
    ns.appendChild(el('p', 'sum-lbl', 'The review\u2019s note'));
    if (ver.note) {
      var open = !!noteOpen[it.n];
      var np = el('p', 'rnote' + (open ? '' : ' clamp2'), ver.note);
      ns.appendChild(np);
      var tg = el('button', 'more-link', open ? 'hide' : '\u2026 show');
      tg.type = 'button';
      tg.setAttribute('data-noteexp', String(it.n));
      ns.appendChild(tg);
    } else ns.appendChild(el('p', 'rnote none', 'No note.'));
    if (!ver.summary) box.appendChild(ns); // a package's own "What changed" leads; the agent's longer note sits below the views (an older review has only the note, and keeps it here)
    // one row per image: the thumbnail, #n, your mark or "not rated yet", the start of your comment, ›
    var rated = ver.images.filter(function (x, k) { var r = rating(it, ver, k); return !!(r.draft || r.sent); }).length;
    var rs = el('section', 'sum-sec');
    rs.appendChild(el('p', 'sum-lbl', 'Images \u00b7 ' + (rated ? rated + ' of ' + ver.images.length + ' rated' : ver.images.length)));
    var rows = el('div', 'irows');
    var canVote = port && ver.v === latestV;
    ver.images.forEach(function (x, k) {
      var r = rating(it, ver, k), f = r.draft || r.sent;
      var row = el('button', 'irow-open');
      row.type = 'button';
      row.setAttribute('data-frow', String(k));
      var th = add(el('span', 'ith'), it.meshes && it.meshes[x] ? meshThumb(x) : img(BASE + 'thumb/' + encodeURIComponent(x)));
      if (!(it.meshes && it.meshes[x])) numBadge(th, it, x); // a model is not "image #4"
      if (it.meshes && it.meshes[x]) th.appendChild(cubeBadge()); // the model: a tile among the views, opens in the 3D viewer
      var tx = el('span', 'itx');
      tx.appendChild(f ? add(el('span', 'imk'), thumbIcon(f.verdict), r.draft ? el('span', 'unsent', 'unsent') : null) : el('span', 'imk none', 'not rated yet'));
      if (f && f.comment) tx.appendChild(el('span', 'icm', f.comment.split('\n')[0]));
      add(row, th, tx, el('span', 'igo', '\u203a'));
      row.setAttribute('aria-label', 'Image ' + (k + 1) + (f ? ', ' + (f.verdict === 'up' ? 'thumbs up' : f.verdict === 'down' ? 'thumbs down' : 'comment') : ', not rated yet') + ' \u2014 open to review');
      var line = add(el('div', 'irow'), row);
      if (canVote) { // a quick thumbs up / down right here ("if it's simply an approval"); stepping through stays the main path
        var vote = el('div', 'ivote');
        ['up', 'down'].forEach(function (v) {
          var on = !!(f && f.verdict === v);
          var b = add(el('button', 'fbv sm' + (on ? ' on' : '')), thumbIcon(v));
          b.type = 'button';
          b.setAttribute('data-qv', v);
          b.setAttribute('data-qi', String(k));
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.setAttribute('aria-label', (v === 'up' ? 'Thumbs up' : 'Thumbs down') + ' for image ' + (k + 1));
          vote.appendChild(b);
        });
        line.appendChild(vote);
      }
      rows.appendChild(line);
    });
    rs.appendChild(rows);
    if (isPkg(ver)) { // a package: the views in one strip, then the whole-result acceptance; an older review keeps its rows
      box.appendChild(viewsSec(it, ver));
      var ss = scopesSec(it, ver, latestV);
      if (ss) box.appendChild(ss);
    } else box.appendChild(rs);
    if (ver.summary) box.appendChild(ns);
    // your overall note: in full, a box that grows to fit, edited in place (saved as you type: review_note)
    var os = el('section', 'sum-sec');
    os.appendChild(el('p', 'sum-lbl', it.purpose === 'status' ? 'A note back (optional)' : 'Your overall note'));
    var ta = el('textarea', 'onote');
    ta.setAttribute('data-onote', String(it.n));
    ta.maxLength = NOTE_MAX;
    ta.rows = 2;
    ta.placeholder = it.purpose === 'status' ? 'Add a note for the agent, if you like\u2026' : 'Add an overall note\u2026';
    ta.value = onote.n === it.n ? onote.text : (it.note_draft != null ? it.note_draft : it.note_sent || '');
    os.appendChild(ta);
    requestAnimationFrame(function () { grow(ta); });
    box.appendChild(os);
    // the folds sit below the response controls, both closed — except a status's Downloads, which are the point of it (Aurora)
    if (ver.files && ver.files.length) box.appendChild(fold('dl:' + it.n + ':' + ver.v, 'Downloads', ver.files.length, it.purpose === 'status', downloadsBody(ver)));
    if (ver.limits) box.appendChild(fold('lim:' + it.n + ':' + ver.v, 'Limitations', null, false, el('p', 'rnote', ver.limits)));
    return box;
  }
  var noteTimer = null;
  function saveNote() {
    if (onote.n === null) return;
    var job = { n: onote.n, text: onote.text };
    var sent = sendAction('review_note', { n: String(job.n) }, { note: job.text }, function (r) {
      if (r.ok === true) {
        var it = rawItem(job.n);
        if (it) it.note_draft = job.text.trim() && job.text.trim() !== (it.note_sent || '') ? job.text.trim() : null;
        if (onote.n === job.n && onote.text === job.text) onote = { n: null, text: '' };
        lastSig = '';
      } else if (!r.blocked) toast('Note not saved: ' + (r.error || 'try again'));
      if (!typing()) redraw();
    });
    if (!sent) noteTimer = setTimeout(saveNote, FB_GAP_MS); // an action in flight: try again in a moment
  }
  /* Submit, on the summary: this review only (review_send) — its unsent ratings and the overall note */
  function submitOne(n) {
    var it = rawItem(n);
    var who = it && (it.requester || it.agent);
    var input = onote.n === n ? { note: onote.text } : null;
    var sent = sendAction('review_send', { n: String(n) }, input, function (r) {
      sbar = { n: n, bad: r.ok !== true, msg: r.ok === true ? '\u2713 Sent to @' + (who || 'the agent') + (r.warning ? ' \u2014 ' + cap(String(r.warning), 160) : '') : r.blocked ? '' : 'Not sent: ' + (r.error || 'try again') };
      if (r.ok === true && onote.n === n) onote = { n: null, text: '' };
      refresh();
    });
    if (!sent) toast(blocked() ? 'Asset Studio needs approving first (Settings \u2192 Apps)' : 'One moment \u2014 a save is finishing, then Submit again');
  }
  /* an opened reference's own pager: through the references only */
  function refStep(di) {
    var it = data && itemOf(data);
    if (!it || !large.fimg) return;
    var vi = verIdx(it), id = vi.ver.images[vi.idx];
    var refs = focusRefs(it, (it.info || {})[id] || null);
    var k = refs.map(function (x) { return x.id; }).indexOf(large.fimg);
    if (refs.length < 2 || k < 0) return;
    large.fimg = refs[(k + di + refs.length) % refs.length].id;
    render();
  }
  /* a thumbs up / down on a summary row: that image's rating, saved at once (review_feedback); the same thumb again
     clears the verdict; its comment (draft or sent) is kept */
  function quickVote(k, v) {
    var it = data && itemOf(data);
    if (!it) return;
    var ver = verIdx(it).ver, f = baseline(it, ver, k);
    var verdict = f && f.verdict === v ? null : v, comment = (f && f.comment) || '';
    var input = { image: String(k + 1) };
    if (verdict) input.verdict = verdict;
    if (comment) input.comment = comment;
    var sent = sendAction('review_feedback', { n: String(it.n) }, input, function (r) {
      if (r.ok === true) patchDraft(it.n, ver.v, k, verdict || comment ? { verdict: verdict, comment: comment, at: new Date().toISOString() } : null);
      else if (!r.blocked) toast('Not saved: ' + (r.error || 'try again'));
      lastSig = '';
      redraw();
    });
    if (!sent) toast(blocked() ? 'Asset Studio needs approving first (Settings \u2192 Apps)' : 'One moment \u2014 then tap again');
  }
  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(44, ta.scrollHeight + 2) + 'px';
  }
  /* the summary's foot: not started → Begin review · saved → "N ratings not sent" + Edit review + Submit · sent → Edit review */
  function statusBar(it, ver) {
    var bar = el('div', 'sbar2');
    var raw = rawItem(it.n);
    var nr = raw ? draftCount(raw) : 0, nm = raw ? pendingMarks(raw) : 0;
    var nu = nr + nm; // everything not sent: ratings, picks, scopes and marks
    var noteNew = (onote.n === it.n ? onote.text.trim() : it.note_draft || '') && (onote.n === it.n ? onote.text.trim() : it.note_draft) !== (it.note_sent || '');
    var unrated = ver.images.map(function (x, k) { var r = rating(it, ver, k); return r.draft || r.sent ? 0 : k + 1; }).filter(Boolean);
    var started = nu || noteNew || it.sent || (ver.feedback || []).length;
    var msg = el('div', 'sb-msg');
    if (!port) msg.appendChild(el('b', '', 'Open in the room to review and submit'));
    else if (!started && it.purpose === 'status') add(msg, el('b', '', 'Nothing to submit'), el('span', 'sb-sub', 'look through it; a note back is optional'));
    else if (!started) add(msg, el('b', '', 'Waiting on you'), el('span', 'sb-sub', 'not started'));
    else if (nu || noteNew) {
      var parts = [nr ? nr + ' rating' + (nr > 1 ? 's' : '') : '', nm ? nm + ' ' + marksNoun(raw) + (nm > 1 ? 's' : '') : ''].filter(Boolean);
      add(msg, el('b', 'warn', parts.length ? parts.join(' \u00b7 ') + ' not sent' : 'Your note is not sent'),
        el('span', 'sb-sub', isPkg(ver) ? '' : unrated.length ? 'image' + (unrated.length > 1 ? 's ' : ' ') + unrated.join(', ') + ' not rated' : 'every image rated'));
    } else add(msg, el('b', '', 'Sent' + (it.sent ? ' to @' + it.sent.to + ' \u00b7 ' + clock(it.sent.at) : '')), el('span', 'sb-sub', 'a change makes it unsent again'));
    bar.appendChild(msg);
    if (sbar.msg && sbar.n === it.n) bar.appendChild(el('span', 'sbs' + (sbar.bad ? ' bad' : ''), sbar.msg));
    var acts = el('div', 'sb-acts');
    if (port) {
      var first = unrated.length ? unrated[0] - 1 : 0;
      var ed = el('button', 'btn' + (started || it.purpose === 'status' ? '' : ' pri'), started ? 'Edit review' : it.purpose === 'status' ? 'Look through' : 'Begin review');
      ed.type = 'button';
      ed.setAttribute('data-frow', String(started ? first : 0));
      acts.appendChild(ed);
      if (nu || noteNew) {
        var sb = el('button', 'btn pri', 'Submit');
        sb.type = 'button';
        sb.setAttribute('data-isend', String(it.n));
        sb.disabled = blocked();
        acts.appendChild(sb);
      }
    }
    bar.appendChild(acts);
    if (blocked()) bar.appendChild(approvalNote());
    return bar;
  }
  var FTABS = []; // (v3: no tab row on the focus page)
  function focusRefs(it, info) {
    var out = [];
    if (it.compare) out.push({ id: it.compare, label: 'Original' });
    if (info) {
      info.refs.forEach(function (x, k) { out.push({ id: x, label: k === 0 ? 'Ref \u00b7 main' : 'Ref ' + (k + 1) }); });
      info.siblings.forEach(function (x) { out.push({ id: x, label: 'Batch' }); });
    }
    (it.user_refs || []).forEach(function (x) { out.push({ id: x, label: 'Yours', mine: true }); });
    var seen = {};
    return out.filter(function (r) { if (seen[r.id]) return false; seen[r.id] = 1; return true; });
  }
  function pager(attr, pos, count, what) {
    var nav = el('div', 'fnav');
    [['-1', '\u2039', 'Previous ' + what], ['1', '\u203a', 'Next ' + what]].forEach(function (x, k) {
      var nb = el('button', 'pg', x[1]);
      nb.type = 'button';
      nb.setAttribute(attr, x[0]);
      nb.setAttribute('aria-label', x[2]);
      nb.disabled = count < 2;
      nav.appendChild(nb);
      if (!k) nav.appendChild(el('span', 'fpos', pos + ' / ' + count));
    });
    return nav;
  }
  /* the FOCUS page: one image at a time — the label line with its pager, the stage, the dashes, Mark, 👍/👎 and the
     comment, then the references (always shown: tap = compare, the open icon = mark it), Info folded */
  function focusSec(d) {
    var it = itemOf(d);
    var box = el('div', 'rv focus');
    if (!it) {
      box.appendChild(reviewHead('data-unfocus', 'Summary'));
      box.appendChild(el('p', 'msg', 'Review #' + large.n + " isn't here any more."));
      return box;
    }
    var vi = verIdx(it), ver = vi.ver, idx = vi.idx, latestV = vi.latestV;
    fbSync(it, ver, idx);
    var id = ver.images[idx];
    var info = (it.info || {})[id] || null;
    var refs = focusRefs(it, info);
    if (large.fimg && !(it.nums || {})[large.fimg]) large.fimg = null;
    if (large.fimg) return refFocus(it, refs, box);
    box.appendChild(reviewHead('data-unfocus', 'Summary', it, ver));
    if (large.fref === 'yours') { // just added: the newest of yours, to compare
      var mine = refs.filter(function (r) { return r.mine; });
      large.fref = mine.length ? mine[mine.length - 1].id : null;
    }
    if (large.fref && !refs.some(function (r) { return r.id === large.fref; })) large.fref = null;
    var cur = imageBox(it, ver, idx, id);
    var mesh = it.meshes && it.meshes[id];
    if (large.fref) compareLayer(cur, large.fref);
    var fcap = (ver.captions && ver.captions[id]) || '', falt = (ver.alternatives || []).filter(function (a) { return a.images.indexOf(id) >= 0; })[0];
    box.appendChild(add(el('div', 'flabel'), pager('data-fstep', idx + 1, ver.images.length, 'image'),
      fcap || falt ? el('p', 'fcap', (falt ? altWord(falt) + ' \u00b7 ' : '') + fcap) : null, // which engine / candidate this is (opened models carried no label)
      add(el('p', 'idrow'), el('span', '', idWord(it, id)), el('code', '', id), copyBtn(id, 'the image id'), popBtn(BASE + 'file/' + encodeURIComponent(id)))));
    box.appendChild(cur);
    if (ver.images.length > 1) { // the dashes: a cue only (grey = rated, teal = this one)
      var dash = el('div', 'dashes');
      ver.images.forEach(function (x, k) { var r = rating(it, ver, k); dash.appendChild(el('i', k === idx ? 'on' : r.draft || r.sent ? 'r' : '')); });
      box.appendChild(dash);
    }
    if (!mesh && !large.fref) { // marks are on pictures, and not while comparing
      markLayer(cur, it, id);
      box.appendChild(markBar(it, id));
    } else if (mesh === 'glb' && !large.fref) box.appendChild(pinBar(it, ver, id, latestV)); // a model in the 3D viewer: pins
    if (mesh === 'glb') requestAnimationFrame(syncPins);
    if (refAsk && refAsk.click) box.appendChild(addRefBanner());
    var pane = el('div', 'fpane');
    feedbackSec(pane, it, ver, latestV, idx, it.nums[id], !!mesh);
    box.appendChild(pane);
    if (!mesh) box.appendChild(focusRefsSec(it, refs)); // references are for comparing pictures
    box.appendChild(infoSec(it, id, info));
    return box;
  }
  function focusRefsSec(it, refs) {
    var sec = el('section', 'sum-sec frefsec');
    var mode = el('div', 'cmpmode');
    mode.setAttribute('role', 'group');
    mode.setAttribute('aria-label', 'How to compare');
    [['hold', 'Hold', 'Press and hold the image to see the reference'], ['slider', '\u27e8|\u27e9', 'Side by side: this image on the left, the reference on the right']].forEach(function (m) {
      var mb = el('button', 'cmb' + (cmpMode === m[0] ? ' on' : ''), m[1]);
      mb.type = 'button';
      mb.setAttribute('data-cmpmode', m[0]);
      mb.setAttribute('aria-pressed', cmpMode === m[0] ? 'true' : 'false');
      mb.title = m[2];
      mode.appendChild(mb);
    });
    sec.appendChild(add(el('div', 'frefhead'), el('span', 'sum-lbl', 'References \u00b7 compare with'), mode));
    if (refs.length) {
      var rs = el('div', 'strip frefs');
      refs.forEach(function (r) {
        var on = r.id === large.fref;
        var t = add(el('button', 'st cmp' + (on ? ' on' : '')), img(BASE + 'thumb/' + encodeURIComponent(r.id)), el('span', 'cmpl', '#' + ((it.nums || {})[r.id] || '?') + ' ' + r.label));
        t.type = 'button';
        t.setAttribute('data-fref', r.id);
        t.setAttribute('aria-pressed', on ? 'true' : 'false');
        t.setAttribute('aria-label', (on ? 'Stop comparing with ' : 'Compare with ') + r.label);
        var ob = popBtn(null);
        ob.setAttribute('data-fimg', r.id);
        ob.setAttribute('aria-label', 'Open #' + ((it.nums || {})[r.id] || '') + ' to mark it');
        ob.title = 'Open it to mark it';
        rs.appendChild(add(el('span', 'refcell'), t, ob));
        if (r.mine && on) {
          var rb = el('button', 'btn sm', 'Remove #' + it.nums[r.id]);
          rb.type = 'button';
          rb.setAttribute('data-refdel', r.id);
          rs.appendChild(rb);
        }
      });
      sec.appendChild(rs);
    } else sec.appendChild(el('p', 'fbh', 'No references yet: no Original, and this image wasn\u2019t made in this room.'));
    // the host's asset picker (briefing-table 741689f): Room, then Library; "＋ Newest" is the fast path
    var pk = el('button', 'btn', '\uff0b Pick from assets');
    pk.type = 'button';
    pk.setAttribute('data-pick', '1');
    pk.title = 'Choose an image from the room or the Library: it joins the references with the next number';
    var ad = el('button', 'btn', '\uff0b Newest');
    ad.type = 'button';
    ad.setAttribute('data-addref', '1');
    ad.title = 'The last image pasted or dropped into the room (in the last 10 minutes); paste (Ctrl+V) or drop works too';
    sec.appendChild(add(el('div', 'facts-acts'), pk, ad));
    return sec;
  }
  function infoSec(it, id, info) {
    var det = el('details', 'finfo');
    det.appendChild(el('summary', '', 'Info \u00b7 id ' + id.slice(0, 8) + '\u2026' + (info && info.width ? ' \u00b7 ' + info.width + '\u00d7' + info.height : '')));
    if (!info) {
      det.appendChild(el('p', 'fbh', 'This image wasn\u2019t made in this room, so there are no generation details here.'));
      return det;
    }
    var dl = el('dl', 'facts');
    var size = info.width && info.height ? info.width + '\u00d7' + info.height : '';
    [['Model', info.model_name], ['Size', size], ['Seed', info.seed != null ? String(info.seed) : ''], ['Steps', (info.steps != null ? info.steps : 'default') + ' \u00b7 ' + (info.draft ? 'draft' : 'full')],
      ['Refs', info.refs.length ? info.refs.length + ' (main subject first)' : 'none'], ['Batch', 'gen ' + info.gen + ', ' + (info.i + 1) + ' of ' + info.count], ['Folder', info.bin],
      ['Label', info.label], ['Not', info.negative_prompt]].forEach(function (f) {
      if (!f[1]) return;
      dl.appendChild(el('dt', '', f[0]));
      dl.appendChild(el('dd', '', cap(String(f[1]), 300)));
    });
    det.appendChild(dl);
    if (info.prompt) det.appendChild(el('p', 'fprompt', cap(info.prompt, 4000)));
    var acts = el('div', 'facts-acts');
    var cpb = el('button', 'btn', 'Copy prompt');
    cpb.type = 'button';
    cpb.setAttribute('data-copy', cap(info.prompt, 4096));
    acts.appendChild(cpb);
    if (data.library_web) {
      var lib = el('a', 'btn', 'Open in Library');
      lib.href = data.library_web + '/?assetid=' + encodeURIComponent(info.lib || id);
      lib.target = '_blank';
      lib.rel = 'noopener';
      acts.appendChild(lib);
    }
    var crb = el('button', 'btn', 'Copy reference');
    crb.type = 'button';
    crb.setAttribute('data-copy', id);
    acts.appendChild(crb);
    var dlb = el('a', 'btn', 'Download');
    dlb.href = BASE + 'file/' + encodeURIComponent(id);
    dlb.setAttribute('download', '');
    acts.appendChild(dlb);
    det.appendChild(acts);
    return det;
  }
  /* NUMBERS (task, "then 'make it like #6' is unambiguous"): every image an item
     shows has a number for good, given by the server (it.nums: id \u2192 number). */
  function numBadge(t, it, id) {
    var k = (it.nums || {})[id];
    if (k) t.appendChild(el('span', 'nb', '#' + k));
  }
  function idWord(it, id) {
    if (it.meshes && it.meshes[id]) return 'Model id';
    var k = (it.nums || {})[id];
    return k ? 'Image #' + k + ' \u00b7 id' : 'Image id';
  }
  /* A reference opened to mark it: the same page shape as an image — "‹ Focus", its OWN ‹ n / N › through the
     references only, the stage, Mark; no rating (references are for pointing at, not judging) */
  function refFocus(it, refs, box) {
    var id = large.fimg;
    var k = Math.max(0, refs.map(function (x) { return x.id; }).indexOf(id));
    var r = refs[k];
    var head = el('div', 'rv-h');
    var back = el('button', 'back', '\u2039 Focus');
    back.type = 'button';
    back.setAttribute('data-unfimg', '1');
    back.title = 'Back to the image you came from';
    add(head, back, add(el('h1'), document.createTextNode('Reference #' + it.nums[id] + (r ? ' \u00b7 ' + (r.label === 'Original' ? 'the Original' : r.label) : ''))));
    box.appendChild(head);
    var cur = imageBox(it, { images: [id] }, 0, id);
    box.appendChild(add(el('div', 'flabel'), pager('data-rfstep', k + 1, refs.length, 'reference'),
      add(el('p', 'idrow'), el('span', '', 'References \u00b7 #' + it.nums[id] + (r ? ' ' + r.label : '')), el('code', '', id), copyBtn(id, 'the image id'), popBtn(BASE + 'file/' + encodeURIComponent(id)))));
    box.appendChild(cur);
    markLayer(cur, it, id);
    box.appendChild(markBar(it, id));
    box.appendChild(el('p', 'fbh', 'Mark spots on it, then say what you want in an image\u2019s comment \u2014 e.g. \u201clike #' + it.nums[id] + ' A\u201d.'));
    return box;
  }
  /* MARKS : drag ＋ Mark onto the large image — a small dot while dragging, its label on
     release (A … Z, AA … across the item); drag a mark to move it; its chip's ✕ removes it. Only here, on
     the focus page. The layer covers the IMAGE (letterboxed in its box), so x, y are fractions of the image. */
  var fitMarks = null;
  function markLayer(cur, it, id) {
    var lay = el('div', 'mks v-' + markView);
    lay.setAttribute('data-mks', id);
    (it.marks || []).forEach(function (m) {
      if (m.image !== id) return;
      var s = add(el('span', 'mk' + (m.temp ? ' temp' : '')), el('i'), el('b', '', m.label));
      s.style.left = m.x * 100 + '%';
      s.style.top = m.y * 100 + '%';
      if (!m.temp) {
        s.setAttribute('data-mk', m.label);
        s.title = 'Mark ' + m.label + ' — drag to move it, tap for options';
      }
      lay.appendChild(s);
      if (markMenu === m.label && !m.temp) { // a sibling, not inside the mark: a tap on it is not a drag
        var mm = el('div', 'mkmenu');
        mm.style.left = m.x * 100 + '%';
        mm.style.top = m.y * 100 + '%';
        var rm = el('button', 'btn', 'Remove ' + m.label);
        rm.type = 'button';
        rm.setAttribute('data-mkdel', m.label);
        var no = el('button', 'btn', 'Cancel');
        no.type = 'button';
        no.setAttribute('data-mkclose', '1');
        lay.appendChild(add(mm, rm, no));
      }
    });
    var big = cur.querySelector('.big');
    zoomStage(cur, id, lay, big);
    fitMarks = function () {
      var r = cur.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var ar = big.naturalWidth && big.naturalHeight ? big.naturalWidth / big.naturalHeight : lastAr;
      var w = 100, h = 100;
      if (r.width / r.height > ar) w = (ar * r.height / r.width) * 100;
      else h = (r.width / ar / r.height) * 100;
      lay.style.left = (100 - w) / 2 + '%';
      lay.style.width = w + '%';
      lay.style.top = (100 - h) / 2 + '%';
      lay.style.height = h + '%';
      if (zoomApply) zoomApply();
    };
    big.addEventListener('load', fitMarks);
    requestAnimationFrame(fitMarks);
  }
  /* ZOOM : Ctrl + scroll (or a trackpad pinch) zooms the focus image about the pointer;
     scroll or drag pans while zoomed. Deepest: one image pixel = 32 screen pixels. From 2 px per pixel the
     image draws as hard pixels, from 8 a soft pixel grid shows the edges (as a paint program does). The
     readout is image pixels: 100% = one screen pixel each. Kept per image across re-renders. */
  var zoom = { id: null, z: 1, tx: 0, ty: 0 }, zoomApply = null;
  var ZOOM_PPX_MAX = 32, GRID_PPX = 8, PIXELATED_PPX = 2;
  function zoomStage(cur, id, lay, big) {
    var zw = el('div', 'zw');
    [].slice.call(cur.querySelectorAll('.ph, .big')).forEach(function (x) { zw.appendChild(x); });
    zw.appendChild(lay);
    cur.insertBefore(zw, cur.firstChild);
    var grid = el('div', 'pxgrid');
    grid.hidden = true;
    var rb = el('button', 'zmr', 'Fit');
    rb.type = 'button';
    rb.setAttribute('data-zreset', '1');
    rb.title = 'Back to the whole image';
    var zm = add(el('div', 'zm'), el('span', 'zmv'), rb);
    cur.appendChild(grid);
    cur.appendChild(zm);
    cur.classList.add('zoomable');
    if (zoom.id !== id) zoom = { id: id, z: 1, tx: 0, ty: 0 };
    var zMax = function () {
      var w = lay.getBoundingClientRect().width / zoom.z; // the image's width at fit
      return w && big.naturalWidth ? Math.max(1, ZOOM_PPX_MAX * big.naturalWidth / w) : 1;
    };
    var clampPan = function () {
      var r = cur.getBoundingClientRect();
      zoom.tx = Math.min(0, Math.max(r.width - r.width * zoom.z, zoom.tx));
      zoom.ty = Math.min(0, Math.max(r.height - r.height * zoom.z, zoom.ty));
    };
    zoomApply = function () {
      if (!cur.isConnected) return;
      clampPan();
      zw.style.transform = 'translate(' + zoom.tx + 'px,' + zoom.ty + 'px) scale(' + zoom.z + ')';
      zw.style.setProperty('--iz', String(1 / zoom.z));
      cur.classList.toggle('zoomed', zoom.z > 1.001);
      var lr = lay.getBoundingClientRect(), cr = cur.getBoundingClientRect();
      var ppx = big.naturalWidth ? lr.width / big.naturalWidth : 0;
      big.classList.toggle('pixels', ppx >= PIXELATED_PPX);
      zm.hidden = zoom.z <= 1.001;
      zm.firstChild.textContent = Math.round(ppx * 100) + '%';
      grid.hidden = ppx < GRID_PPX;
      if (grid.hidden) return;
      var gl = Math.max(0, lr.left - cr.left), gt = Math.max(0, lr.top - cr.top);
      var gr = Math.min(cr.width, lr.right - cr.left), gb = Math.min(cr.height, lr.bottom - cr.top);
      grid.style.left = gl + 'px';
      grid.style.top = gt + 'px';
      grid.style.width = Math.max(0, gr - gl) + 'px';
      grid.style.height = Math.max(0, gb - gt) + 'px';
      grid.style.backgroundSize = ppx + 'px ' + ppx + 'px';
      grid.style.backgroundPosition = (lr.left - cr.left - gl) + 'px ' + (lr.top - cr.top - gt) + 'px';
    };
    cur.addEventListener('wheel', function (e) {
      var k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (!e.ctrlKey && !e.metaKey) { // plain scroll pans a zoomed image; at fit the page scrolls
        if (zoom.z <= 1.001) return;
        e.preventDefault();
        zoom.tx -= (e.shiftKey ? e.deltaY : e.deltaX) * k;
        zoom.ty -= (e.shiftKey ? 0 : e.deltaY) * k;
        return zoomApply();
      }
      e.preventDefault(); // not the browser's page zoom
      var r = cur.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      var z2 = Math.min(zMax(), Math.max(1, zoom.z * Math.exp(-e.deltaY * k * 0.0025)));
      zoom.tx = px - (px - zoom.tx) * z2 / zoom.z;
      zoom.ty = py - (py - zoom.ty) * z2 / zoom.z;
      zoom.z = z2;
      zoomApply();
    }, { passive: false });
    var pan = null;
    cur.addEventListener('pointerdown', function (e) {
      if (zoom.z <= 1.001 || markDrag || (e.button && e.button !== 0) || e.target.closest('.mk, .mkmenu, .zm')) return;
      pan = { x: e.clientX - zoom.tx, y: e.clientY - zoom.ty };
      try { cur.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
      cur.classList.add('panning');
      e.preventDefault();
    });
    cur.addEventListener('pointermove', function (e) {
      if (!pan) return;
      zoom.tx = e.clientX - pan.x;
      zoom.ty = e.clientY - pan.y;
      zoomApply();
    });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      cur.addEventListener(t, function () { pan = null; cur.classList.remove('panning'); });
    });
    requestAnimationFrame(zoomApply);
  }
  /* ---- PINS on a model (unified review P3, ; Aurora rulings 8-15) ----
     Drag the next lettered pin from under the stage onto the model, or tap "Tap to place" and then the model (touch: the crosshair rides above the
     finger). Where the pointer is a ring lies on the SOLID surface; over nothing the ring goes and the crosshair says so, and letting go places
     nothing. A placed pin stays on its spot in the model's own space; selecting it opens its comment under the stage with Return to marked
     view (camera and hidden parts), Move and Remove. Hidden parts are not pickable; marking waits for a still pose (not while a clip plays). */
  var pinSel = null; // the selected pin's label
  var pinMenu = null; // {label, at, where: 'tag' | 'chip'}: the tapped pin's menu (a tap on the letter should open Move / Remove, as a picture mark does)
  var pinArm = null; // {move: label | null}: armed — the next press on the model places (or moves) a pin
  var pinCmt = { label: null, text: '' }; // the pin comment being typed
  var pinCmtTimer = null, pinSelNew = false;
  function viewerHandle() {
    return viewer && viewer.handle;
  }
  function pinsOf(it, id) {
    return (it.marks || []).filter(function (m) { return m.kind === '3d' && m.mesh === id; });
  }
  function nextPinLabel(it) {
    var all = (it.marks || []).map(function (m) { return m.label; });
    var idx = all.reduce(function (a, l) { return Math.max(a, [].reduce.call(l, function (n, c) { return n * 26 + c.charCodeAt(0) - 64; }, 0)); }, 0);
    var s = '';
    for (var k = idx + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
    return s;
  }
  /* the tapped pin's menu: Move, Return to marked view, and Remove with its letter — the picture marks' pattern: a tap on the letter never
     removes, the Remove button in the menu is the second, deliberate tap */
  function pinMenuItems(label, live) {
    return [{ k: 'move', label: 'Move', off: !live }, { k: 'view', label: 'Return to marked view' }, { k: 'rm', label: 'Remove ' + label, off: !live }];
  }
  function openPinMenu(label, where) {
    pinSel = label;
    pinArm = null;
    pinMenu = pinMenu && pinMenu.label === label && pinMenu.where === where ? null : { label: label, at: Date.now(), where: where, n: large ? large.n : 0, mesh: viewer ? viewer.key : '' }; // the same letter again closes it
  }
  /* what the viewer draws: this model's pins, the selected one marked, the unsent ones outlined */
  function syncPins() {
    var h = viewerHandle(), it = data && large && itemOf(data);
    if (!h || !it || !viewer) return;
    var pins = pinsOf(it, viewer.key), reselect = false;
    if (pinSelNew && pins.length) { // a pin just placed: select it (its comment opens under the stage)
      pinSel = pins.slice().sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at); })[0].label;
      pinSelNew = false;
      reselect = true;
    }
    var live = !!port && it.versions.length && verIdx(it).ver.v === it.versions[it.versions.length - 1].v;
    h.setPins(pins.map(function (m) { return { id: m.label, label: m.label, point: m.point, selected: m.label === pinSel, draft: !(it.sent && Date.parse(m.at) <= Date.parse(it.sent.at)), menu: pinMenu && pinMenu.where === 'tag' && pinMenu.n === it.n && pinMenu.mesh === viewer.key && pinMenu.label === m.label ? pinMenuItems(m.label, live) : null }; }));
    var box = viewer.box, arm = box.querySelector('.mv-arm');
    box.classList.toggle('arming', !!pinArm);
    if (pinArm && !arm) {
      arm = el('div', 'mv-arm');
      arm.setAttribute('data-pinarmzone', '1');
      box.appendChild(arm);
    } else if (!pinArm && arm) {
      box.removeChild(arm);
      h.setPreview(null);
    }
    if (reselect) {
      lastSig = '';
      render();
    }
  }
  function modelAim(e) { // the aimed point on the model (a finger aims with the crosshair above it)
    var h = viewerHandle();
    if (!h) return null;
    var a = aim(e), info = h.pick(a.x, a.y);
    h.setPreview(info && !info.error ? info : null);
    return info;
  }
  function pinInput(info, it, label) {
    var h = viewerHandle(), vs = h.viewState(), c = vs.cam;
    var input = { mesh: viewer.key, point: info.point.join(','), local: info.local.join(','), normal: info.normal.join(','), cam: c.position.concat(c.target, [c.fov]).join(',') };
    if (info.node) input.node = info.node;
    if (info.path && info.path.length) input.path = info.path.join('|');
    if (info.triangle !== null && info.triangle !== undefined) input.triangle = String(info.triangle);
    if (info.barycentric) input.bary = info.barycentric.join(',');
    if (vs.hidden.length) input.hidden = vs.hidden.join('|');
    if (label) input.label = label;
    return input;
  }
  function placePin(info, label) {
    var it = data && itemOf(data);
    if (!it || !viewerHandle()) return;
    if (!info) return toast('No surface here — nothing placed');
    if (info.error === 'animated') return toast('Stop the animation first — a pin needs a still pose');
    var sent = sendAction('review_mark', { n: String(it.n) }, pinInput(info, it, label), function (r) {
      if (r.ok !== true && !r.blocked) toast('Pin not saved: ' + (r.error || 'try again'));
      else if (!label) pinSelNew = true;
      refresh();
    });
    if (!sent) return toast(blocked() ? 'Asset Studio needs approving first (Settings → Apps)' : 'One moment — then place it again');
    pinArm = null;
    lastSig = '';
  }
  function dropPin(e) { // the end of a drag from the tray
    var d = markDrag, h = viewerHandle();
    var info = h ? (function () { var a = aim(e); return h.pick(a.x, a.y); })() : null;
    endDrag();
    if (!d.moved) return toast('Drag ＋ Pin onto the model, or tap Tap to place');
    placePin(info && !info.error ? info : info, null);
  }
  function pinBar(it, ver, id, latestV) {
    var bar = el('div', 'pinbar');
    var live = !!(port && ver.v === latestV);
    var pins = pinsOf(it, id);
    var tray = el('div', 'pintray');
    var add1 = el('button', 'mkadd', '＋ Pin ' + nextPinLabel(it));
    add1.type = 'button';
    add1.setAttribute('data-pinadd', '1');
    add1.title = 'Drag onto the model to mark a spot on its surface';
    add1.disabled = !live;
    var arm = el('button', 'pinarm' + (pinArm ? ' on' : ''), pinArm ? (pinArm.move ? 'Tap the new spot… (cancel)' : 'Tap the model… (cancel)') : 'Tap to place');
    arm.type = 'button';
    arm.setAttribute('data-pinarm', '1');
    arm.setAttribute('aria-pressed', pinArm ? 'true' : 'false');
    arm.disabled = !live;
    add(tray, add1, arm);
    bar.appendChild(tray);
    if (!pins.length) bar.appendChild(el('p', 'mkhint', 'Orbit and zoom to the spot, then drag ＋ Pin onto the model (or Tap to place). A pin goes on the solid surface you see; over nothing, nothing is placed.'));
    else {
      var chips = el('div', 'pinchips');
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', 'Pins');
      pins.forEach(function (m) {
        var c = el('button', 'pinchip' + (m.label === pinSel ? ' on' : ''), m.label);
        c.type = 'button';
        c.setAttribute('data-pinsel', m.label);
        c.setAttribute('aria-pressed', m.label === pinSel ? 'true' : 'false');
        c.setAttribute('aria-label', 'Pin ' + m.label + (m.node ? ', ' + m.node : ''));
        chips.appendChild(c);
      });
      bar.appendChild(chips);
      if (pinMenu && pinMenu.where === 'chip' && pinMenu.n === it.n && pinMenu.mesh === id && pins.some(function (m) { return m.label === pinMenu.label; })) {
        var cm = el('div', 'pinmenu');
        cm.setAttribute('role', 'menu');
        cm.setAttribute('data-pinmenu', pinMenu.label);
        pinMenuItems(pinMenu.label, live).forEach(function (b) {
          var x = el('button', 'btn', b.label);
          x.type = 'button';
          x.setAttribute('role', 'menuitem');
          x.setAttribute('data-pin' + (b.k === 'rm' ? 'rm' : b.k === 'move' ? 'move' : 'view'), pinMenu.label);
          x.disabled = !!b.off;
          cm.appendChild(x);
        });
        chips.appendChild(cm);
        var on = pinMenu.label;
        requestAnimationFrame(function () { // under its chip
          var c = chips.querySelector('[data-pinsel="' + on + '"]');
          if (c) cm.style.left = Math.min(c.offsetLeft, Math.max(0, chips.clientWidth - cm.offsetWidth)) + 'px';
        });
      }
      var sel = pins.filter(function (m) { return m.label === pinSel; })[0];
      if (sel) {
        var box = el('div', 'pinsel');
        box.appendChild(el('p', 'pinttl', 'Pin ' + sel.label + (sel.node ? ' · ' + sel.node : '') + (it.sent && Date.parse(sel.at) <= Date.parse(it.sent.at) ? ' · sent' : ' · not sent')));
        var ta = el('textarea', 'pkc');
        ta.setAttribute('data-pincmt', sel.label);
        ta.rows = 2;
        ta.maxLength = 500;
        ta.placeholder = 'What about this spot? (optional)';
        ta.disabled = !live;
        ta.value = pinCmt.label === sel.label ? pinCmt.text : sel.comment || '';
        box.appendChild(ta);
        var acts = el('div', 'pinacts');
        [['pinview', 'Return to marked view', true], ['pinmove', 'Move', live], ['pinrm', 'Remove', live]].forEach(function (b) {
          var x = el('button', 'btn', b[1]);
          x.type = 'button';
          x.setAttribute('data-' + b[0], sel.label);
          x.disabled = !b[2];
          acts.appendChild(x);
        });
        box.appendChild(acts);
        bar.appendChild(box);
      }
    }
    var h = viewerHandle();
    var parts = h ? h.parts() : [];
    if (parts.length > 1) {
      var hid = parts.filter(function (q) { return !q.visible; }).length;
      var rows = el('div', 'partrows');
      var all = el('button', 'btn', 'Restore all');
      all.type = 'button';
      all.setAttribute('data-showall', '1');
      all.disabled = !hid;
      rows.appendChild(all);
      parts.forEach(function (q) {
        var row = el('div', 'partrow' + (q.visible ? '' : ' off'));
        var eye = el('button', 'pteye', q.visible ? 'Hide' : 'Show');
        eye.type = 'button';
        eye.setAttribute('data-part', q.name);
        eye.setAttribute('aria-pressed', q.visible ? 'true' : 'false');
        eye.setAttribute('aria-label', (q.visible ? 'Hide ' : 'Show ') + q.name);
        var iso = el('button', 'ptiso', 'Isolate');
        iso.type = 'button';
        iso.setAttribute('data-isolate', q.name);
        add(row, eye, el('span', 'ptn', q.name), iso);
        rows.appendChild(row);
      });
      bar.appendChild(fold('parts:' + it.n + ':' + id, 'Parts', hid ? hid + ' hidden' : parts.length, false, rows));
    }
    return bar;
  }
  function saveCmt() {
    if (pinCmt.label === null) return;
    var job = { label: pinCmt.label, text: pinCmt.text }, it = data && itemOf(data);
    if (!it) return;
    var input = { label: job.label, comment: job.text.trim() };
    var sent = sendAction('review_mark', { n: String(it.n) }, input, function (r) {
      if (r.ok === true) {
        var m = (rawItem(it.n).marks || []).filter(function (x) { return x.label === job.label; })[0];
        if (m) { if (job.text.trim()) m.comment = job.text.trim(); else delete m.comment; }
        if (pinCmt.label === job.label && pinCmt.text === job.text) pinCmt = { label: null, text: '' };
        lastSig = '';
      } else if (!r.blocked) toast('Comment not saved: ' + (r.error || 'try again'));
      if (!typing()) redraw();
    });
    if (!sent) pinCmtTimer = setTimeout(saveCmt, FB_GAP_MS);
  }
  function pinAction(kind, label) {
    var it = data && itemOf(data), h = viewerHandle();
    if (!it) return;
    var m = (it.marks || []).filter(function (x) { return x.label === label; })[0];
    if (kind === 'view') {
      if (!h || !m) return;
      h.restoreView({ cam: m.cam, hidden: m.hidden || [] });
      toast((m.hidden && m.hidden.length) ? 'Showing the marked view: ' + m.hidden.length + ' part' + (m.hidden.length > 1 ? 's' : '') + ' hidden' : 'Showing the marked view');
      lastSig = '';
      return render();
    }
    if (kind === 'move') {
      pinArm = pinArm && pinArm.move === label ? null : { move: label };
      lastSig = '';
      return render();
    }
    if (kind === 'rm') {
      var sent = sendAction('review_mark', { n: String(it.n) }, { label: label, remove: true }, function (r) {
        if (r.ok === true && pinSel === label) pinSel = null;
        else if (r.ok !== true && !r.blocked) toast('Not removed: ' + (r.error || 'try again'));
        refresh();
      });
      if (!sent) toast(blocked() ? 'Asset Studio needs approving first (Settings → Apps)' : 'One moment — then tap again');
    }
  }
  function markBar(it, id) {
    var bar = el('div', 'mkbar');
    var h = el('button', 'mkadd', '＋ Mark');
    h.type = 'button';
    h.setAttribute('data-mkadd', '1');
    h.title = 'Drag onto the image to mark a spot';
    bar.appendChild(h);
    var here = (it.marks || []).filter(function (m) { return m.image === id; });
    var all = (it.marks || []).length - here.length;
    if (!here.length) bar.appendChild(el('span', 'mkhint', 'Drag onto the image to mark a spot (A, B, C …), then say what to do with it in your comment. Ctrl + scroll zooms.' + (all > 0 ? ' ' + all + ' on other images.' : '')));
    else {
      bar.appendChild(el('span', 'mkhint', here.map(function (m) { return m.label; }).join(' ') + (all > 0 ? ' · ' + all + ' on other images' : '')));
      bar.appendChild(markViewBtn());
    }
    return bar;
  }
  /* the marks' view button icons : generated in Asset Studio (Krea, gen 203), traced with
   image-ops to_svg mono (Library 539a7120 · c65ebb84 · 11247288), on one shared viewBox so the three keep one scale */
  var MARK_ICON_VIEWBOX = '91 53 388 388';
  var MARK_ICONS = {
    letters: 'M346.4 116.48c-9 2.87-19.63 12.35-23.58 21.02-2.22 4.87-2.3 6.1-2.93 47.5-.36 23.38-.28 44.83.17 47.68 1.9 12.13 9.55 21.78 21.94 27.71l6.5 3.11h98l7.32-3.43A39.2 39.2 0 0 0 472.9 241l2.6-5.5.29-44.37c.26-39.43.1-44.95-1.4-49.5A39.2 39.2 0 0 0 454 118.59l-6.5-3.09-48.5-.17c-37.57-.12-49.42.13-52.6 1.15m-94.9 16.58c-41.87 6.49-76.75 31.66-95.52 68.94-13.37 26.57-16.4 60.42-7.96 89.18 2.87 9.78 10.2 25.73 15.72 34.18 8.32 12.75 24.47 28.03 38.91 36.8 25.15 15.28 57.26 21.2 86.53 15.94 26.9-4.82 50.56-17.49 68.88-36.87 10.4-11 17.96-22 23.17-33.73 6.7-15.08 7.01-18.38 1.99-20.35-1.5-.58-11.05-1.23-21.22-1.44-21.31-.45-26.55-1.73-38.15-9.36-13.2-8.67-20.96-19.54-24.83-34.76-1.88-7.34-2.02-11.08-2.02-52.1V145.3l-2.94-4.06c-4.34-6-11.43-8.44-25.56-8.82-6.05-.16-13.7.13-17 .64m139.9 13.52c-3.26 1.6-3.83 2.64-11.25 20.42-10.84 25.97-20.15 50.66-20.15 53.44 0 6.4 5.92 10.08 12.1 7.52 3.14-1.3 6.84-6.82 8.87-13.21l1.18-3.75h15.3c11.05 0 15.58.35 16.3 1.25.54.69 1.75 3.6 2.69 6.47 2.63 8.07 8.8 12.04 15.01 9.66 1.97-.75 4.55-5.5 4.55-8.35 0-1.14-1.33-5.33-2.95-9.3s-5.4-13.53-8.38-21.23c-15.74-40.6-15.73-40.56-19.03-42.58-3.77-2.3-9.98-2.45-14.25-.34M396 171c-.6 2.2-2.66 8.1-4.6 13.13-2.39 6.17-3.2 9.47-2.52 10.15 1.36 1.36 15.25 2.07 17.02.87 1.12-.76 1.18-1.7.3-4.8-2.52-8.84-7.75-23.35-8.41-23.35-.4 0-1.2 1.8-1.79 4',
    dots: 'M247 132.94c-29.83 4.37-54.57 17.21-75.5 39.19-21.8 22.89-32.93 51.33-32.84 83.87.09 33.2 10.07 59.5 31.38 82.78 18.44 20.14 41.66 33.31 68.15 38.68 27.4 5.54 54.45 1.88 80.24-10.87 36.07-17.83 61.02-51.52 67.08-90.59 10.3-66.3-32.1-126.96-99.01-141.65-8.05-1.77-31.39-2.6-39.5-1.41',
    hidden: 'M202.84 133.03c-27.54 4.27-53.26 17.26-72.6 36.67C107.9 192.12 95 223.61 95 255.68c0 24.4 6.5 35.32 21.02 35.32 3.99 0 7.34-.65 9.8-1.9 2.05-1.06 11.6-10.02 21.2-19.93 9.62-9.92 36.38-37.23 59.48-60.7 23.1-23.46 42.88-44.3 43.95-46.32 1.3-2.45 1.94-5.55 1.9-9.44-.05-7.8-3.63-13.01-11.81-17.2-5.59-2.85-6.57-3.02-18.97-3.18-7.19-.1-15.62.22-18.73.7m108.66.92c-2.2 1.05-6.7 4.53-10 7.74-7.9 7.7-120.85 122.3-121.5 123.3-.28.41-17.79 18.36-38.92 39.87-21.14 21.52-39.23 40.35-40.22 41.85-.98 1.5-2.25 4.88-2.81 7.51-2.9 13.53 6.52 24.78 20.76 24.78 5.5 0 6.32-.32 12.3-4.85a88 88 0 0 0 10.3-9.25c3.66-4.1 59.8-61.83 76.64-78.8a30280 30280 0 0 0 109.09-111.6c9.79-10.22 11.81-13.59 12.54-20.86.43-4.33.05-6.01-2.38-10.64-5.09-9.7-16.23-13.6-25.8-9.05m3.5 86.3c-2.65.78-11.98 9.54-38.5 36.16-53.05 53.24-84.83 85.7-87.8 89.68-3.37 4.5-5.08 12.79-3.7 17.92 1.26 4.67 9.25 12.35 14.62 14.05 6.6 2.09 30.75 2.37 40.97.47 48.19-8.93 84.7-41.9 98.57-89.03 5.8-19.67 6.14-47.49.75-58.97-4.32-9.2-14.48-13.39-24.91-10.28'
  };
  var MARK_VIEWS = [['letters', 'Marks: letters'], ['dots', 'Marks: dots only'], ['hidden', 'Marks: hidden']];
  /* ONE button : its icon is the view now; a click moves to the next (letters → dots → hidden) */
  function markViewBtn() {
    var k = MARK_VIEWS.map(function (v) { return v[0]; }).indexOf(markView);
    var next = MARK_VIEWS[(k + 1) % MARK_VIEWS.length];
    var b = el('button', 'mkview');
    b.type = 'button';
    b.setAttribute('data-mkview', next[0]);
    b.title = MARK_VIEWS[k][1] + ' — click for ' + next[1].slice(7);
    b.setAttribute('aria-label', b.title);
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', MARK_ICON_VIEWBOX);
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', MARK_ICONS[markView]);
    svg.appendChild(path);
    b.appendChild(svg);
    return b;
  }
  var markDrag = null; // {label?, g: the dot that follows the pointer, x0, y0, moved}
  var markMenu = null, markMenuAt = 0; // the tapped mark whose menu is open (the user: a tap must not remove)
  var markView = 'letters'; // letters | dots | hidden (), remembered per viewer
  try { markView = ['letters', 'dots', 'hidden'].indexOf(localStorage.getItem('is-mark-view')) >= 0 ? localStorage.getItem('is-mark-view') : 'letters'; } catch (e) { /* no storage */ }
  /* the aimed point ("I can't see exactly where it is dropping"): a mouse or pen aims with
     the crosshair cursor's centre, nothing under it; a finger aims with a crosshair drawn above it */
  var TOUCH_LIFT = 56;
  function aim(e) {
    return { x: e.clientX, y: e.clientY - (e.pointerType === 'touch' ? TOUCH_LIFT : 0) };
  }
  function markAt(e) { // the aimed point as fractions of the marked image, or null off it
    var lay = root.querySelector('.mks');
    if (!lay) return null;
    var r = lay.getBoundingClientRect(), a = aim(e);
    var x = (a.x - r.left) / r.width, y = (a.y - r.top) / r.height;
    return r.width && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4 } : null;
  }
  function moveGhost(e) {
    if (Math.abs(e.clientX - markDrag.x0) + Math.abs(e.clientY - markDrag.y0) > 6) markDrag.moved = true;
    markDrag.g.classList.toggle('still', !markDrag.moved);
    var a = aim(e);
    markDrag.g.style.left = a.x + 'px';
    markDrag.g.style.top = a.y + 'px';
    if (markDrag.model) { // over the model: a ring on the surface; over nothing, the crosshair says so
      var info = modelAim(e);
      markDrag.g.classList.toggle('off', !info || !!info.error);
    } else markDrag.g.classList.toggle('off', !markAt(e));
  }
  function endDrag() {
    if (markDrag.model && viewerHandle()) viewerHandle().setPreview(null);
    if (markDrag.g.parentNode) markDrag.g.parentNode.removeChild(markDrag.g);
    if (markDrag.src) markDrag.src.classList.remove('moving');
    html.classList.remove('marking');
    markDrag = null;
  }
  function dropMark(e) {
    if (markDrag.model) return dropPin(e);
    var d = markDrag, p = markAt(e), it = data && itemOf(data), lay = root.querySelector('.mks');
    endDrag();
    if (!d.moved) { // a tap: a mark opens its menu; ＋ Mark says how
      if (!d.label) return toast('Drag ＋ Mark onto the image');
      markMenu = d.label;
      markMenuAt = Date.now();
      lastSig = '';
      return render();
    }
    if (!p || !it || !lay) return; // off the image: nothing changes (a moved mark stays put)
    if (!d.label && markView === 'hidden') setMarkView('letters'); // a new mark is seen
    var id = lay.getAttribute('data-mks');
    var input = d.label ? { label: d.label, x: p.x, y: p.y } : { image: id, x: p.x, y: p.y };
    var sent = sendAction('review_mark', { n: String(it.n) }, input, function (r) {
      if (r.ok !== true && !r.blocked) toast('Mark not saved: ' + (r.error || 'try again'));
      refresh();
    });
    if (!sent) return toast(blocked() ? 'Asset Studio needs approving first (Settings → Apps)' : 'One moment — then drop it again');
    it.marks = it.marks || [];
    var m = d.label && it.marks.filter(function (x) { return x.label === d.label; })[0];
    if (m) { m.x = p.x; m.y = p.y; }
    else it.marks.push({ label: '…', image: id, x: p.x, y: p.y, temp: true });
    lastSig = '';
    render();
  }
  function setMarkView(v) {
    markView = v;
    try { localStorage.setItem('is-mark-view', v); } catch (e) { /* no storage */ }
  }
  function delMark(label) {
    var it = data && itemOf(data);
    markMenu = null;
    if (!it) return;
    var sent = sendAction('review_mark', { n: String(it.n) }, { label: label, remove: true }, function (r) {
      if (r.ok !== true && !r.blocked) toast('Not removed: ' + (r.error || 'try again'));
      refresh();
    });
    if (!sent) return toast(blocked() ? 'Asset Studio needs approving first (Settings → Apps)' : 'One moment — then try again');
    it.marks = (it.marks || []).filter(function (x) { return x.label !== label; });
    lastSig = '';
    render();
  }
  /* YOUR REFERENCES (the user: "paste a reference that gets added to references with a number"): a paste or
     drop on the focus page goes to the room (the host uploads it), then review_ref adds the newest room
     image to the item. That needs a fresh click: if the upload outlived it, a button asks for one. */
  var refAsk = null; // {n, click?} — an image on its way in for item n
  function addRefBanner() {
    var b = el('button', 'btn', '＋ Add it as a reference');
    b.type = 'button';
    b.setAttribute('data-addref', '1');
    return add(el('p', 'vban'), document.createTextNode('Your image is in the room · '), b);
  }
  function addRef(input) {
    var n = refAsk ? refAsk.n : large && large.n;
    if (!n) return;
    input = input || (refAsk && refAsk.input) || {};
    var sent = sendAction('review_ref', { n: String(n) }, input, function (r) {
      if (r.ok === true) {
        refAsk = null;
        toast('Added to the references');
        if (large && large.n === n) {
          large.ftab = 'refs';
          large.fref = 'yours';
          large.fimg = null;
        }
      } else if (r.error === 'needs a click' || r.error === 'too fast') {
        refAsk = { n: n, click: true, input: input };
      } else {
        refAsk = null;
        if (!r.blocked) toast('Not added: ' + (r.error || 'try again'));
      }
      refresh();
    });
    if (!sent) {
      refAsk = { n: n, click: true, input: input };
      redraw();
    }
  }
  /* The host's asset picker, from the click: Room tab, then Library. The answer comes on the port; the host lets
     this panel's next ONE action within 10 s pass as clicked, so review_ref goes at once. */
  var pickN = null;
  function openPicker() {
    if (!port || !large) return;
    if (blocked()) return toast('Asset Studio needs approving first (Settings → Apps)');
    pickN = large.n;
    port.postMessage({ panel: 'pick', kind: 'image', sources: ['room', 'library'], title: 'A reference for #' + large.n });
  }
  function onPicked(d) {
    var n = pickN;
    pickN = null;
    if (d.cancelled || n === null) return;
    if (d.error) return toast(d.error === 'not declared' || d.error === 'needs-approval' ? 'The picker needs Asset Studio approved (Settings → Apps)' : 'Picker: ' + cap(String(d.error), 80));
    var it = (d.items || [])[0];
    if (!it) return;
    var input = it.source === 'library' && typeof it.library_id === 'string' ? { image: it.library_id }
      : it.source === 'room' && typeof it.name === 'string' ? { name: it.name } : null;
    if (!input) return;
    refAsk = { n: n };
    addRef(input);
  }
  function pasteFiles(files, how) {
    if (!large || !large.focus || !files) return false;
    var list = [].filter.call(files, function (f) { return /^image\/(png|jpeg|webp)$/.test(f.type); });
    if (!list.length) return false;
    refAsk = { n: large.n };
    post({ panel: how, files: list.slice(0, 1) });
    return true;
  }
  /* Transparent art (an SVG icon, a cut-out) sits on the dark stage: sample it and, if it is mostly
     transparent, back it with the light token when its ink is dark (the user: the black hand SVG was
     invisible). Opaque images keep the stage. */
  function backdrop(cur, im) {
    cur.classList.remove('light');
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 48;
      var g = c.getContext('2d');
      g.drawImage(im, 0, 0, 48, 48);
      var px = g.getImageData(0, 0, 48, 48).data;
      var clear = 0, lum = 0, ink = 0;
      for (var k = 0; k < px.length; k += 4) {
        if (px[k + 3] < 250) clear++;
        if (px[k + 3] > 128) { ink++; lum += 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]; }
      }
      if (clear > 0.02 * 48 * 48 && ink && lum / ink < 115) cur.classList.add('light');
    } catch (e) {
      /* tainted or not decodable: keep the stage */
    }
  }
  function step(di, dv) {
    var it = (data.review_items || []).filter(function (x) { return x.n === large.n; })[0];
    if (!it) return;
    large.fimg = null;
    var vi = it.versions.findIndex(function (x) { return x.v === large.v; });
    if (dv) {
      var nv = it.versions[vi + dv];
      if (!nv) return;
      large.v = nv.v;
      large.i = 0;
    } else {
      var n = it.versions[vi].images.length;
      if (n < 2) return;
      large.i = (large.i + di + n) % n;
    }
    render();
  }

  /* ---- ratings, PER IMAGE. 👍/👎 and/or a comment on the image in view, SAVED unsent
     (review_feedback over the host's port), then Submit on the review's summary (review_send). The form
     edits that image's current rating on the latest version: its unsent draft, else the last one
     you sent for it. Built from `fb` every render; fbPaint() updates it in place between renders.
     Read off the Review tab's raw items: it.unsent = {v, images: {"<0-based i>": {verdict, comment,
     at}}, item?} (item = a whole-item draft from before per-image ratings); feedback[] entries
     carry image (0-based), a whole-item one from before has none. */
  function mark(v) {
    return v === 'up' ? '👍' : v === 'down' ? '👎' : '💬';
  }
  /* 👍 / 👎 as an SVG (Aurora's pass: emoji draw as boxes without an emoji font and can't take the palette):
     the thumb of Material Symbols (Apache-2.0), tinted var(--lime) / var(--coral); a comment-only rating = 💬 text */
  var THUMB_D = 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z';
  function thumbIcon(v) {
    var sp = el('span', 'vk ' + (v === 'up' ? 'up' : v === 'down' ? 'down' : 'note'));
    if (v !== 'up' && v !== 'down') { sp.textContent = 'comment'; return sp; }
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', THUMB_D);
    if (v === 'down') path.setAttribute('transform', 'rotate(180 12 12)'); // on the path, about the centre: a transform on the outer <svg> is ignored by iOS Safari
    svg.appendChild(path);
    sp.appendChild(svg);
    sp.setAttribute('aria-label', v === 'up' ? 'thumbs up' : 'thumbs down');
    return sp;
  }
  function rawItem(n) {
    return data && (data.review_items || []).filter(function (x) { return x.n === n; })[0];
  }
  function verOf(it, v) {
    return it.versions.filter(function (x) { return x.v === v; })[0] || it.versions[it.versions.length - 1];
  }
  /* image i of version ver: {draft: its unsent rating, sent: the last one sent} */
  function rating(it, ver, i) {
    var u = it.unsent && it.unsent.v === ver.v && it.unsent.images ? it.unsent.images[i] : null;
    var sent = (ver.feedback || []).filter(function (f) { return f.image === i; }).slice(-1)[0];
    return { draft: u || null, sent: sent || null };
  }
  function baseline(it, ver, i) {
    var r = rating(it, ver, i);
    return r.draft || r.sent;
  }
  function draftCount(it) {
    return it.unsent ? Object.keys(it.unsent.images || {}).length + (it.unsent.item ? 1 : 0) + (it.unsent.pick ? 1 : 0) + Object.keys(it.unsent.scopes || {}).length : 0;
  }
  /* marks and pins placed, moved, commented or removed since the last Send are part of the answer : the server says which */
  function pendingMarks(it) {
    return ((it && it.marks_unsent) || []).length + ((it && it.marks_gone) || []).length;
  }
  function marksNoun(it) {
    var u = (it.marks_unsent || []);
    var pins = (it.marks || []).filter(function (m) { return u.indexOf(m.label) >= 0; });
    return pins.length && pins.every(function (m) { return m.kind === '3d'; }) ? 'pin' : 'mark';
  }
  function unsentCount() {
    return ((data && data.review_items) || []).reduce(function (s, it) { return s + draftCount(it) + pendingMarks(it); }, 0);
  }
  /* the card's per-image tally on the latest version ("👍2 👎1"); a whole-item rating from before shows as its mark */
  function tally(it) {
    var ver = it.versions[it.versions.length - 1];
    var c = { up: 0, down: 0, note: 0 };
    ver.images.forEach(function (x, k) {
      var f = baseline(it, ver, k);
      if (f) c[f.verdict || 'note']++;
    });
    var parts = [['up'], ['down'], ['note']].filter(function (x) { return c[x[0]]; });
    var old = (it.unsent && it.unsent.v === ver.v && it.unsent.item) || (ver.feedback || []).filter(function (f) { return f.image === undefined && f.pick === undefined && f.scope === undefined; }).slice(-1)[0];
    if (!parts.length && !old) return null;
    var box = el('span', 'tally');
    if (!parts.length) box.appendChild(thumbIcon(old.verdict));
    parts.forEach(function (x) { add(box, thumbIcon(x[0]), el('span', 'tn', String(c[x[0]]))); });
    box.setAttribute('aria-label', parts.map(function (x) { return c[x[0]] + ' ' + (x[0] === 'up' ? 'thumbs up' : x[0] === 'down' ? 'thumbs down' : 'comment-only'); }).join(', '));
    return box;
  }
  /* the form follows the image in view: flipping away keeps unsaved typing as THAT image's (edits),
     the next image shows its own draft / sent rating — a comment is never carried across */
  function fbSync(it, ver, i) {
    var key = it.n + ':' + ver.v + ':' + i;
    if (fb.key === key) return;
    if (fb.key !== null) {
      if (dirty()) edits[fb.key] = { verdict: fb.verdict, comment: fb.comment };
      else delete edits[fb.key];
    }
    var b = edits[key] || baseline(it, ver, i);
    fb = { key: key, n: it.n, v: ver.v, i: i, verdict: b ? b.verdict : null, comment: b ? b.comment : '', msg: '', bad: false };
  }
  function blocked() {
    return appStatus !== 'enabled';
  }
  /* held (tool.json changed, awaiting Approve) or unregistered: the one message, with the way to fix it */
  function approvalNote() {
    var btn = el('button', 'appr-go', 'Open Settings');
    btn.type = 'button';
    btn.setAttribute('data-settings', '1');
    return add(el('p', 'appr'), document.createTextNode('Approval needed to use this · '), btn);
  }
  function ratingLine(prefix, f, sent) {
    return add(el('p', 'fbl'), document.createTextNode(prefix + mark(f.verdict) + (f.comment ? ' “' + cap(f.comment, 300) + '”' : '') + (sent ? ' · sent ' + clock(f.sent_at || f.at) : ' ')), sent ? null : el('span', 'unsent', 'unsent'));
  }
  function feedbackSec(side, it, ver, latestV, idx, num, isMesh) {
    var nImg = ver.images.length, focus = num !== undefined, what = isMesh ? 'model' : 'image';
    var r = rating(it, ver, idx);
    if (focus && ver.v === latestV && port) r = {}; // the form below holds it: no repeated quote ()
    if (r.sent) side.appendChild(ratingLine('', r.sent, true)).title = 'Your rating on image ' + (idx + 1) + ' of v' + ver.v;
    if (r.draft) side.appendChild(ratingLine('', r.draft, false)).title = 'Saved here, not sent yet — Send review sends it';
    // a whole-item rating from before per-image ratings: history, read-only
    var old = (ver.feedback || []).filter(function (f) { return f.image === undefined && f.pick === undefined && f.scope === undefined; }).slice(-1)[0];
    if (old) side.appendChild(ratingLine('Whole item: ', old, true));
    // a package: where you stand on the whole thing, so the focus page does not hide it (answered on the summary)
    var pkw = isPkg(ver) ? pickOf(it, ver) : null;
    if (pkw) {
      var alt = (ver.alternatives || []).filter(function (a) { return a.id === pkw.alt; })[0];
      side.appendChild(add(el('p', 'fbl'), document.createTextNode('Your pick: ' + (pkw.alt === 'none' ? 'neither' : alt ? altWord(alt) : pkw.alt.toUpperCase()) + (pkw.sent ? ' \u00b7 sent' : ' ')), pkw.sent ? null : el('span', 'unsent', 'unsent')));
    }
    (isPkg(ver) ? ver.scopes || [] : []).forEach(function (sc) {
      var sd = scopeOf(it, ver, sc);
      if (sd) side.appendChild(add(el('p', 'fbl'), document.createTextNode(sc.charAt(0).toUpperCase() + sc.slice(1) + ': ' + (sd.decision === 'approve' ? 'approved' : 'changes wanted') + (sd.sent ? ' \u00b7 sent' : ' ')), sd.sent ? null : el('span', 'unsent', 'unsent')));
    });
    if (it.unsent && it.unsent.v === ver.v && it.unsent.item) side.appendChild(ratingLine('Whole item: ', it.unsent.item, false));
    if (ver.v !== latestV) return false;
    if (!port) {
      side.appendChild(el('p', 'fbh', 'Open in the room to send feedback.'));
      return false;
    }
    var box = el('div', 'fb');
    box.setAttribute('role', 'group');
    var scope = isMesh ? 'Rate this model' : focus ? 'Rate image #' + num : 'Rate this image' + (nImg > 1 ? ' (' + (idx + 1) + ' of ' + nImg + ')' : '');
    box.setAttribute('aria-label', scope);
    var row = el('div', 'fbr');
    if (focus) row.appendChild(el('p', 'fbt', scope));
    else box.appendChild(el('p', 'fbt', scope));
    [['up', '👍', 'Thumbs up'], ['down', '👎', 'Thumbs down']].forEach(function (x) {
      var b = add(el('button', 'fbv'), thumbIcon(x[0]));
      b.type = 'button';
      b.setAttribute('data-fb', x[0]);
      b.setAttribute('aria-label', x[2] + ' for ' + what + ' ' + (idx + 1));
      row.appendChild(b);
    });
    var ta = el('textarea', 'fbc');
    ta.setAttribute('data-fb', 'comment');
    ta.maxLength = 2000;
    ta.rows = focus ? 7 : 2;
    ta.placeholder = 'Comment on this ' + what + ' (optional) — saves as you type';
    ta.setAttribute('aria-label', 'Comment on ' + what + ' ' + (idx + 1));
    ta.value = fb.comment;
    var st = el('span', 'fbs');
    st.setAttribute('role', 'status');
    row.appendChild(st);
    if (focus) add(box, row, ta);
    else add(box, ta, row);
    if (blocked()) box.appendChild(approvalNote());
    side.appendChild(box); // render() paints it (fbPaint) once it is in the document
    return true;
  }
  /* the form's image: does what is typed differ from its draft / sent rating? */
  function dirty() {
    var it = fb.key !== null && rawItem(fb.n);
    var b = it ? baseline(it, verOf(it, fb.v), fb.i) : null;
    return fb.verdict !== (b ? b.verdict : null) || fb.comment.trim() !== (b ? b.comment : '');
  }
  function fbPaint() {
    var q = function (k) { return root.querySelector('[data-fb="' + k + '"]'); };
    var busy = !!act.busy;
    // the thumbs and the box stay live during a save: a tap is never dropped, and disabling the
    // focused box would drop the iOS keyboard
    ['up', 'down'].forEach(function (k) {
      var b = q(k);
      if (!b) return;
      b.setAttribute('aria-pressed', fb.verdict === k ? 'true' : 'false');
      b.classList.toggle('on', fb.verdict === k);
    });
    var st = root.querySelector('.fbs');
    if (st) {
      st.textContent = fb.msg || (fb.key !== null && !typing() && dirty() ? 'Not saved yet' : '');
      st.classList.toggle('bad', fb.bad);
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-isend]'), function (b) { b.disabled = blocked(); });
  }
  /* ONE panel action on the port, ONLY from a click (the host needs the user activation):
     one in flight, ≥ 500 ms apart. done(result) runs on its action-result (or the timeout). */
  function sendAction(name, params, input, done) {
    if (!port || act.busy || blocked() || Date.now() - act.last < FB_GAP_MS) return false;
    act.busy = name;
    act.last = Date.now();
    act.done = done;
    var msg = { panel: 'action', name: name, params: params };
    if (input) msg.input = input;
    port.postMessage(msg);
    act.timer = setTimeout(function () {
      actResult({ name: name, ok: false, error: 'No answer from the room — try again' });
    }, FB_WAIT_MS);
    fbPaint();
    return true;
  }
  function actResult(r) {
    if (!act.busy || r.name !== act.busy) return;
    clearTimeout(act.timer);
    var done = act.done;
    act.busy = act.done = null;
    if (r.error === 'needs-approval' || r.error === 'not-registered') {
      appStatus = r.error === 'needs-approval' ? 'held' : 'unregistered';
      r = { name: r.name, ok: false, error: '', blocked: true }; // the approval note says it (one message)
    }
    done(r);
    if (r.blocked) redraw();
  }
  function redraw() {
    lastSig = '';
    if (data && tab === 'review' && !typing()) render(); // never under the user's typing: the next poll will
  }
  function refresh() {
    lastSig = '';
    render();
    clearTimeout(pollTimer);
    poll(); // the server's view of it
  }
  /* local copy until the poll lands, so the counter / markers / Save state follow the click at once */
  function patchDraft(n, v, i, u) {
    var it = rawItem(n);
    if (!it) return;
    if (!it.unsent || it.unsent.v !== v) it.unsent = { v: v, images: {} }; // as the server: a newer version starts afresh
    if (u) it.unsent.images[i] = u;
    else delete it.unsent.images[i];
    if (!Object.keys(it.unsent.images).length && !it.unsent.item && !it.unsent.pick && !it.unsent.scopes) it.unsent = null;
  }
  /* AUTO-SAVE: the image's UNSENT draft, in the app only (review_feedback). A thumb saves at once,
     a comment FB_TYPE_MS after the last keystroke and on leaving the box, and anything still unsaved
     (this image, or one flipped away from: edits) goes with the next tap or key in the review.
     Neither a verdict nor a comment = that image's draft discarded. The host takes an action only
     inside a person's click or keystroke, one at a time: a save it turns away ('needs a click',
     'too fast', no answer) stays pending — "Not saved yet" — and goes with the next tap. */
  function unsaved() {
    if (fb.key !== null && dirty()) return { key: fb.key, n: fb.n, v: fb.v, i: fb.i, verdict: fb.verdict, comment: fb.comment };
    for (var k in edits) {
      var p = k.split(':').map(Number), it = rawItem(p[0]), e = edits[k];
      var b = it && verOf(it, p[1]).v === p[1] ? baseline(it, verOf(it, p[1]), p[2]) : undefined;
      if (b !== undefined && (e.verdict !== (b ? b.verdict : null) || e.comment.trim() !== (b ? b.comment : ''))) return { key: k, n: p[0], v: p[1], i: p[2], verdict: e.verdict, comment: e.comment };
      delete edits[k]; // saved, or its item / version is gone
    }
    return null;
  }
  function later(err) {
    return err === 'needs a click' || err === 'too fast' || /^No answer/.test(err || '');
  }
  /* save what is pending, one action at a time */
  function flush() {
    clearTimeout(typeTimer);
    if (pinCmt.label !== null) { // a pin's comment typed but not saved yet goes with it
      clearTimeout(pinCmtTimer);
      saveCmt();
    }
    if (act.busy) return; // the save in flight picks the rest up when it lands
    var job = unsaved();
    if (!job) return;
    var input = { image: String(job.i + 1) }; // 1-based, a scalar (panel input values are scalars)
    if (job.verdict) input.verdict = job.verdict;
    if (job.comment.trim()) input.comment = job.comment.trim();
    var sent = sendAction('review_feedback', { n: String(job.n) }, input, function (r) {
      var here = fb.key === job.key;
      if (r.ok === true) {
        patchDraft(job.n, job.v, job.i, input.verdict || input.comment ? { verdict: input.verdict || null, comment: input.comment || '', at: new Date().toISOString() } : null);
        var e = edits[job.key];
        if (e && e.verdict === job.verdict && e.comment === job.comment) delete edits[job.key];
        if (here) {
          fb.msg = dirty() ? '' : input.verdict || input.comment ? '✓ Saved — not sent yet' : 'Cleared';
          fb.bad = false;
        }
        sbar.msg = '';
        sbar.bad = false;
        lastSig = '';
        if (typing()) fbPaint(); // never re-render under the user's typing: the poll will
        else render();
        clearTimeout(pollTimer);
        poll();
        if (unsaved()) setTimeout(flush, FB_GAP_MS + 50); // typed on meanwhile
      } else {
        if (here) {
          fb.bad = !later(r.error) && !r.blocked;
          fb.msg = r.blocked ? '' : later(r.error) ? 'Not saved yet' : cap(r.error || 'Not saved', 200);
          fbPaint();
        }
      }
    });
    if (sent && fb.key === job.key) {
      fb.bad = false;
      fb.msg = 'Saving…';
      fbPaint();
    } else if (!sent && port && !blocked()) setTimeout(flush, FB_GAP_MS + 50); // two taps < 500 ms apart
  }
  function typing() {
    if (markDrag) return true; // a mark in the air: no re-render under it
    var a = document.activeElement;
    return !!(a && a.getAttribute && (a.getAttribute('data-fb') === 'comment' || a.getAttribute('data-onote') || a.getAttribute('data-pickcmt') || a.getAttribute('data-pincmt')));
  }
  /* "review/2", "review/2/v1" (a link ref or #fragment) → open it; "review/list/2" → the list, #2 flashed */
  function focusRef(ref) {
    var m = /^review(?:\/(list)\/(\d+)|\/(\d+)(?:\/v(\d+))?)?$/.exec(String(ref || ''));
    if (!m) return false;
    tab = 'review';
    if (!m[3]) large = null; // the list (a card flashed), not an item
    if (m[1]) {
      curN = flashN = Number(m[2]);
      if (m[2] && data && !(data.reviews || []).some(function (it) { return it.n === curN; })) curN = flashN = null;
    } else if (m[3]) openAsk = { n: Number(m[3]), v: m[4] ? Number(m[4]) : null };
    if (data) settle();
    return true;
  }
  /* once panel.json is in: open what was asked for, or say it's gone */
  function settle() {
    if (openAsk && !data.review_items) {
      // another tab's data has no review items: fetch the Review tab's first
      clearTimeout(pollTimer);
      poll();
      return;
    }
    if (openAsk) {
      var ask = openAsk;
      openAsk = null;
      if ((data.reviews || []).some(function (it) { return it.n === ask.n; })) return openReview(ask.n, ask.v);
      goneN = ask.n;
      setTimeout(function () {
        goneN = null;
        lastSig = '';
        if (data) render();
      }, 4000);
    }
    lastSig = '';
    render();
  }

  /* the small copy button that follows an image id (an id is quoted in chat all the time) */
  function copyBtn(text, what) {
    var b = el('button', 'cp');
    b.type = 'button';
    b.setAttribute('data-copy', text);
    b.setAttribute('aria-label', 'Copy ' + what);
    b.title = 'Copy ' + what;
    // drawn with DOM calls: this script sets text only, never markup
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    [['rect', { x: 5, y: 5, width: 9, height: 9, rx: 1.5 }], ['path', { d: 'M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11' }]].forEach(function (sh) {
      var n = document.createElementNS(NS, sh[0]);
      Object.keys(sh[1]).forEach(function (k) { n.setAttribute(k, sh[1][k]); });
      n.setAttribute('fill', 'none');
      n.setAttribute('stroke', 'currentColor');
      n.setAttribute('stroke-width', '1.5');
      svg.appendChild(n);
    });
    b.appendChild(svg);
    return b;
  }
  /* The full image in its own window (what tapping the image did before compare modes) */
  function popBtn(url) { // url null = a button (the reference strip's "open it to mark it"), same icon
    var a = el(url ? 'a' : 'button', 'cp pop');
    if (url) {
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
    } else a.type = 'button';
    a.setAttribute('aria-label', 'Open the full image in a new window');
    a.title = 'Open full size';
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    ['M9 2.5h4.5V7', 'M13.5 2.5 7.5 8.5', 'M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3'].forEach(function (d) {
      var n = document.createElementNS(NS, 'path');
      n.setAttribute('d', d);
      n.setAttribute('fill', 'none');
      n.setAttribute('stroke', 'currentColor');
      n.setAttribute('stroke-width', '1.5');
      n.setAttribute('stroke-linecap', 'round');
      svg.appendChild(n);
    });
    a.appendChild(svg);
    return a;
  }
  /* The review's Original over the image: in 'hold' mode it shows while the image is pressed (mouse or
     finger, after 120 ms so a quick swipe stays a swipe); in 'slider' mode the original shows right of a
     draggable divider, this image left of it (the strip's order: images, then the Original). */
  function compareLayer(cur, origId) {
    var o = el('img', 'orig');
    o.alt = 'The original';
    o.draggable = false;
    o.src = BASE + 'file/' + encodeURIComponent(origId);
    cur.appendChild(o);
    cur.classList.add('has-orig', 'mode-' + cmpMode);
    cur.addEventListener('contextmenu', function (e) { e.preventDefault(); }); // no long-press "save image" on a phone
    if (cmpMode === 'slider') {
      var line = el('span', 'split');
      add(line, el('span', 'knob', '\u27e8|\u27e9'));
      cur.appendChild(line);
      cur.appendChild(add(el('span', 'tag tl'), document.createTextNode('This image')));
      cur.appendChild(add(el('span', 'tag tr'), document.createTextNode('Original')));
      var setSplit = function (x) {
        var r = cur.getBoundingClientRect();
        split = Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100));
        cur.style.setProperty('--split', split + '%');
      };
      cur.style.setProperty('--split', split + '%');
      var down = false;
      cur.addEventListener('pointerdown', function (e) {
        down = true;
        try { cur.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
        setSplit(e.clientX);
        e.preventDefault();
      });
      cur.addEventListener('pointermove', function (e) { if (down) setSplit(e.clientX); });
      ['pointerup', 'pointercancel'].forEach(function (t) { cur.addEventListener(t, function () { down = false; }); });
    } else {
      cur.appendChild(add(el('span', 'tag hint'), document.createTextNode('Hold to see the original')));
      var timer = null;
      var show = function () { cur.classList.add('peek'); };
      var hide = function () { clearTimeout(timer); cur.classList.remove('peek'); };
      cur.addEventListener('pointerdown', function (e) {
        if (e.button && e.button !== 0) return;
        clearTimeout(timer);
        timer = setTimeout(show, 120);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { cur.addEventListener(t, hide); });
      cur.addEventListener('touchmove', function () { if (!cur.classList.contains('peek')) clearTimeout(timer); }, { passive: true });
    }
  }
  /* ---- XL: the picked image in an in-panel right column (the host preview item's content) */
  function detailSec(key) {
    var k = byKey[key];
    if (!k) return null;
    var it = previewItem(k);
    var sec = el('div', 'ap-sec det');
    var h = add(el('div', 'det-h'), el('b', '', it.title));
    var x = el('button', 'x', '×');
    x.type = 'button';
    x.setAttribute('data-close', '1');
    x.setAttribute('aria-label', 'Close');
    sec.appendChild(add(h, x));
    var a = add(el('a', 'det-img'), img(it.image));
    a.href = it.image;
    a.target = '_blank';
    a.rel = 'noopener';
    sec.appendChild(a);
    if (it.excerpt) sec.appendChild(el('p', 'det-ex', it.excerpt));
    var dl = el('dl', 'facts');
    it.meta.forEach(function (kv) {
      if (kv[0] === 'Image id') return add(dl, el('dt', '', kv[0]), add(el('dd', 'idd'), el('span', '', kv[1]), copyBtn(kv[1], 'the image id')));
      add(dl, el('dt', '', kv[0]), el('dd', '', kv[1]));
    });
    sec.appendChild(dl);
    var acts = el('div', 'acts');
    it.actions.forEach(function (ac) {
      var b;
      if (ac.copy !== undefined) {
        b = el('button', 'btn', ac.label);
        b.type = 'button';
        b.setAttribute('data-copy', ac.copy);
      } else {
        b = el('a', 'btn', ac.label);
        b.href = ac.open || ac.download;
        b.target = '_blank';
        b.rel = 'noopener';
      }
      acts.appendChild(b);
    });
    return add(sec, acts);
  }
  function toast(text) {
    var t = document.getElementById('toast');
    if (!t) {
      t = el('div', 'toast');
      t.id = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.hidden = true;
    }, 2400);
  }
  function copy(text) {
    // the frame's origin is opaque: the async clipboard is usually refused, execCommand often works
    function legacy() {
      var ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      toast(ok ? 'Copied' : 'Could not copy here');
    }
    try {
      navigator.clipboard.writeText(text).then(function () {
        toast('Copied');
      }, legacy);
    } catch (e) {
      legacy();
    }
  }

  /* Lay the sections out for the tier: stacked (S/M), or split into columns (L+; XL + detail). */
  function layout(left, right, fold) {
    var det = tier === 'xl' && detail && byKey[detail] ? detailSec(detail) : null;
    if (!ge('l')) {
      left.concat(right).forEach(function (s) {
        root.appendChild(s);
      });
      return;
    }
    var split = el('div', 'split' + (fold ? ' fold' : '') + (det ? ' det' : ''));
    if (!fold) {
      var l = el('div', 'col-l');
      left.forEach(function (s) {
        l.appendChild(s);
      });
      split.appendChild(l);
    }
    var r = el('div', 'col-r');
    (fold ? left.concat(right) : right).forEach(function (s) {
      r.appendChild(s);
    });
    split.appendChild(r);
    if (det) split.appendChild(add(el('div', 'col-d'), det));
    root.appendChild(split);
  }

  function render() {
    var fk = document.activeElement && root.contains(document.activeElement) && document.activeElement.getAttribute('data-fb');
    if (tab !== 'watch') {
      wt.ui = null;
      dropWatchViewer();
    }
    if (tab !== 'models' && !(tab === 'review' && large)) dropViewer(); // the viewer survives its own page's re-renders
    while (root.firstChild) root.removeChild(root.firstChild);
    root.classList.remove('low');
    byKey = {};
    var d = data;
    if (surface === 'rail') {
      // the rail is a click list : each row opens that tab in the preview column
      root.appendChild(railNav(d));
      post({ panel: 'count', n: d.budget.used });
      reportHeight();
      return;
    }
    if (GROUP[tab] === 'images' && genOpen && !genOf(d, genOpen)) genOpen = null;
    var onItem = (tab === 'review' && large && d.review_items) || (GROUP[tab] === 'images' && genOpen) || tab === 'watch'; // an item page: its own "‹ <list>" header (v3)
    if (!onItem) root.appendChild(tabsBar());
    if (GROUP[tab] === 'images' && genOpen) {
      root.appendChild(genPage(d));
      post({ panel: 'count', n: d.budget.used });
      reportHeight();
      return;
    }
    if (tab === 'review' && large && d.review_items) {
      root.appendChild(largeSec(d));
      fbPaint();
      post({ panel: 'count', n: d.budget.used });
      reportHeight();
      var back = fk && root.querySelector('[data-fb="' + fk + '"]');
      if (back && !back.disabled) back.focus({ preventScroll: true });
      return;
    }
    if (tab === 'review') {
      reviewSecs(d).forEach(function (s) {
        root.appendChild(s);
      });
      post({ panel: 'count', n: d.budget.used });
      reportHeight();
      if (flashN !== null) {
        var fc = root.querySelector('.card[data-n="' + flashN + '"]');
        flashN = null;
        if (fc) {
          fc.classList.add('flash');
          if (fc.scrollIntoView) fc.scrollIntoView({ block: 'nearest' });
          fc.focus({ preventScroll: true });
        }
      }
      return;
    }
    if (tab === 'models' || tab === 'watch') return modelsRender(d);
    if (tab !== 'studio') {
      // Favorites / Recycle: the grid only (+ budget); XL opens a pick in the right column
      layout(folderSecs(d).concat([budgetSec(d.budget)]), [], true);
      markPicked();
      post({ panel: 'count', n: d.budget.used });
      reportHeight();
      return;
    }
    var gens = d.generations.filter(function (g) {
      return g.state === 'running' || shown(g) || !g.assets.length;
    });
    var run = gens.filter(function (g) {
      return g.state === 'running';
    })[0];
    var wide = ge('l');
    var left = []; // S/M: in today's order; L+: the settings column (job + budget on top)
    var right = [];
    if (!d.engine.ok && !run) left.push(offSec());
    if (run) left.push(runningSec(run));
    if (wide) left.push(budgetSec(d.budget));
    if (!d.n_generations) {
      if (d.engine.ok) right.push(emptySec());
      if (d.settings.prompt) left.push(settingsSec(d));
    } else if (gens.length) {
      left.push(settingsSec(d)); // v3: one folded line above the latest batch
      (wide ? right : left).push(latestSec(gens[0]));
      // Studio shows the latest batches only; Favorites/Recycle show all of that folder.
      if (gens.length > 1) right.push(earlierSec(gens.slice(1, 1 + EARLIER_MAX)));
      var older = Math.max(0, gens.length - 1 - EARLIER_MAX) + (d.generations_more || 0);
      if (older) right.push(el('div', 'fail', older + ' older batches are in the Library and the room share.'));
    } else right.push(el('div', 'empty', 'Everything here is in Recycle.'));
    if (!wide) right.push(budgetSec(d.budget));
    layout(left, right, false);
    markPicked();
    post({ panel: 'count', n: d.budget.used });
    reportHeight();
  }
  /* The model domain's pages (Model Studio's Studio and Watch), in a .mdl box: its CSS is scoped there */
  /* Models (v3 nav, Aurora 13f29fb): the LIST is the jobs — the operators' Blender runs from the share (Watch ›) and
     the 3D core's jobs —, narrowed by chips All · Running · Done; Watch is OPENING a job (an item page: "‹ Models",
     the job, Frames | Model), so its job dropdown goes. The latest output and the room's models follow; the budget
     sits at the foot. */
  var mChip = 'all';
  var WATCH_LIVE_MS = 10 * 60000; // a share job touched in the last 10 minutes reads "running"
  var JOB_ENDED = ['done', 'error', 'cancelled', 'lost'];
  function watchJobsLoad() {
    if (wt.jobs !== null || wt.loading) return;
    wt.loading = true;
    fetch(BASE + 'watch.json', { cache: 'no-cache', credentials: 'omit' }).then(function (r) { return r.json(); }).then(function (j) {
      wt.loading = false;
      wt.jobs = (j && j.jobs) || [];
      if (tab === 'models' && !typing()) { lastSig = ''; render(); }
    }, function () { wt.loading = false; wt.jobs = []; });
  }
  function jobRows(m) {
    var rows = [];
    (wt.jobs || []).forEach(function (j) {
      var live = Date.now() - Date.parse(j.updated) < WATCH_LIVE_MS;
      rows.push({ name: j.job, sub: j.steps + ' steps \u00b7 ' + (live ? 'running' : 'done') + ' \u00b7 ' + ago(j.updated), running: live, watch: j.job, at: j.updated });
    });
    (m.jobs || []).forEach(function (j) {
      var running = JOB_ENDED.indexOf(j.state) < 0;
      rows.push({ name: j.label || j.id, sub: (j.provider ? j.provider + ' \u00b7 ' : '') + (WORD[j.state] || j.state) + (j.state === 'done' ? ' \u00b7 ' + j.outputs + ' out' : '') + ' \u00b7 ' + ago(j.at), running: running, at: j.at, err: j.error });
    });
    return rows.sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at); });
  }
  function modelsList(m) {
    watchJobsLoad();
    var rows = jobRows(m);
    var sec = section();
    var chips = el('div', 'chips');
    var nRun = rows.filter(function (r) { return r.running; }).length;
    [['all', 'All', rows.length], ['running', 'Running', nRun], ['done', 'Done', rows.length - nRun]].forEach(function (c) {
      var b = add(el('button', 'chipf' + (mChip === c[0] ? ' on' : '')), document.createTextNode(c[1] + ' '), el('span', 'n', String(c[2])));
      b.type = 'button';
      b.setAttribute('data-mchip', c[0]);
      chips.appendChild(b);
    });
    sec.appendChild(chips);
    var shown = rows.filter(function (r) { return mChip === 'all' || (mChip === 'running') === r.running; });
    if (wt.jobs === null) sec.appendChild(el('div', 'empty', 'Loading the jobs\u2026'));
    else if (!shown.length) sec.appendChild(el('div', 'empty', mChip === 'running' ? 'Nothing running.' : 'No jobs yet.'));
    var list = el('div', 'irows');
    shown.forEach(function (r) {
      var row = el(r.watch ? 'button' : 'div', 'irow job');
      if (r.watch) { row.type = 'button'; row.setAttribute('data-wjob', r.watch); }
      var tx = add(el('span', 'itx'), el('span', 'imk', r.name), el('span', 'icm', r.sub));
      if (r.err) tx.appendChild(el('span', 'icm bad', cap(r.err, 120)));
      add(row, el('span', 'jdot' + (r.running ? ' on' : '')), tx);
      if (r.watch) row.appendChild(el('span', 'igo', 'Watch \u203a'));
      list.appendChild(row);
    });
    if (shown.length) sec.appendChild(list);
    return sec;
  }
  function modelsRender(d) {
    var m = d.model;
    var box = el('div', 'mdl');
    if (tab === 'watch') { // the item: one job, opened from the list
      var head = el('div', 'rv-h witem');
      var back = el('button', 'back tab', '\u2039 Models');
      back.type = 'button';
      back.setAttribute('data-tab', 'models');
      var j = (wt.jobs || []).filter(function (x) { return x.job === wt.job; })[0];
      add(head, back, add(el('h1'), document.createTextNode((wt.job || 'Watch') + (j ? ' \u00b7 ' + j.steps + ' steps' : ''))));
      root.appendChild(add(el('div', 'rv'), head));
    }
    root.appendChild(box);
    if (tab === 'watch') {
      box.appendChild(watchSec());
      wt.sig = wtSig();
      watchPaint();
    } else {
      var left = [], right = [];
      if (!m.core.ok && !m.running) left.push(mOffSec(m.core));
      if (m.running) right.push(mRunningSec(m.running));
      left.push(modelsList(m));
      if (m.latest) right.push(stageSec(m));
      if (m.assets && m.assets.length) right.push(assetsSec(m));
      right.push(mBudgetSec(m.budget));
      if (ge('xl')) { // v3: one column (the list, then the latest model and the room's models, the budget at the foot); two only when very wide
        var l = el('div', 'col-l'), r = el('div', 'col-r');
        left.forEach(function (x) { l.appendChild(x); });
        right.forEach(function (x) { r.appendChild(x); });
        box.appendChild(add(el('div', 'split'), l, r));
      } else {
        var run = m.running ? right.shift() : null; // stacked: what's happening first, then the model, then the lists
        [run].concat(left, right).forEach(function (x) { if (x) box.appendChild(x); });
      }
    }
    post({ panel: 'count', n: d.budget.used });
    reportHeight();
  }
  /* A generation opens as an ITEM (v3 nav, Aurora 13f29fb): the same shape as a review item — "‹ Images", the
     batch's strip, the stage with ‹ i / N ›, its tools (copy id, Library, open), then "Settings for this gen" folded */
  var genOpen = null; // the image (asset id) whose generation is open
  function genOf(d, key) {
    for (var k = 0; k < (d.generations || []).length; k++) {
      var g = d.generations[k];
      for (var j = 0; j < g.assets.length; j++) if (g.assets[j].id === key) return { g: g, i: j };
    }
    return null;
  }
  function genPage(d) {
    var hit = genOf(d, genOpen);
    var box = el('div', 'rv focus gen-item');
    var head = el('div', 'rv-h');
    var back = el('button', 'back', '\u2039 Images');
    back.type = 'button';
    back.setAttribute('data-genback', '1');
    head.appendChild(back);
    if (!hit) {
      box.appendChild(head);
      box.appendChild(el('p', 'msg', 'That image isn\u2019t in this list any more.'));
      return box;
    }
    var g = hit.g, i = hit.i, a = g.assets[i];
    add(head, add(el('h1'), el('span', 'num', 'gen ' + g.gen), document.createTextNode(g.label ? ' \u00b7 ' + g.label : '')));
    if (g.draft) head.appendChild(el('span', 'chip', 'draft'));
    box.appendChild(head);
    if (g.assets.length > 1) {
      var strip = el('div', 'strip');
      g.assets.forEach(function (x, k) {
        var t = add(el('button', 'st' + (k === i ? ' on' : '')), img(BASE + 'thumb/' + encodeURIComponent(x.id)));
        t.type = 'button';
        t.setAttribute('data-genkey', x.id);
        t.setAttribute('aria-label', 'image ' + (k + 1) + ' of ' + g.assets.length);
        strip.appendChild(t);
      });
      box.appendChild(strip);
    }
    var ids = g.assets.map(function (x) { return x.id; });
    box.appendChild(add(el('div', 'flabel'), pager('data-gstep', i + 1, g.assets.length, 'image'),
      add(el('p', 'idrow'), el('span', '', 'Image ' + (i + 1) + ' \u00b7 id'), el('code', '', a.id), copyBtn(a.id, 'the image id'), popBtn(BASE + 'file/' + encodeURIComponent(a.id)))));
    box.appendChild(imageBox({ n: 'gen ' + g.gen }, { images: ids }, i, a.id));
    var tools = el('div', 'facts-acts');
    if (a.bin === 'favorites') tools.appendChild(el('span', 'chip', '\u2605 Favorite'));
    if (a.bin === 'recycle') tools.appendChild(el('span', 'chip', 'in Recycle'));
    if (data.library_web) {
      var lib = el('a', 'btn', 'Library \u2197');
      lib.href = data.library_web + '/?assetid=' + encodeURIComponent(a.lib || a.id);
      lib.target = '_blank';
      lib.rel = 'noopener';
      tools.appendChild(lib);
    }
    var cr = el('button', 'btn', 'Copy reference');
    cr.type = 'button';
    cr.setAttribute('data-copy', a.id);
    tools.appendChild(cr);
    box.appendChild(tools);
    var det = el('details', 'finfo');
    det.appendChild(el('summary', '', 'Settings for this gen'));
    var dl = el('dl', 'facts');
    [['model', g.model_name], ['aspect', aspectOf(g.settings)], ['size', a.width && a.height ? a.width + '\u00d7' + a.height : ''], ['seed', a.seed != null ? String(a.seed) : ''],
      ['mode', modeOf(g.draft)], ['count', g.count], ['refs', g.refs && g.refs.length ? String(g.refs.length) : 'none'], ['made', ago(g.at)]].forEach(function (f) {
      if (f[1] === '' || f[1] == null) return;
      add(dl, el('dt', '', f[0]), el('dd', '', String(f[1])));
    });
    det.appendChild(dl);
    if (g.settings && g.settings.prompt) det.appendChild(el('p', 'fprompt', cap(g.settings.prompt, 4000)));
    if (g.settings && g.settings.prompt) {
      var cp = el('button', 'btn', 'Copy prompt');
      cp.type = 'button';
      cp.setAttribute('data-copy', cap(g.settings.prompt, 4096));
      det.appendChild(add(el('div', 'facts-acts'), cp));
    }
    box.appendChild(det);
    return box;
  }
  function genStep(di) {
    var hit = data && genOf(data, genOpen);
    if (!hit || hit.g.assets.length < 2) return;
    genOpen = hit.g.assets[(hit.i + di + hit.g.assets.length) % hit.g.assets.length].id;
    render();
  }
  function markPicked() {
    var tiles = root.querySelectorAll('.th[data-key]');
    for (var i = 0; i < tiles.length; i++) tiles[i].classList.toggle('sel', picked !== null && tiles[i].getAttribute('data-key') === picked);
  }
  function message(text) {
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(el('p', 'msg', text));
    reportHeight();
  }
  var misses = 0; // polls in a row that got no answer
  var POLL_MISSES = 3; // …before the panel says Asset Studio is not answering
  function schedule() {
    clearTimeout(pollTimer);
    if (misses && misses < POLL_MISSES) {
      pollTimer = setTimeout(poll, FAST_MS);
      return;
    }
    var running = data && (data.generations.some(function (g) {
      return g.state === 'running';
    }) || (data.model && data.model.running));
    pollTimer = setTimeout(poll, tab === 'watch' ? WATCH_MS : running ? FAST_MS : SLOW_MS);
  }
  function poll() {
    if (tab === 'watch' && data) return watchPoll(); // Watch reads watch.json (the panel's own data came first, once)
    var asked = tab;
    // no-cache = revalidate: the browser sends If-None-Match and an unchanged poll is a 304 (headers only)
    fetch(BASE + 'panel.json?tab=' + encodeURIComponent(tab), { cache: 'no-cache', credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function () { throw new Error('not JSON, HTTP ' + r.status); });
      }, function () {
        throw new Error('network error');
      })
      .then(function (j) {
        if (!j || j.ok !== true) {
          data = null;
          lastSig = ''; // the next good poll redraws (briefing-table: the message stuck until the data changed)
          message((j && j.error) || 'Asset Studio is not answering.');
          return;
        }
        if (asked !== tab) return; // the user switched tabs mid-flight: that tab's own fetch is coming
        var sig = JSON.stringify(j) + '|' + Math.floor(Date.now() / 60000); // re-render when data or the minute changes
        var first = !data;
        data = j;
        if (openAsk || (first && flashN !== null)) {
          // a #review/... fragment asked before the data was in
          if (flashN !== null && !(j.reviews || []).some(function (it) { return it.n === flashN; })) curN = flashN = null;
          lastSig = sig;
          return settle();
        }
        if (sig !== lastSig && !typing()) { // never re-render under the user's typing: the next poll will
          lastSig = sig;
          render();
        }
        if (tab === 'watch') watchPoll();
      })
      .then(function () {
        misses = 0;
      }, function (e) {
        if (window.console) console.error('panel poll', e); // a draw error lands here too: the console has its stack
        // one slow or failed answer through the room's proxy (a busy moment mid-run) must not blank the
        // panel ("not answering" flashed during every run): keep what is shown and try
        // again sooner; only a run of misses is "not answering"
        misses++;
        if (!data || misses >= POLL_MISSES) {
          data = null;
          lastSig = ''; // the next good poll redraws
          message('Asset Studio is not answering (' + ((e && e.message) || 'no answer') + '). Trying again…');
        }
      })
      .then(schedule);
  }

  /* The preview item for one image: THAT image's settings, not the current ones. */
  function previewItem(k) {
    var g = k.g, a = k.a, s = g.settings;
    var url = abs(BASE + 'file/' + encodeURIComponent(a.id));
    var size = a.width && a.height ? a.width + '×' + a.height + ' (' + ratioName(a.width / a.height) + ')' : aspectOf(s);
    var meta = [['Model', cap(g.model_name || s.model_type || 'default', 200)], ['Size', size], ['Seed', String(a.seed != null ? a.seed : s.seed)],
      ['Steps', (s.num_inference_steps != null ? s.num_inference_steps : 'default') + ' · ' + modeOf(g.draft)]];
    if (s.negative_prompt) meta.splice(0, 0, ['Not', cap(s.negative_prompt, 200)]);
    meta.push(['Refs', g.refs && g.refs.length ? g.refs.length + ' (main subject first)' : 'none']);
    meta.push(['Folder', a.bin === 'favorites' ? 'favorites ★' : a.bin || 'renders']);
    if (g.label) meta.push(['Label', cap(g.label, 200)]);
    meta.push(['Image id', a.id]);
    var actions = [{ label: 'Copy prompt', copy: cap(s.prompt, 4096) }];
    if (data.library_web) actions.push({ label: 'Open in Library', open: data.library_web + '/?assetid=' + encodeURIComponent(a.lib || a.id) });
    actions.push({ label: 'Copy reference', copy: a.id });
    actions.push({ label: 'Download', download: url });
    return {
      key: a.id, type: 'IMAGE', title: cap('gen ' + g.gen + ', ' + (k.i + 1) + ' of ' + g.count + (g.label ? ' · ' + g.label : ''), 200),
      image: url, status: modeOf(g.draft), excerpt: cap(s.prompt, 2000), meta: meta, actions: actions.slice(0, 4),
    };
  }
  function pick(key) {
    var k = byKey[key];
    if (!k) return;
    if (tier === 'xl') {
      // XL: the in-panel right column, not the host's preview column
      detail = picked = key;
      render();
      return;
    }
    post({ panel: 'preview', item: previewItem(k) });
    if (!hostPreviews) {
      clearTimeout(ackTimer);
      ackTimer = setTimeout(function () {
        if (!hostPreviews) post({ panel: 'open', url: abs(BASE + 'file/' + encodeURIComponent(key)), title: 'gen ' + k.g.gen });
      }, PREVIEW_ACK_MS);
    }
  }
  function openGen(key) {
    if (!byKey[key]) return;
    genOpen = key;
    render();
    window.scrollTo(0, 0);
  }
  function tileOf(t) {
    while (t && t !== root && !(t.classList && t.classList.contains('th') && t.getAttribute('data-key'))) t = t.parentNode;
    return t && t !== root ? t : null;
  }
  root.addEventListener('click', function (e) {
    if (unsaved()) setTimeout(function () { flush(); }, 0); // after this tap is handled, inside its activation
    var near = function (sel) {
      return e.target && e.target.closest ? e.target.closest(sel) : null;
    };
    var ot = near('[data-open-tab]');
    if (ot) return openTabInPreview(ot.getAttribute('data-open-tab'));
    var tb = near('.tab');
    if (tb) {
      tab = tb.getAttribute('data-tab');
      genOpen = null;
      large = null;
      lastSig = '';
      render(); // tab bar + whatever this tab's data already covers; the fetch below fills the rest
      clearTimeout(pollTimer);
      poll();
      return;
    }
    if (GROUP[tab] === 'models') { // the model domain: Model Studio's Studio + Watch controls
      var wv = near('[data-wview]');
      if (wv) {
        wt.view = wv.getAttribute('data-wview');
        return watchRefresh();
      }
      var ws = near('[data-wcamstep]');
      if (ws) { // ‹ | ›: the next camera to the left or right (wrapping); in the 3D view only the ones with a saved view
        var cl = wtCams(), cur = wtCam(), dir = Number(ws.getAttribute('data-wcamstep')) || 1;
        var at = Math.max(0, cl.indexOf(cur)), mv = wtModelView(), pick = null;
        for (var q = 1; q <= cl.length && !pick; q++) {
          var cand = cl[(at + dir * q % cl.length + cl.length) % cl.length];
          if (!(mv && !poseOf(cand))) pick = cand;
        }
        if (!pick) return;
        wt.cam = pick.id;
        wt.look = null;
        wt.wide = false;
        if (mv || pagey()) snap();
        return watchPaint();
      }
      var wc = near('[data-wcam]');
      if (wc) {
        wt.cam = wc.getAttribute('data-wcam');
        wt.look = null;
        wt.wide = false;
        if (wtModelView() || pagey()) snap(); // on a page one camera picks the frame AND the 3D view
        return watchPaint();
      }
      var wl = near('[data-wlook]');
      if (wl) {
        wt.look = wl.getAttribute('data-wlook');
        return watchPaint();
      }
      var ww = near('[data-wwide]');
      if (ww) {
        wt.wide = ww.getAttribute('data-wwide') === '1';
        return watchPaint();
      }
      var wvm = near('[data-wvmode]');
      if (wvm) {
        wt.vmode = wvm.getAttribute('data-wvmode');
        if (wt.vmode === 'color' || wt.vmode === 'wire' || wt.vmode === 'refwire') wt.refOn = true; // A, B and C draw the reference: they tick it (it can be unticked after)
        return watchPaint();
      }
      var wpb = near('[data-wparts]');
      if (wpb) {
        wt.partsOpen = !wt.partsOpen;
        return watchPaint();
      }
      var wpt = near('input[data-wpart]');
      if (wpt) {
        var pn = wpt.getAttribute('data-wpart');
        if (wpt.checked) delete wt.hidden[pn];
        else wt.hidden[pn] = true;
        if (wt.mv && wt.mv.handle) wt.mv.handle.setVisible(pn, wpt.checked);
        return;
      }
      var wpr = near('input[data-wpart-ref]');
      if (wpr) {
        wt.refOn = wpr.checked;
        return watchPaint();
      }
      var wm = near('[data-wmode]');
      if (wm) {
        wt.mode = wm.getAttribute('data-wmode');
        return watchPaint();
      }
      var wsr = near('[data-wstep]');
      if (wsr) {
        var wn = Number(wsr.getAttribute('data-wstep'));
        var wi = wtSteps().map(function (x) { return x.n; }).indexOf(wn);
        return wi < 0 ? undefined : scrubTo(wi);
      }
      if (near('[data-wnow]')) {
        wt.follow = true;
        wt.seen = wtSteps().length;
        return watchPaint();
      }
      if (near('[data-unpick]')) {
        mPicked = null;
        return render();
      }
      var mt = near('.th[data-key]');
      if (mt) {
        mPicked = mt.getAttribute('data-key');
        return render();
      }
    }
    if (near('[data-settings]')) {
      // the host opens Settings → Apps (this frame cannot navigate): the click only, ≤ 1/s, on the port only
      if (port && Date.now() - settingsAt >= 1000) {
        settingsAt = Date.now();
        port.postMessage({ panel: 'open-settings' });
      }
      return;
    }
    var mc = near('[data-mchip]');
    if (mc) {
      mChip = mc.getAttribute('data-mchip');
      return render();
    }
    var wj = near('[data-wjob]');
    if (wj) { // a job row: open it (Watch is opening a job, v3)
      tab = 'watch';
      setJob(wj.getAttribute('data-wjob'));
      wt.picked = true;
      lastSig = '';
      render();
      clearTimeout(pollTimer);
      return watchPoll();
    }
    if (near('[data-genback]')) {
      genOpen = null;
      return render();
    }
    var gk = near('[data-genkey]');
    if (gk) {
      genOpen = gk.getAttribute('data-genkey');
      return render();
    }
    var gs = near('[data-gstep]');
    if (gs) return genStep(Number(gs.getAttribute('data-gstep')));
    if (pinMenu && Date.now() - pinMenu.at > 400 && !near('.pinmenu, [data-pinsel], .mv-pmenu')) { // any other tap closes the pin menu, as for a picture mark
      pinMenu = null;
      lastSig = '';
      render();
      if (!near('button, a, [data-pinarm]')) return;
    }
    var pa = near('[data-pinarm]'); // arm / disarm: the next press on the model places a pin
    if (pa) {
      pinArm = pinArm ? null : { move: null };
      lastSig = '';
      return render();
    }
    var ps = near('[data-pinsel]');
    if (ps) {
      openPinMenu(ps.getAttribute('data-pinsel'), 'chip');
      lastSig = '';
      return render();
    }
    var pv = near('[data-pinview]'), pm = near('[data-pinmove]'), pr = near('[data-pinrm]');
    if (pv || pm || pr) pinMenu = null; // an action ends the menu
    if (pv) return pinAction('view', pv.getAttribute('data-pinview'));
    if (pm) return pinAction('move', pm.getAttribute('data-pinmove'));
    if (pr) return pinAction('rm', pr.getAttribute('data-pinrm'));
    var ptb = near('[data-part]'), pti = near('[data-isolate]'), psa = near('[data-showall]');
    if (ptb || pti || psa) { // the parts: hide / show, isolate, Restore all
      var vh = viewerHandle();
      if (vh) {
        if (psa) vh.showAll();
        else if (pti) vh.isolate(pti.getAttribute('data-isolate'));
        else vh.setVisible(ptb.getAttribute('data-part'), ptb.getAttribute('aria-pressed') !== 'true');
      }
      lastSig = '';
      return render();
    }
    var at = near('[data-alt]'); // an alternative's tab: what is shown only
    if (at && data && large) {
      var ait = rawItem(large.n);
      if (ait) {
        altSel[ait.n + ':' + verIdx(ait).ver.v] = at.getAttribute('data-alt');
        lastSig = '';
        return render();
      }
    }
    var pkb = near('[data-pick]');
    if (pkb) return doPick(large ? large.n : curN, pkb.getAttribute('data-pick'));
    var scb = near('[data-scope]');
    if (scb) return doScope(large ? large.n : curN, scb.getAttribute('data-scope'), scb.getAttribute('data-sdec'));
    if (near('[data-mretry]')) { // the model's failed state: mount it afresh
      dropViewer();
      lastSig = '';
      return render();
    }
    var fd = near('[data-fold]');
    if (fd) { // a fold's heading: open / close it, kept for this viewer
      var fk = fd.getAttribute('data-fold');
      folds[fk] = !foldOpen(fk, fd.getAttribute('data-fdef') === '1');
      lastSig = '';
      return render();
    }
    var cd = near('.card[data-n]');
    if (cd) {
      var ti = near('.c3 [data-i]');
      return openReview(Number(cd.getAttribute('data-n')), null, ti ? Number(ti.getAttribute('data-i')) : 0);
    }
    if (near('[data-more]')) {
      showResolved = !showResolved;
      render();
      return;
    }
    if (large) {
      if (near('[data-back]')) return closeReview();
      var vb = near('[data-ver]');
      if (vb) {
        large.v = Number(vb.getAttribute('data-ver'));
        large.i = 0;
        return render();
      }
      if (near('[data-unfocus]')) {
        large.focus = false;
        return render();
      }
      if (near('[data-unfimg]')) {
        large.fimg = null;
        return render();
      }
      var fo = near('[data-fimg]');
      if (fo) {
        large.fimg = fo.getAttribute('data-fimg');
        return render();
      }
      if (near('[data-zreset]')) {
        zoom = { id: zoom.id, z: 1, tx: 0, ty: 0 };
        if (zoomApply) zoomApply();
        return;
      }
      var md = near('[data-mkdel]');
      if (md) return delMark(md.getAttribute('data-mkdel'));
      var mv = near('[data-mkview]');
      if (mv) {
        setMarkView(mv.getAttribute('data-mkview'));
        markMenu = null;
        return render();
      }
      if (markMenu && Date.now() - markMenuAt > 400 && !near('.mkmenu')) { // any other tap closes the menu
        markMenu = null;
        render();
        if (!near('button, a')) return;
      }
      if (near('[data-mkclose]')) {
        markMenu = null;
        return render();
      }
      if (near('[data-pick]')) return openPicker();
      if (near('[data-addref]')) return addRef(near('.vban') ? null : {}); // the banner retries what was pasted; the button = the newest room image
      var rd = near('[data-refdel]');
      if (rd) {
        var rit = data && itemOf(data);
        var rid = rd.getAttribute('data-refdel');
        if (rit && sendAction('review_ref', { n: String(rit.n) }, { remove: rid }, function (r) {
          if (r.ok !== true && !r.blocked) toast('Not removed: ' + (r.error || 'try again'));
          refresh();
        })) {
          rit.user_refs = (rit.user_refs || []).filter(function (x) { return x !== rid; });
          large.fref = null;
          lastSig = '';
          render();
        }
        return;
      }
      var ft = near('[data-ftab]');
      if (ft) {
        large.ftab = ft.getAttribute('data-ftab');
        return render();
      }
      var fs = near('[data-fstep]');
      if (fs) return step(Number(fs.getAttribute('data-fstep')), 0);
      var fr = near('[data-fref]');
      if (fr) { // tap a reference = compare with it; tap it again = stop (marks come back)
        large.fref = large.fref === fr.getAttribute('data-fref') ? null : fr.getAttribute('data-fref');
        return render();
      }
      var qv = near('[data-qv]');
      if (qv) return quickVote(Number(qv.getAttribute('data-qi')), qv.getAttribute('data-qv'));
      var row = near('[data-frow]');
      if (row) { // a summary row / Begin / Edit review: the focus page on that image
        large.focus = true;
        large.fimg = null;
        large.i = Number(row.getAttribute('data-frow')) || 0;
        render();
        window.scrollTo(0, 0);
        return;
      }
      var nx = near('[data-noteexp]');
      if (nx) {
        noteOpen[nx.getAttribute('data-noteexp')] = !noteOpen[nx.getAttribute('data-noteexp')];
        return render();
      }
      var is = near('[data-isend]');
      if (is) return submitOne(Number(is.getAttribute('data-isend')));
      var rfs = near('[data-rfstep]');
      if (rfs) return refStep(Number(rfs.getAttribute('data-rfstep')));
      if (near('[data-focus]') && !swiped) {
        large.focus = true;
        large.ftab = large.ftab || 'review';
        return render();
      }
      var cm = near('[data-cmpmode]');
      if (cm) {
        cmpMode = cm.getAttribute('data-cmpmode');
        return render();
      }
      var sb = near('[data-idx]');
      if (sb) {
        large.i = Number(sb.getAttribute('data-idx'));
        return render();
      }
      var fv = near('[data-fb]');
      if (fv) {
        var k = fv.getAttribute('data-fb');
        if (k === 'up' || k === 'down') {
          fb.verdict = fb.verdict === k ? null : k; // a second tap clears it
          fb.msg = '';
          fbPaint();
          flush();
        }
        return;
      }
      if (near('.cur') && swiped) {
        swiped = false;
        e.preventDefault(); // a swipe, not a tap: don't open the file
      }
      return;
    }
    if (near('[data-close]')) {
      detail = picked = null;
      render();
      return;
    }
    var cp = near('[data-copy]');
    if (cp) return copy(cp.getAttribute('data-copy'));
    var t = tileOf(e.target);
    if (t) openGen(t.getAttribute('data-key'));
  });
  root.addEventListener('keydown', function (e) {
    var t = tileOf(e.target);
    if (t && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openGen(t.getAttribute('data-key'));
    }
  });
  /* the scrubber (and a Steps row): one position per step. Back = let go of FOLLOW (the new steps are counted from here); the last one = follow again */
  function scrubTo(pos) {
    var st = wtSteps();
    var i = Math.max(0, Math.min(st.length - 1, pos));
    if (!st[i]) return;
    wt.at = st[i].n;
    if (i === st.length - 1) {
      wt.follow = true;
      wt.seen = st.length;
    } else if (wt.follow) {
      wt.follow = false;
      wt.seen = st.length;
    }
    watchPaint();
  }
  root.addEventListener('input', function (e) {
    var on = e.target && e.target.getAttribute && e.target.getAttribute('data-onote');
    if (on) { // the overall note: grows as you type, saved a moment after the last key (still inside its activation)
      onote = { n: Number(on), text: e.target.value };
      grow(e.target);
      clearTimeout(noteTimer);
      noteTimer = setTimeout(saveNote, FB_TYPE_MS);
      return;
    }
    var pcm = e.target && e.target.getAttribute && e.target.getAttribute('data-pincmt');
    if (pcm) { // a pin's comment: grows as you type, saved a moment after the last key
      pinCmt = { label: pcm, text: e.target.value };
      grow(e.target);
      clearTimeout(pinCmtTimer);
      pinCmtTimer = setTimeout(saveCmt, FB_TYPE_MS);
      return;
    }
    var pc = e.target && e.target.getAttribute && e.target.getAttribute('data-pickcmt');
    if (pc) { // the pick's comment: grows as you type, saved a moment after the last key
      pcmt = { n: Number(pc), text: e.target.value };
      grow(e.target);
      clearTimeout(pcmtTimer);
      pcmtTimer = setTimeout(savePickCmt, FB_TYPE_MS);
      return;
    }
    if (e.target && e.target.getAttribute('data-w') === 'scrub') return scrubTo(Number(e.target.value) || 0);
    if (e.target && e.target.getAttribute('data-fb') === 'comment') {
      fb.comment = e.target.value;
      if (fb.msg && !act.busy) { fb.msg = ''; fb.bad = false; } // typing clears a stale status
      fbPaint();
      clearTimeout(typeTimer);
      typeTimer = setTimeout(function () { flush(); }, FB_TYPE_MS);
    }
  });
  root.addEventListener('change', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-onote')) { clearTimeout(noteTimer); return saveNote(); }
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-pickcmt')) { clearTimeout(pcmtTimer); return savePickCmt(); }
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-pincmt')) { clearTimeout(pinCmtTimer); return saveCmt(); }
    if (e.target && e.target.getAttribute('data-w') === 'job') { // Watch: another job
      wt.picked = true;
      setJob(e.target.value);
      watchRefresh();
      clearTimeout(pollTimer);
      return watchPoll();
    }
    if (e.target && e.target.getAttribute('data-fb') === 'comment') flush(); // leaving the box
  });
  document.addEventListener('keydown', function (e) {
    if (!large && genOpen && GROUP[tab] === 'images' && !e.altKey && !e.ctrlKey && !e.metaKey) { // a generation's page
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') genStep(e.key === 'ArrowLeft' ? -1 : 1);
      else if (e.key === 'Escape') { genOpen = null; render(); }
      else return;
      return e.preventDefault();
    }
    if (!large || e.altKey || e.ctrlKey || e.metaKey || typing()) return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && large.fimg) refStep(e.key === 'ArrowLeft' ? -1 : 1); // a reference: its own pager
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !large.focus) return; // the summary has no stage
    else if (e.key === 'ArrowLeft') step(-1, 0);
    else if (e.key === 'ArrowRight') step(1, 0);
    else if (e.key === '[') step(0, -1);
    else if (e.key === ']') step(0, 1);
    else if (e.key === 'Escape') {
      if (pinMenu) { pinMenu = null; lastSig = ''; render(); } // an open pin menu closes first
      else if (pinArm) { pinArm = null; lastSig = ''; render(); } // then an armed placement: only that, the focus page stays
      else if (large.fimg) { large.fimg = null; render(); } // an opened reference goes back to its image first
      else if (large.focus) { large.focus = false; render(); } // the focus page goes back to its review first
      else closeReview();
    }
    else return;
    e.preventDefault();
    flush(); // a key is a person's action too: carry what the last image left unsaved
  });
  /* swipe on the large image only (not on a 3D model: its drag is the viewer's): lock the axis after 8px; a horizontal swipe of 40px steps */
  var sx = 0, sy = 0, axis = null, swiped = false;
  root.addEventListener('touchstart', function (e) {
    if (e.target.closest && e.target.closest('.mv')) { axis = null; return; } // the 3D viewer's own gestures (orbit, zoom, pins): never a step
    if (!large || !e.target.closest || !e.target.closest('.rv .cur') || e.target.closest('.rv .cur.mode-slider') || e.target.closest('.mk') || e.target.closest('.rv .cur.zoomed')) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    axis = null;
    swiped = false;
  }, { passive: true });
  root.addEventListener('touchmove', function (e) {
    if (e.target.closest && e.target.closest('.mv')) return;
    if (!large || !e.target.closest || !e.target.closest('.rv .cur') || e.target.closest('.rv .cur.mode-slider') || e.target.closest('.mk') || e.target.closest('.rv .cur.zoomed')) return;
    var dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    if (axis === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (axis === 'x') e.preventDefault();
  }, { passive: false });
  root.addEventListener('touchend', function (e) {
    if (!large || axis !== 'x') return;
    var dx = e.changedTouches[0].clientX - sx;
    axis = null;
    if (Math.abs(dx) > 40) {
      swiped = true;
      e.preventDefault();
      step(dx < 0 ? 1 : -1, 0);
    }
  });
  root.addEventListener('load', function (e) {
    if (e.target && e.target.tagName === 'IMG') reportHeight();
  }, true);
  /* a mark: press ＋ Mark (or a mark), drag, release on the image */
  root.addEventListener('pointerdown', function (e) {
    if (!large || !large.focus || markDrag || (e.button && e.button !== 0) || !e.target.closest) return;
    var h = e.target.closest('[data-mkadd], [data-mk], [data-pinadd]');
    if (!h || h.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    try { h.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
    var g = el('span', 'aimx' + (e.pointerType === 'touch' ? '' : ' mouse')); // touch: the crosshair above the finger
    document.body.appendChild(g);
    html.classList.add('marking'); // the precision cursor, everywhere while a mark is in the air
    var lab = h.getAttribute('data-mk');
    markDrag = { label: lab, g: g, src: lab ? h : null, x0: e.clientX, y0: e.clientY, moved: false, model: h.hasAttribute('data-pinadd') };
    if (lab) h.classList.add('moving');
    moveGhost(e);
  }, true);
  window.addEventListener('pointermove', function (e) {
    if (markDrag) moveGhost(e);
  });
  /* armed (Tap to place / Move): the model stays fully live — rotate, pan and zoom with the mouse, the wheel or one or two fingers — and only a
     DECISIVE TAP places: press and release on the model with almost no travel (6 px mouse, 10 px finger), within 400 ms, primary button or one
     finger. A drag, a second finger or a long press is the camera's and places nothing. Nothing here takes the press from the viewer.
     Aim preview: a mouse shows the ring on the surface as it hovers (no press needed); a finger has none (nothing to hold), so it taps the
     spot itself — no lift above the finger — after panning and zooming to see it. ("rotate/pan/zoom and then a decisive tap") */
  var armTap = null, armHoverAt = 0;
  var onStage = function (e) { return !!(e.target && e.target.tagName === 'CANVAS' && e.target.closest && e.target.closest('.mv')); };
  root.addEventListener('pointerdown', function (e) {
    if (!pinArm || !onStage(e)) return;
    if (armTap && armTap.id !== e.pointerId) armTap.multi = true; // a second finger: a pinch or a pan
    else if (!armTap && (e.pointerType === 'touch' || e.button === 0)) armTap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moved: false, multi: false, touch: e.pointerType === 'touch' };
  }, true);
  root.addEventListener('pointermove', function (e) {
    if (armTap && armTap.id === e.pointerId && Math.hypot(e.clientX - armTap.x, e.clientY - armTap.y) > (armTap.touch ? 10 : 6)) armTap.moved = true;
    if (pinArm && !armTap && e.pointerType === 'mouse' && e.buttons === 0 && onStage(e) && Date.now() - armHoverAt > 60) { // hover: the ring on the surface
      armHoverAt = Date.now();
      modelAim(e);
    }
  });
  root.addEventListener('pointerout', function (e) {
    if (pinArm && e.pointerType === 'mouse' && onStage(e) && viewerHandle()) viewerHandle().setPreview(null);
  });
  root.addEventListener('pointerup', function (e) {
    var t = armTap;
    if (!t) return;
    if (e.pointerId !== t.id) { t.multi = true; return; }
    armTap = null;
    var h = viewerHandle();
    if (h) h.setPreview(null);
    if (!pinArm || t.moved || t.multi || Date.now() - t.t > 400 || !onStage(e)) return; // a drag, a pinch, a hold: the camera's
    var info = h ? h.pick(e.clientX, e.clientY) : null;
    placePin(info, pinArm && pinArm.move); // nothing under it: it says so, and stays armed
  });
  root.addEventListener('pointercancel', function () { armTap = null; });
  window.addEventListener('pointerup', function (e) {
    if (markDrag) dropMark(e);
  });
  window.addEventListener('pointercancel', function () {
    if (markDrag) endDrag();
  });
  /* your own reference: paste or drop an image on the focus page */
  document.addEventListener('paste', function (e) {
    if (pasteFiles(e.clipboardData && e.clipboardData.files, 'paste')) return e.preventDefault();
    // a copied reference ("Copy reference" = a Library id) adds THAT image — no duplicate ;
    // text pasted into the comment box stays text
    if (!large || !large.focus || typing()) return;
    var t = ((e.clipboardData && e.clipboardData.getData('text')) || '').trim();
    var m = t.length <= 300 && /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(t);
    if (!m) return;
    e.preventDefault();
    refAsk = { n: large.n };
    addRef({ image: m[1].toLowerCase() });
  });
  var hasFiles = function (e) { return !!e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
  document.addEventListener('dragover', function (e) {
    if (!large || !large.focus || !hasFiles(e)) return;
    e.preventDefault();
    html.classList.add('dropping');
  });
  document.addEventListener('dragleave', function (e) {
    if (!e.relatedTarget) html.classList.remove('dropping');
  });
  document.addEventListener('drop', function (e) {
    html.classList.remove('dropping');
    if (!large || !large.focus || !hasFiles(e)) return;
    e.preventDefault();
    pasteFiles(e.dataTransfer.files, 'drop');
  });
  /* The room's mode and palette (Aurora; briefing-table palette.mjs apply): {host:'theme', mode,
     tokens:{ink, surface, … id-*}} on the port — each token set on <html>, html[data-mode], color-scheme. It comes
     from outside the frame, so only known keys and plain CSS colour strings are taken. Until it arrives (or with
     an older host) the vendored Aurora dark tokens show. */
  var THEME_KEYS = /^(ink|surface|surface2|surface3|border|border2|text|dim|dim2|nav|teal|sky|amber|coral|lime|magenta|indigo|cap-hover|ghost-fill|id-[a-z0-9-]{1,24})$/;
  var CSS_COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color|color-mix)\([0-9a-z%., /+\-()#]{1,140}\))$/i;
  function applyTheme(t) {
    if (t.mode !== 'dark' && t.mode !== 'light') return;
    html.dataset.mode = t.mode;
    html.style.colorScheme = t.mode;
    /* every message is the WHOLE palette: first drop every themed token set before (a host going back to Aurora dark sends
       tokens:{} = "the defaults", so the earlier light values must go), then set the new ones. Walk from the end, the list
       shrinks as it is removed; only names that pass THEME_KEYS, so our own --stage / --viewer / checker stay. */
    for (var i = html.style.length - 1; i >= 0; i--) {
      var name = html.style.item(i);
      if (name.slice(0, 2) === '--' && THEME_KEYS.test(name.slice(2))) html.style.removeProperty(name);
    }
    var tk = t.tokens && typeof t.tokens === 'object' ? t.tokens : {};
    Object.keys(tk).forEach(function (k) {
      var v = tk[k];
      if (THEME_KEYS.test(k) && typeof v === 'string' && v.length <= 160 && CSS_COLOR.test(v.trim())) html.style.setProperty('--' + k, v.trim());
    });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || typeof e.data !== 'object') return;
    if (e.data.host === 'port' && e.ports && e.ports[0]) {
      if (port) return; // handed over once; keep the first
      port = e.ports[0]; // panel actions (addendum 3): review_feedback / review_note / review_send go out on it, results come back
      port.onmessage = function (m) {
        if (!m.data) return;
        if (m.data.host === 'action-result') actResult(m.data);
        else if (m.data.host === 'surface' && typeof m.data.kind === 'string' && m.data.kind !== surface) {
          surface = m.data.kind;
          lastSig = '';
          if (data) render();
        }
        else if (m.data.host === 'theme') applyTheme(m.data);
        else if (m.data.host === 'picked') onPicked(m.data);
        else if (m.data.host === 'app-status' && ['enabled', 'held', 'unregistered'].indexOf(m.data.actions) >= 0 && m.data.actions !== appStatus) {
          appStatus = m.data.actions;
          redraw();
        }
      };
      if (data && tab === 'review') render(); // the form + Send review replace "Open in the room…"
      return;
    }
    if (e.data.panel === 'focus') {
      focusRef(e.data.ref);
      return;
    }
    if (e.data.panel === 'added' && refAsk && !refAsk.click) return addRef({}); // the host put the pasted image in the room
    if (e.data.panel === 'preview-state') {
      hostPreviews = true;
      clearTimeout(ackTimer);
      picked = typeof e.data.key === 'string' ? e.data.key : null;
      markPicked();
    }
  });
  // The column is resizable: height follows width, so re-post it whenever our frame resizes
  // (debounced ~100 ms), not only on load (Aurora room-rail-resize-v1).
  if (typeof ResizeObserver === 'function') {
    var rsTimer = null;
    new ResizeObserver(function () {
      // a tier change re-lays the panel out (columns); every change re-posts the height
      if (applyTier() && data) render();
      if (fitMarks) fitMarks();
      clearTimeout(rsTimer);
      rsTimer = setTimeout(reportHeight, 100);
    }).observe(document.documentElement);
  }
  function fromHash() {
    focusRef(decodeURIComponent(location.hash.slice(1)));
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
  (function (open) { // the page a link or a rail row opened: review/<n>[/v<k>] → that item; tab/<name> → that tab
    var m = /^tab\/(studio|favorites|recycle|models|watch|review)$/.exec(open);
    var w = /^watch\/([A-Za-z0-9_.-]+)$/.exec(open);
    if (m) tab = m[1];
    else if (w) { // a room line's watch/<job> link: the Watch tab on that job
      tab = 'watch';
      setJob(w[1]);
      wt.picked = true;
    } else if (open) focusRef(open);
  })(document.documentElement.getAttribute('data-open') || '');
  poll();
})();
