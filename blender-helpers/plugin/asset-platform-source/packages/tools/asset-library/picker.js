/* asset-picker.js — reusable right-side "asset clipboard" picker widget.
 *
 * Vanilla JS, no framework, no build step. IIFE exposing window.AssetPicker.
 *
 * Talks to the asset-clipboard HTTP API (same-origin, cookie session) under a
 * configurable base (default '/asset-management/library'):
 *   GET    {base}/api/list           -> { session, clips: [clip,...] }
 *   POST   {base}/api/upload  (mult) -> { ok, clip }      (browser file upload)
 *   GET    {base}/api/clip/:id       -> streams WAV (used as audio src + asset url)
 *   PATCH  {base}/api/clip/:id       -> { ok }            (rename: JSON {label})
 *   DELETE {base}/api/clip/:id       -> { ok }
 * clip = { id, seq, file, label, source, lineage, duration_s, ts }
 *
 * Tab/component model (NEW — backward-compatible):
 *   AssetPicker.mount({ base, title, tabs:[{label, component, source?, onSelect?},...] })
 *   components: 'picker' (existing list), 'url-history', 'exported-clips'
 *   If tabs is omitted -> EXACT legacy behavior (single picker list + compare tab).
 *
 * Styling lives in asset-picker.css (the source of truth). If no stylesheet
 * defining .ap-panel is detected at mount, the JS injects a <link> to
 * {base}/picker.css. CSS is NOT inlined here by design — the host links the
 * .css (or the gateway serves it at {base}/picker.css).
 *
 * Public API:
 *   AssetPicker.mount(opts)   -> mounts the panel (idempotent; remounts if called again)
 *   AssetPicker.refresh()     -> re-fetch + re-render the list (Promise)
 *   AssetPicker.getSelected() -> selected asset object or null
 *   AssetPicker.selectById(id)-> programmatically select a clip by id
 *   AssetPicker.unmount()     -> remove the panel + listeners (bonus, for SPA hosts)
 */
(function () {
  'use strict';

  // ---- module state ----
  var cfg = null;          // active mount config
  var rootEl = null;       // .ap-panel
  var toggleEl = null;     // mobile toggle button
  var listEl = null;       // .ap-list (legacy picker mode only)
  var busyEl = null;       // transient status line
  var fileInput = null;    // hidden <input type=file>
  var menuEl = null;       // context menu (one at a time)
  var clips = [];          // last-fetched clip list
  var selectedId = null;   // currently selected clip id
  var audioEls = [];       // live <audio> nodes, for cleanup on re-render
  // ---- compare-tab state ----
  var pickView = null, cmpView = null, cmpTabBtns = null, activeTab = 'picker';
  var cmpListEl = null, cmpSlotsEl = null, cmpStatusEl = null, cmpTransportEl = null;
  var cmpA = null, cmpB = null;   // assigned clips {id,label,url,duration_s}
  // Web Audio A/B engine state (mirrors the voice-filter A/B switch player)
  var actx = null, cmpBufs = { A: null, B: null }, cmpGains = null, cmpSrcs = null;
  var cmpActive = 'A', cmpPlaying = false, cmpStartAt = 0, cmpOffset = 0, cmpDur = 0, cmpRaf = null, cmpSynced = false;
  // ---- configured-tabs state ----
  var tabMode = false;       // true when tabs[] was provided
  var configuredTabs = [];   // [{label, component, source, onSelect}]
  var activeConfigTab = 0;   // index into configuredTabs

  // ---- utils ----

  // HTML-escape user text before insertion (XSS-safe rendering of labels etc.)
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Format duration seconds -> "m:ss" (or "—" if unknown).
  function fmtDur(s) {
    if (s == null || isNaN(s)) return '—';
    s = Math.round(Number(s));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function clipUrl(id) { return cfg.base + '/api/clip/' + encodeURIComponent(id); }

  // Map a raw clip record to the asset object handed to onSelect / getSelected.
  function toAsset(clip) {
    if (!clip) return null;
    return {
      id: clip.id,
      label: clip.label || clip.file || ('clip ' + clip.id),
      url: clipUrl(clip.id),
      duration_s: clip.duration_s,
      source: clip.source
    };
  }

  // When base is an absolute cross-origin URL (e.g. the GPU host register page calling the
  // server asset-library), the library is COOKIELESS — assets are fetched by id, and it
  // answers with Access-Control-Allow-Origin: * (no credentials). A wildcard ACAO cannot
  // be combined with credentialed requests (the browser blocks it), so cross-origin must
  // use credentials:'omit'. Same-origin keeps 'same-origin' (harmless, no cookie needed).
  function isCrossOrigin() { return /^https?:\/\//.test(cfg.base) && cfg.base.indexOf(location.origin) !== 0; }
  function creds() { return isCrossOrigin() ? 'omit' : 'same-origin'; }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = creds();
    return fetch(cfg.base + path, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // DELETE/PATCH may return empty bodies; tolerate that.
      return r.status === 204 ? {} : r.json();
    });
  }

  function fetchAbsolute(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function setBusy(msg) {
    if (!busyEl) return;
    busyEl.textContent = msg || '';
    busyEl.style.display = msg ? 'block' : 'none';
  }

  // ---- stylesheet presence check + lazy link injection ----
  function ensureStylesheet() {
    // Probe: does any rule define .ap-panel? Cheap heuristic — create a node,
    // check that it picked up the fixed/position styling from our CSS.
    var probe = document.createElement('div');
    probe.className = 'ap-panel';
    probe.style.cssText = 'visibility:hidden;position:static';
    document.body.appendChild(probe);
    var styled = getComputedStyle(probe).position === 'fixed';
    document.body.removeChild(probe);
    if (styled) return;
    // Not present — inject a <link> to the gateway-served stylesheet.
    var href = cfg.base + '/picker.css';
    if (document.querySelector('link[href="' + href + '"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  // ---- rendering ----

  function clearAudio() {
    // Pause + detach live audio nodes so re-render doesn't leak players.
    audioEls.forEach(function (a) {
      try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {}
    });
    audioEls = [];
  }

  function renderList(err) {
    closeMenu();
    clearAudio();
    listEl.innerHTML = '';

    if (err) {
      var e = document.createElement('div');
      e.className = 'ap-error';
      e.textContent = 'Could not load assets: ' + err.message;
      listEl.appendChild(e);
      return;
    }
    if (!clips.length) {
      var empty = document.createElement('div');
      empty.className = 'ap-empty';
      empty.textContent = 'No assets yet — drop a file above.';
      listEl.appendChild(empty);
      return;
    }

    clips.forEach(function (clip) {
      var row = document.createElement('div');
      row.className = 'ap-row' + (clip.id === selectedId ? ' ap-selected' : '');
      row.dataset.id = clip.id;

      // Header line: label + duration. Labels escaped (XSS-safe).
      var meta = clip.source ? esc(clip.source) : '';
      if (clip.file) meta += (meta ? ' · ' : '') + esc(clip.file);
      row.innerHTML =
        '<div class="ap-row-top">' +
          '<span class="ap-row-label">' + esc(clip.label || clip.file || ('clip ' + clip.id)) + '</span>' +
          '<span class="ap-row-dur">' + fmtDur(clip.duration_s) + '</span>' +
        '</div>' +
        (meta ? '<div class="ap-row-meta">' + meta + '</div>' : '');

      // Inline mini player — small, native controls, no auto-preload.
      var audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      if (isCrossOrigin()) audio.crossOrigin = 'anonymous';
      audio.src = clipUrl(clip.id);
      // Don't let player clicks change selection or fire the context menu.
      audio.addEventListener('click', function (ev) { ev.stopPropagation(); });
      audioEls.push(audio);
      row.appendChild(audio);

      // Click row (but not the audio) => select.
      row.addEventListener('click', function () { select(clip.id); });
      // Right-click => context menu.
      row.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        openMenu(ev.clientX, ev.clientY, clip);
      });

      listEl.appendChild(row);
    });
  }

  // ---- selection ----

  function select(id) {
    selectedId = id;
    // Toggle highlight without a full re-render (keeps audio state intact).
    Array.prototype.forEach.call(listEl.querySelectorAll('.ap-row'), function (r) {
      r.classList.toggle('ap-selected', r.dataset.id === String(id));
    });
    fireSelect();
  }

  function clearSelection() {
    selectedId = null;
    Array.prototype.forEach.call(listEl.querySelectorAll('.ap-row'), function (r) {
      r.classList.remove('ap-selected');
    });
    fireSelect();
  }

  function fireSelect() {
    if (typeof cfg.onSelect !== 'function') return;
    try { cfg.onSelect(getSelected()); } catch (e) { /* host callback errors are not ours */ }
  }

  function findClip(id) {
    for (var i = 0; i < clips.length; i++) if (String(clips[i].id) === String(id)) return clips[i];
    return null;
  }

  function getSelected() { return toAsset(findClip(selectedId)); }

  // ---- context menu ----

  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    document.removeEventListener('click', onDocClickClose, true);
    document.removeEventListener('keydown', onEscClose, true);
  }
  function onDocClickClose(ev) { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); }
  function onEscClose(ev) { if (ev.key === 'Escape') closeMenu(); }

  function openMenu(x, y, clip) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ap-menu';

    var rename = document.createElement('div');
    rename.className = 'ap-menu-item';
    rename.textContent = 'Rename';
    rename.addEventListener('click', function () { closeMenu(); doRename(clip); });

    var del = document.createElement('div');
    del.className = 'ap-menu-item ap-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', function () { closeMenu(); doDelete(clip); });

    menuEl.appendChild(rename);
    menuEl.appendChild(del);
    document.body.appendChild(menuEl);

    // Position at cursor, nudged in-bounds.
    var r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';

    // Defer listeners so the opening click doesn't immediately close it.
    setTimeout(function () {
      document.addEventListener('click', onDocClickClose, true);
      document.addEventListener('keydown', onEscClose, true);
    }, 0);
  }

  function doRename(clip) {
    var next = window.prompt('Rename asset', clip.label || clip.file || '');
    if (next == null) return;                 // cancelled
    next = next.trim();
    if (!next || next === clip.label) return; // no-op
    setBusy('Renaming…');
    api('/api/clip/' + encodeURIComponent(clip.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: next })
    }).then(function () {
      setBusy('');
      return refresh();          // re-render with new label
    }).catch(function (e) {
      setBusy('');
      renderError('Rename failed: ' + e.message);
    });
  }

  function doDelete(clip) {
    if (!window.confirm('Delete "' + (clip.label || clip.file || clip.id) + '"? This cannot be undone.')) return;
    setBusy('Deleting…');
    api('/api/clip/' + encodeURIComponent(clip.id), { method: 'DELETE' })
      .then(function () {
        // If the deleted clip was selected, clear selection (fires onSelect(null)).
        if (String(selectedId) === String(clip.id)) { selectedId = null; fireSelect(); }
        setBusy('');
        return refresh();
      })
      .catch(function (e) {
        setBusy('');
        renderError('Delete failed: ' + e.message);
      });
  }

  function renderError(msg) {
    // Non-throwing inline error surfaced above the list.
    var e = document.createElement('div');
    e.className = 'ap-error';
    e.textContent = msg;
    listEl.insertBefore(e, listEl.firstChild);
    setTimeout(function () { if (e.parentNode) e.parentNode.removeChild(e); }, 5000);
  }

  // ---- upload ----

  function uploadFiles(files) {
    if (!files || !files.length) return;
    // Upload sequentially; the last successful upload becomes selected.
    var arr = Array.prototype.slice.call(files);
    var lastClip = null;
    setBusy('Uploading ' + arr.length + ' file' + (arr.length > 1 ? 's' : '') + '…');

    var chain = Promise.resolve();
    arr.forEach(function (f) {
      chain = chain.then(function () {
        var fd = new FormData();
        fd.append('file', f, f.name);
        return api('/api/upload', { method: 'POST', body: fd })
          .then(function (res) { if (res && res.clip) lastClip = res.clip; });
      });
    });

    chain.then(function () {
      setBusy('');
      return refresh().then(function () {
        // New file becomes the selected asset automatically.
        if (lastClip && findClip(lastClip.id)) select(lastClip.id);
      });
    }).catch(function (e) {
      setBusy('');
      renderError('Upload failed: ' + e.message);
    });
  }

  // ---- compare tab (legacy picker mode only) ----

  function setTab(t) {
    activeTab = t;
    if (cmpTabBtns) {
      cmpTabBtns.picker.classList.toggle('ap-tab-active', t === 'picker');
      cmpTabBtns.compare.classList.toggle('ap-tab-active', t === 'compare');
    }
    if (pickView) pickView.style.display = (t === 'picker') ? '' : 'none';
    if (cmpView) cmpView.style.display = (t === 'compare') ? '' : 'none';
    if (t === 'compare') {
      // seed slot A from the current picker selection (per the user: existing selection auto-becomes A)
      if (!cmpA && selectedId) { var c = findClip(selectedId); if (c) cmpA = toAsset(c); }
      renderCompare();
    } else {
      cmpStop();
    }
  }

  function buildCompareView() {
    var v = document.createElement('div');
    v.className = 'ap-view';
    // shared transport (built lazily on load); slots; status; list
    cmpTransportEl = document.createElement('div');
    cmpTransportEl.className = 'ap-cmp-transport';
    cmpSlotsEl = document.createElement('div');
    cmpSlotsEl.className = 'ap-cmp-slots';
    cmpStatusEl = document.createElement('div');
    cmpStatusEl.className = 'ap-cmp-status';
    var hint = document.createElement('div');
    hint.className = 'ap-cmp-hint';
    hint.textContent = 'Pick two clips to compare. One plays solo; two flip live as you play.';
    cmpListEl = document.createElement('div');
    cmpListEl.className = 'ap-list';
    v.appendChild(cmpSlotsEl);
    v.appendChild(cmpTransportEl);
    v.appendChild(cmpStatusEl);
    v.appendChild(hint);
    v.appendChild(cmpListEl);
    return v;
  }

  function cmpSetStatus(msg) { if (cmpStatusEl) cmpStatusEl.textContent = msg || ''; }

  function assignSlot(asset) {
    // click-to-assign: fill A first, then B; clicking an already-assigned clip clears it.
    if (cmpA && cmpA.id === asset.id) { cmpA = null; }
    else if (cmpB && cmpB.id === asset.id) { cmpB = null; }
    else if (!cmpA) { cmpA = asset; }
    else if (!cmpB) { cmpB = asset; }
    else { cmpA = asset; cmpB = null; }   // both full -> restart with new A
    cmpStop();
    renderCompare();
    loadCompareBuffers();
  }
  function clearSlot(which) { if (which === 'A') cmpA = null; else cmpB = null; cmpStop(); renderCompare(); loadCompareBuffers(); }

  function renderCompare() {
    // slots/chips
    cmpSlotsEl.innerHTML = '';
    [['A', cmpA], ['B', cmpB]].forEach(function (pair) {
      var k = pair[0], a = pair[1];
      var chip = document.createElement('div');
      chip.className = 'ap-chip ap-chip-' + k + (a ? '' : ' ap-chip-empty');
      chip.innerHTML = '<span class="ap-chip-tag">' + k + '</span>' +
        '<span class="ap-chip-name">' + (a ? esc(a.label) : '— pick a clip —') + '</span>' +
        (a ? '<span class="ap-chip-x" title="clear">✕</span>' : '');
      if (a) chip.querySelector('.ap-chip-x').addEventListener('click', function (e) { e.stopPropagation(); clearSlot(k); });
      cmpSlotsEl.appendChild(chip);
    });
    // transport
    buildTransport();
    // list (assign by click; highlight assigned)
    cmpListEl.innerHTML = '';
    if (!clips.length) { var e = document.createElement('div'); e.className = 'ap-empty'; e.textContent = 'No clips yet.'; cmpListEl.appendChild(e); return; }
    clips.forEach(function (clip) {
      var row = document.createElement('div');
      var slot = (cmpA && cmpA.id === clip.id) ? 'A' : (cmpB && cmpB.id === clip.id) ? 'B' : '';
      row.className = 'ap-row ap-cmp-row' + (slot ? ' ap-selected' : '');
      row.innerHTML = '<div class="ap-row-top"><span class="ap-row-label">' +
        (slot ? '<b class="ap-rowslot">' + slot + '</b> ' : '') + esc(clip.label || clip.file) +
        '</span><span class="ap-row-dur">' + fmtDur(clip.duration_s) + '</span></div>';
      row.addEventListener('click', function () { assignSlot(toAsset(clip)); });
      cmpListEl.appendChild(row);
    });
  }

  // --- Web Audio A/B transport (generalized voice-filter switch player) ---
  function ensureActx() { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); return actx; }

  async function fetchBuf(url) {
    var r = await fetch(url, { credentials: creds() });
    if (!r.ok) throw new Error('fetch ' + r.status);
    return await ensureActx().decodeAudioData(await r.arrayBuffer());
  }

  async function loadCompareBuffers() {
    cmpStop(); cmpBufs = { A: null, B: null }; cmpSynced = false;
    if (!cmpA && !cmpB) { cmpSetStatus(''); buildTransport(); return; }
    cmpSetStatus('Loading…');
    try {
      if (cmpA) cmpBufs.A = await fetchBuf(cmpA.url);
      if (cmpB) cmpBufs.B = await fetchBuf(cmpB.url);
      var lens = [cmpBufs.A && cmpBufs.A.duration, cmpBufs.B && cmpBufs.B.duration].filter(function (x) { return x; });
      cmpDur = lens.length ? Math.max.apply(null, lens) : 0;
      // length-mismatch policy: sync only if within 2x; else note + solo playback
      if (cmpBufs.A && cmpBufs.B) {
        var lo = Math.min(cmpBufs.A.duration, cmpBufs.B.duration), hi = Math.max(cmpBufs.A.duration, cmpBufs.B.duration);
        cmpSynced = (hi <= lo * 2);
        cmpSetStatus(cmpSynced ? 'Two clips loaded — play and flip A/B live.'
          : 'Lengths differ a lot — playing separately (no live flip).');
      } else {
        cmpSynced = false; cmpSetStatus('One clip — plays solo. Pick a second to compare.');
      }
      cmpActive = cmpA ? 'A' : 'B';
      buildTransport();
    } catch (e) { cmpSetStatus('Could not load: ' + e.message); }
  }

  function fmtT(s) { if (!isFinite(s) || s < 0) s = 0; var m = Math.floor(s / 60), x = Math.floor(s % 60); return m + ':' + (x < 10 ? '0' : '') + x; }

  function buildTransport() {
    if (!cmpTransportEl) return;
    cmpTransportEl.innerHTML = '';
    var haveAny = (cmpBufs.A || cmpBufs.B);
    if (!haveAny) { cmpTransportEl.style.display = 'none'; return; }
    cmpTransportEl.style.display = '';

    var play = document.createElement('button');
    play.className = 'ap-cmp-play'; play.type = 'button'; play.textContent = cmpPlaying ? '⏸' : '▶';
    play.addEventListener('click', function () { cmpPlaying ? cmpPause() : cmpPlay(); });

    var cur = document.createElement('span'); cur.className = 'ap-cmp-time'; cur.id = 'apCmpCur'; cur.textContent = fmtT(cmpOffset);
    var dur = document.createElement('span'); dur.className = 'ap-cmp-time'; dur.textContent = fmtT(cmpDur);
    var seek = document.createElement('input'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = cmpDur ? Math.round(cmpOffset / cmpDur * 1000) : 0; seek.className = 'ap-cmp-seek'; seek.id = 'apCmpSeek';
    seek.addEventListener('input', function () { var was = cmpPlaying; if (was) cmpStopNodes(); cmpOffset = (seek.value / 1000) * cmpDur; cur.textContent = fmtT(cmpOffset); if (was) cmpPlay(); });

    var row = document.createElement('div'); row.className = 'ap-cmp-trow';
    row.appendChild(play); row.appendChild(cur); row.appendChild(seek); row.appendChild(dur);
    cmpTransportEl.appendChild(row);

    // A/B toggle only when two synced clips are loaded
    if (cmpBufs.A && cmpBufs.B && cmpSynced) {
      var tog = document.createElement('div'); tog.className = 'ap-cmp-toggle';
      [['A', cmpA], ['B', cmpB]].forEach(function (pair) {
        var k = pair[0], a = pair[1];
        var b = document.createElement('button'); b.type = 'button';
        b.className = 'ap-cmp-tgl' + (cmpActive === k ? ' ap-cmp-tgl-on' : '');
        b.textContent = k + ': ' + (a ? a.label : '');
        b.addEventListener('click', function () { cmpSetActive(k); });
        tog.appendChild(b);
      });
      cmpTransportEl.appendChild(tog);
    } else if (cmpBufs.A && cmpBufs.B && !cmpSynced) {
      // separate play buttons fallback
      var sep = document.createElement('div'); sep.className = 'ap-cmp-toggle';
      [['A', cmpA], ['B', cmpB]].forEach(function (pair) {
        var k = pair[0];
        var b = document.createElement('button'); b.type = 'button'; b.className = 'ap-cmp-tgl';
        b.textContent = '▶ ' + k; b.addEventListener('click', function () { cmpActive = k; cmpOffset = 0; cmpPlay(true); });
        sep.appendChild(b);
      });
      cmpTransportEl.appendChild(sep);
    }
  }

  function cmpSetActive(k) {
    cmpActive = k;
    if (cmpGains && actx) {
      var t = actx.currentTime;
      cmpGains.A.gain.setTargetAtTime(k === 'A' ? 1 : 0, t, 0.008);
      cmpGains.B.gain.setTargetAtTime(k === 'B' ? 1 : 0, t, 0.008);
    }
    // reflect active state on toggle buttons
    if (cmpTransportEl) Array.prototype.forEach.call(cmpTransportEl.querySelectorAll('.ap-cmp-tgl'), function (b) {
      b.classList.toggle('ap-cmp-tgl-on', b.textContent.charAt(0) === k);
    });
  }

  function cmpBuildGraph(startOffset, soloOnly) {
    var ctx = ensureActx();
    cmpGains = { A: ctx.createGain(), B: ctx.createGain() };
    cmpGains.A.gain.value = cmpActive === 'A' ? 1 : 0;
    cmpGains.B.gain.value = cmpActive === 'B' ? 1 : 0;
    cmpGains.A.connect(ctx.destination); cmpGains.B.connect(ctx.destination);
    cmpSrcs = {};
    var when = ctx.currentTime;
    ['A', 'B'].forEach(function (k) {
      if (!cmpBufs[k]) return;
      if (soloOnly && k !== cmpActive) return;
      var src = ctx.createBufferSource(); src.buffer = cmpBufs[k]; src.connect(cmpGains[k]);
      src.onended = cmpOnEnded;
      var o = Math.min(startOffset, cmpBufs[k].duration);
      try { src.start(when, o); } catch (e) {}
      cmpSrcs[k] = src;
    });
    cmpStartAt = when - startOffset;
  }
  function cmpOnEnded() {
    if (!cmpPlaying) return;
    var pos = actx.currentTime - cmpStartAt;
    if (pos >= cmpDur - 0.05) { cmpStopNodes(); cmpPlaying = false; cmpOffset = 0; buildTransport(); }
  }
  function cmpPlay(solo) {
    if (!cmpBufs.A && !cmpBufs.B) return;
    var ctx = ensureActx(); if (ctx.state === 'suspended') ctx.resume();
    cmpBuildGraph(cmpOffset, !!solo || !cmpSynced); cmpPlaying = true; buildTransport(); cmpTick();
  }
  function cmpStopNodes() {
    if (cmpSrcs) { ['A', 'B'].forEach(function (k) { if (cmpSrcs[k]) { try { cmpSrcs[k].onended = null; cmpSrcs[k].stop(); } catch (e) {} } }); cmpSrcs = null; }
    if (cmpRaf) { cancelAnimationFrame(cmpRaf); cmpRaf = null; }
  }
  function cmpPause() { if (actx) cmpOffset = Math.min(actx.currentTime - cmpStartAt, cmpDur); cmpStopNodes(); cmpPlaying = false; buildTransport(); }
  function cmpStop() { cmpStopNodes(); cmpPlaying = false; cmpOffset = 0; }
  function cmpTick() {
    var pos = Math.min(actx.currentTime - cmpStartAt, cmpDur);
    var cur = document.getElementById('apCmpCur'), seek = document.getElementById('apCmpSeek');
    if (cur) cur.textContent = fmtT(pos);
    if (seek) seek.value = cmpDur ? Math.round(pos / cmpDur * 1000) : 0;
    if (cmpPlaying) cmpRaf = requestAnimationFrame(cmpTick);
  }

  // ---- configured-tabs components ----

  function buildUrlHistoryComponent(tab, containerEl) {
    containerEl.innerHTML = '<div class="ap-empty">Loading history…</div>';
    fetchAbsolute(tab.source).then(function (data) {
      var history = (data && data.history) || [];
      containerEl.innerHTML = '';
      if (!history.length) {
        var empty = document.createElement('div');
        empty.className = 'ap-empty';
        empty.textContent = 'No history yet — rip a clip first.';
        containerEl.appendChild(empty);
        return;
      }
      var grid = document.createElement('div');
      grid.className = 'ap-hist-grid';
      history.forEach(function (entry) {
        var card = document.createElement('div');
        card.className = 'ap-hist-card';
        var thumb = document.createElement('img');
        thumb.className = 'ap-hist-thumb';
        thumb.src = entry.thumbnail || ('https://i.ytimg.com/vi/' + esc(entry.video_id) + '/hqdefault.jpg');
        thumb.alt = '';
        thumb.loading = 'lazy';
        var label = document.createElement('div');
        label.className = 'ap-hist-label';
        label.textContent = entry.title || entry.url;
        card.appendChild(thumb);
        card.appendChild(label);
        card.addEventListener('click', function () {
          if (typeof tab.onSelect === 'function') {
            try { tab.onSelect(entry); } catch (e) {}
          }
          // highlight
          Array.prototype.forEach.call(containerEl.querySelectorAll('.ap-hist-card'), function (c) {
            c.classList.remove('ap-hist-selected');
          });
          card.classList.add('ap-hist-selected');
        });
        grid.appendChild(card);
      });
      containerEl.appendChild(grid);
    }).catch(function (e) {
      containerEl.innerHTML = '<div class="ap-error">Could not load history: ' + esc(e.message) + '</div>';
    });
  }

  function buildExportedClipsComponent(tab, containerEl) {
    containerEl.innerHTML = '<div class="ap-empty">Loading clips…</div>';
    fetchAbsolute(tab.source).then(function (data) {
      var clipList = (data && data.clips) || [];
      containerEl.innerHTML = '';
      if (!clipList.length) {
        var empty = document.createElement('div');
        empty.className = 'ap-empty';
        empty.textContent = 'No clips yet — rip a segment first.';
        containerEl.appendChild(empty);
        return;
      }
      var list = document.createElement('div');
      list.className = 'ap-clips-list';
      clipList.forEach(function (clip) {
        var row = document.createElement('div');
        row.className = 'ap-row';
        var top = document.createElement('div');
        top.className = 'ap-row-top';
        var lbl = document.createElement('span');
        lbl.className = 'ap-row-label';
        lbl.textContent = clip.label || clip.id;
        top.appendChild(lbl);
        row.appendChild(top);
        var audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = clip.url;
        audio.addEventListener('click', function (ev) { ev.stopPropagation(); });
        row.appendChild(audio);
        if (typeof tab.onSelect === 'function') {
          row.style.cursor = 'pointer';
          row.addEventListener('click', function () {
            try { tab.onSelect(clip); } catch (e) {}
          });
        }
        list.appendChild(row);
      });
      containerEl.appendChild(list);
    }).catch(function (e) {
      containerEl.innerHTML = '<div class="ap-error">Could not load clips: ' + esc(e.message) + '</div>';
    });
  }

  // ---- clipboard component ----

  function buildClipboardComponent(tab, containerEl) {
    // Per-component state (closure per mount — survives tab switches while panel lives)
    var cbClips = [];         // current clipboard rows (clip objects)
    var savedIds = {};        // id -> true once promoted

    var base = cfg.base;

    function cbApi(path, opts) {
      opts = opts || {};
      opts.credentials = creds();
      return fetch(base + path, opts).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.status === 204 ? {} : r.json();
      });
    }

    function loadClips() {
      return cbApi('/api/list').then(function (data) {
        cbClips = (data && data.clips) || [];
        render();
      }).catch(function (e) {
        containerEl.innerHTML = '<div class="ap-error">Could not load clipboard: ' + esc(e.message) + '</div>';
      });
    }

    function render() {
      var addBarEl = containerEl.querySelector('.ap-cb-addbar');
      containerEl.innerHTML = '';
      // ADD bar
      var addBar = document.createElement('div');
      addBar.className = 'ap-cb-addbar';
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'ap-btn ap-cb-add-btn';
      addBtn.textContent = '+ Add';
      addBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openAddMenu(addBtn);
      });
      addBar.appendChild(addBtn);
      containerEl.appendChild(addBar);

      if (!cbClips.length) {
        var empty = document.createElement('div');
        empty.className = 'ap-empty';
        empty.textContent = 'Clipboard is empty — use Add to bring in clips.';
        containerEl.appendChild(empty);
        return;
      }

      var list = document.createElement('div');
      list.className = 'ap-clips-list';

      cbClips.forEach(function (clip) {
        var isSaved = !!savedIds[clip.id];
        var row = document.createElement('div');
        row.className = 'ap-row ap-cb-row';
        row.dataset.id = clip.id;

        var top = document.createElement('div');
        top.className = 'ap-row-top';
        var lbl = document.createElement('span');
        lbl.className = 'ap-row-label';
        lbl.textContent = clip.label || clip.filename || ('clip ' + clip.id);
        var dur = document.createElement('span');
        dur.className = 'ap-row-dur';
        dur.textContent = fmtDur(clip.duration_s);
        top.appendChild(lbl);
        top.appendChild(dur);
        row.appendChild(top);

        var audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        if (isCrossOrigin()) audio.crossOrigin = 'anonymous';
        audio.src = base + '/api/clip/' + encodeURIComponent(clip.id);
        audio.addEventListener('click', function (ev) { ev.stopPropagation(); });
        row.appendChild(audio);

        var controls = document.createElement('div');
        controls.className = 'ap-cb-controls';

        var saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'ap-btn ap-cb-save' + (isSaved ? ' ap-cb-saved' : '');
        saveBtn.textContent = 'Save';
        saveBtn.disabled = isSaved;
        saveBtn.title = isSaved ? 'Already saved to library' : 'Save to asset library';

        var actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        if (isSaved) {
          actionBtn.className = 'ap-btn ap-cb-x';
          actionBtn.textContent = '✕';
          actionBtn.title = 'Remove from clipboard (already saved)';
        } else {
          actionBtn.className = 'ap-btn ap-cb-trash';
          actionBtn.textContent = '🗑';
          actionBtn.title = 'Move to recycle bin (48h)';
        }

        saveBtn.addEventListener('click', function () {
          saveBtn.disabled = true;
          saveBtn.textContent = '…';
          cbApi('/api/assets/' + encodeURIComponent(clip.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promote: { subdir: 'audio/samples', name: clip.label || clip.filename, subtype: 'clip' } })
          }).then(function () {
            savedIds[clip.id] = true;
            // flip row in-place: disable save, swap trash->X
            saveBtn.textContent = 'Save';
            saveBtn.classList.add('ap-cb-saved');
            actionBtn.className = 'ap-btn ap-cb-x';
            actionBtn.textContent = '✕';
            actionBtn.title = 'Remove from clipboard (already saved)';
            // rebind action button
            var newBtn = actionBtn.cloneNode(true);
            newBtn.addEventListener('click', function () { removeRow(clip.id); });
            actionBtn.parentNode.replaceChild(newBtn, actionBtn);
          }).catch(function (e) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
            var err = document.createElement('div');
            err.className = 'ap-error';
            err.textContent = 'Save failed: ' + e.message;
            containerEl.insertBefore(err, containerEl.firstChild);
            setTimeout(function () { if (err.parentNode) err.parentNode.removeChild(err); }, 5000);
          });
        });

        actionBtn.addEventListener('click', function () {
          if (savedIds[clip.id]) {
            removeRow(clip.id);
          } else {
            cbApi('/api/clip/' + encodeURIComponent(clip.id) + '/trash', { method: 'POST' })
              .then(function () { removeRow(clip.id); })
              .catch(function (e) {
                var err = document.createElement('div');
                err.className = 'ap-error';
                err.textContent = 'Trash failed: ' + e.message;
                containerEl.insertBefore(err, containerEl.firstChild);
                setTimeout(function () { if (err.parentNode) err.parentNode.removeChild(err); }, 4000);
              });
          }
        });

        controls.appendChild(saveBtn);
        controls.appendChild(actionBtn);
        row.appendChild(controls);
        list.appendChild(row);
      });

      containerEl.appendChild(list);
    }

    function removeRow(id) {
      cbClips = cbClips.filter(function (c) { return c.id !== id; });
      delete savedIds[id];
      var row = containerEl.querySelector('.ap-cb-row[data-id="' + id + '"]');
      if (row) {
        row.style.opacity = '0';
        row.style.transition = 'opacity .15s';
        setTimeout(function () { if (row.parentNode) row.parentNode.removeChild(row); }, 160);
      }
    }

    // Hidden file input for hard-drive upload
    var hdInput = document.createElement('input');
    hdInput.type = 'file';
    hdInput.accept = cfg.accept;
    hdInput.multiple = true;
    hdInput.style.display = 'none';
    document.body.appendChild(hdInput);
    hdInput.addEventListener('change', function () {
      if (!hdInput.files || !hdInput.files.length) return;
      var files = Array.prototype.slice.call(hdInput.files);
      hdInput.value = '';
      var done = 0, total = files.length;
      files.forEach(function (f) {
        var fd = new FormData();
        fd.append('file', f, f.name);
        cbApi('/api/upload', { method: 'POST', body: fd })
          .then(function () { done++; if (done === total) loadClips(); })
          .catch(function () { done++; if (done === total) loadClips(); });
      });
    });

    // Tool modal overlay
    var modalOverlay = null;
    function openToolModal(toolCfg) {
      if (modalOverlay) return;
      modalOverlay = document.createElement('div');
      modalOverlay.className = 'ap-tool-modal-overlay';
      var modalBox = document.createElement('div');
      modalBox.className = 'ap-tool-modal-box';
      var modalHeader = document.createElement('div');
      modalHeader.className = 'ap-tool-modal-header';
      var modalTitle = document.createElement('span');
      modalTitle.textContent = toolCfg.name || 'Tool';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ap-btn ap-tool-modal-close';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', function () { closeToolModal(); });
      modalHeader.appendChild(modalTitle);
      modalHeader.appendChild(closeBtn);
      var iframe = document.createElement('iframe');
      iframe.className = 'ap-tool-modal-iframe';
      iframe.src = toolCfg.url;
      iframe.allow = 'autoplay; microphone';
      modalBox.appendChild(modalHeader);
      modalBox.appendChild(iframe);
      modalOverlay.appendChild(modalBox);
      document.body.appendChild(modalOverlay);
      // ESC closes
      function onEsc(ev) { if (ev.key === 'Escape') { closeToolModal(); document.removeEventListener('keydown', onEsc, true); } }
      document.addEventListener('keydown', onEsc, true);
      modalOverlay.addEventListener('click', function (ev) { if (ev.target === modalOverlay) closeToolModal(); });
    }
    function closeToolModal() {
      if (modalOverlay && modalOverlay.parentNode) modalOverlay.parentNode.removeChild(modalOverlay);
      modalOverlay = null;
      // After tool closes, refresh clipboard in case tool added clips
      loadClips();
    }

    // Recycle bin panel (inline, appears above list)
    function openRecycleBin() {
      var existing = containerEl.querySelector('.ap-recycle-panel');
      if (existing) { existing.parentNode.removeChild(existing); return; }
      var panel = document.createElement('div');
      panel.className = 'ap-recycle-panel';
      var hdr = document.createElement('div');
      hdr.className = 'ap-recycle-header';
      hdr.textContent = 'Recycle Bin (48h)';
      var closeX = document.createElement('button');
      closeX.type = 'button';
      closeX.className = 'ap-btn ap-recycle-close';
      closeX.textContent = '✕';
      closeX.addEventListener('click', function () { if (panel.parentNode) panel.parentNode.removeChild(panel); });
      hdr.appendChild(closeX);
      panel.appendChild(hdr);
      var body = document.createElement('div');
      body.className = 'ap-recycle-body';
      body.textContent = 'Loading…';
      panel.appendChild(body);
      // insert before list or at top
      var list = containerEl.querySelector('.ap-clips-list');
      containerEl.insertBefore(panel, list || null);

      cbApi('/api/recycle').then(function (data) {
        var trashed = (data && data.clips) || [];
        body.innerHTML = '';
        if (!trashed.length) {
          body.innerHTML = '<div class="ap-empty">Recycle bin is empty.</div>';
          return;
        }
        trashed.forEach(function (clip) {
          var rrow = document.createElement('div');
          rrow.className = 'ap-recycle-row';
          var rlbl = document.createElement('span');
          rlbl.className = 'ap-row-label';
          rlbl.textContent = clip.label || clip.filename || clip.id;
          var reviveBtn = document.createElement('button');
          reviveBtn.type = 'button';
          reviveBtn.className = 'ap-btn ap-recycle-revive';
          reviveBtn.textContent = 'Revive';
          reviveBtn.addEventListener('click', function () {
            reviveBtn.disabled = true;
            cbApi('/api/clip/' + encodeURIComponent(clip.id) + '/revive', { method: 'POST' })
              .then(function () {
                if (panel.parentNode) panel.parentNode.removeChild(panel);
                loadClips();
              }).catch(function (e) {
                reviveBtn.disabled = false;
                reviveBtn.textContent = '!err';
              });
          });
          // Permanent delete — overrides the 48h auto-cleanup. The ONLY user-facing
          // permanent delete in the whole flow (scratchpad has no permanent delete).
          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'ap-btn ap-recycle-delete';
          delBtn.title = 'Permanently delete now';
          delBtn.textContent = '🗑';
          delBtn.addEventListener('click', function () {
            if (!window.confirm('This will permanently delete the asset. Are you sure?')) return;
            delBtn.disabled = true; reviveBtn.disabled = true;
            cbApi('/api/clip/' + encodeURIComponent(clip.id), { method: 'DELETE' })
              .then(function () {
                if (rrow.parentNode) rrow.parentNode.removeChild(rrow);
                if (!body.querySelector('.ap-recycle-row')) {
                  body.innerHTML = '<div class="ap-empty">Recycle bin is empty.</div>';
                }
              }).catch(function (e) {
                delBtn.disabled = false; reviveBtn.disabled = false;
                delBtn.textContent = '!err';
              });
          });
          rrow.appendChild(rlbl);
          rrow.appendChild(reviveBtn);
          rrow.appendChild(delBtn);
          body.appendChild(rrow);
        });
      }).catch(function (e) {
        body.innerHTML = '<div class="ap-error">Could not load recycle bin: ' + esc(e.message) + '</div>';
      });
    }

    // Existing-clip browser: fetch curated (transient=0), let user copy to clipboard.
    // NOTE: "copy into clipboard" would require a backend dup endpoint (not yet built).
    // For now, we LIST curated assets and mark this seam clearly for a later task.
    function openExistingClipBrowser() {
      var existing = containerEl.querySelector('.ap-existclip-panel');
      if (existing) { existing.parentNode.removeChild(existing); return; }
      var panel = document.createElement('div');
      panel.className = 'ap-existclip-panel';
      var hdr = document.createElement('div');
      panel.className = 'ap-recycle-panel ap-existclip-panel'; // reuse styles
      var hdr2 = document.createElement('div');
      hdr2.className = 'ap-recycle-header';
      hdr2.textContent = 'Library Clips';
      var closeX = document.createElement('button');
      closeX.type = 'button';
      closeX.className = 'ap-btn ap-recycle-close';
      closeX.textContent = '✕';
      closeX.addEventListener('click', function () { if (panel.parentNode) panel.parentNode.removeChild(panel); });
      hdr2.appendChild(closeX);
      panel.appendChild(hdr2);
      var note = document.createElement('div');
      note.className = 'ap-empty';
      note.style.fontSize = '11px';
      note.textContent = '⚠ Copy-into-clipboard is a future task — listing only for now.';
      panel.appendChild(note);
      var body = document.createElement('div');
      body.className = 'ap-recycle-body';
      body.textContent = 'Loading…';
      panel.appendChild(body);
      var list = containerEl.querySelector('.ap-clips-list');
      containerEl.insertBefore(panel, list || null);

      cbApi('/api/assets?transient=0').then(function (data) {
        var assets = (data && data.assets) || [];
        body.innerHTML = '';
        if (!assets.length) { body.innerHTML = '<div class="ap-empty">No library clips yet.</div>'; return; }
        assets.forEach(function (a) {
          var rrow = document.createElement('div');
          rrow.className = 'ap-recycle-row';
          var rlbl = document.createElement('span');
          rlbl.className = 'ap-row-label';
          rlbl.textContent = a.label || a.filename || a.id;
          rrow.appendChild(rlbl);
          body.appendChild(rrow);
        });
      }).catch(function (e) {
        body.innerHTML = '<div class="ap-error">Could not load: ' + esc(e.message) + '</div>';
      });
    }

    // Add menu
    var addMenuEl = null;
    function closeAddMenu() {
      if (addMenuEl && addMenuEl.parentNode) addMenuEl.parentNode.removeChild(addMenuEl);
      addMenuEl = null;
      document.removeEventListener('click', onAddMenuClose, true);
    }
    function onAddMenuClose(ev) { if (addMenuEl && !addMenuEl.contains(ev.target)) closeAddMenu(); }

    function openAddMenu(anchorEl) {
      closeAddMenu();
      addMenuEl = document.createElement('div');
      addMenuEl.className = 'ap-menu ap-cb-add-menu';

      var tools = tab.tools || [];
      var items = [
        { icon: '💾', label: 'Hard drive', action: function () { closeAddMenu(); hdInput.click(); } },
        { icon: '🔧', label: 'Tool' + (tools.length === 1 ? ': ' + tools[0].name : ''), action: function () {
          closeAddMenu();
          if (!tools.length) return;
          openToolModal(tools[0]); // TODO: multi-tool submenu when tools.length > 1
        }, disabled: tools.length === 0 },
        { icon: '🗑', label: 'Recycle bin', action: function () { closeAddMenu(); openRecycleBin(); } },
        { icon: '📁', label: 'Existing clip', action: function () { closeAddMenu(); openExistingClipBrowser(); } },
        { icon: '🔗', label: 'URL', action: null, disabled: true, soon: true },
      ];

      items.forEach(function (item) {
        var mi = document.createElement('div');
        mi.className = 'ap-menu-item' + (item.disabled ? ' ap-menu-item-disabled' : '');
        mi.textContent = item.icon + ' ' + item.label + (item.soon ? ' (coming soon)' : '');
        if (item.soon) mi.title = 'Not yet implemented';
        if (!item.disabled && item.action) {
          mi.addEventListener('click', function () { item.action(); });
        }
        addMenuEl.appendChild(mi);
      });

      document.body.appendChild(addMenuEl);
      var rect = anchorEl.getBoundingClientRect();
      addMenuEl.style.left = rect.left + 'px';
      addMenuEl.style.top = (rect.bottom + 4) + 'px';
      setTimeout(function () {
        document.addEventListener('click', onAddMenuClose, true);
      }, 0);
    }

    // Initial load
    loadClips();

    // Return a refresh function so refreshConfiguredTab can call it
    containerEl._cbRefresh = loadClips;
  }

  function renderConfiguredTab(idx) {
    var tab = configuredTabs[idx];
    if (!tab) return;
    var views = rootEl.querySelectorAll('.ap-cfg-view');
    Array.prototype.forEach.call(views, function (v, i) {
      v.style.display = (i === idx) ? '' : 'none';
    });
    // Update tab button active state
    var tabBtns = rootEl.querySelectorAll('.ap-tabs .ap-tab');
    Array.prototype.forEach.call(tabBtns, function (b, i) {
      b.classList.toggle('ap-tab-active', i === idx);
    });
    // Lazy-render: only render if not yet populated
    var view = views[idx];
    if (view && view.dataset.rendered) return;
    if (view) {
      view.dataset.rendered = '1';
      if (tab.component === 'url-history') {
        buildUrlHistoryComponent(tab, view);
      } else if (tab.component === 'exported-clips') {
        buildExportedClipsComponent(tab, view);
      } else if (tab.component === 'clipboard') {
        buildClipboardComponent(tab, view);
      }
    }
  }

  function refreshConfiguredTab(idx) {
    var tab = configuredTabs[idx];
    if (!tab) return;
    var views = rootEl.querySelectorAll('.ap-cfg-view');
    var view = views[idx];
    if (!view) return;
    delete view.dataset.rendered;
    if (tab.component === 'url-history') {
      buildUrlHistoryComponent(tab, view);
    } else if (tab.component === 'exported-clips') {
      buildExportedClipsComponent(tab, view);
    } else if (tab.component === 'clipboard') {
      if (typeof view._cbRefresh === 'function') { view._cbRefresh(); }
      else { delete view.dataset.rendered; renderConfiguredTab(idx); return; }
    }
    view.dataset.rendered = '1';
  }

  // ---- panel construction ----

  function buildPanel() {
    rootEl = document.createElement('aside');
    rootEl.className = 'ap-panel';

    // Header: title + refresh.
    var header = document.createElement('div');
    header.className = 'ap-header';
    var title = document.createElement('span');
    title.className = 'ap-title';
    title.textContent = cfg.title;
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'ap-btn ap-icon-btn';
    refreshBtn.type = 'button';
    refreshBtn.title = 'Refresh';
    refreshBtn.textContent = '⟳';
    refreshBtn.addEventListener('click', function () { refresh(); });
    header.appendChild(title);
    header.appendChild(refreshBtn);

    rootEl.appendChild(header);

    if (tabMode) {
      // ---- Configured-tabs mode ----
      var tabBar = document.createElement('div');
      tabBar.className = 'ap-tabs';

      configuredTabs.forEach(function (tab, idx) {
        var btn = document.createElement('button');
        btn.className = 'ap-tab' + (idx === 0 ? ' ap-tab-active' : '');
        btn.type = 'button';
        btn.textContent = tab.label;
        btn.addEventListener('click', (function (i) {
          return function () { activeConfigTab = i; renderConfiguredTab(i); };
        })(idx));
        tabBar.appendChild(btn);
      });
      rootEl.appendChild(tabBar);

      configuredTabs.forEach(function () {
        var view = document.createElement('div');
        view.className = 'ap-cfg-view ap-view';
        view.style.display = 'none';
        rootEl.appendChild(view);
      });

      // Render first tab immediately
      activeConfigTab = 0;
      renderConfiguredTab(0);

    } else {
      // ---- Legacy mode: Picker + Compare tabs ----
      var tabs = document.createElement('div');
      tabs.className = 'ap-tabs';
      var tabPick = document.createElement('button');
      tabPick.className = 'ap-tab ap-tab-active'; tabPick.type = 'button'; tabPick.textContent = 'Picker';
      var tabCmp = document.createElement('button');
      tabCmp.className = 'ap-tab'; tabCmp.type = 'button'; tabCmp.textContent = 'Compare';
      tabs.appendChild(tabPick); tabs.appendChild(tabCmp);
      tabPick.addEventListener('click', function () { setTab('picker'); });
      tabCmp.addEventListener('click', function () { setTab('compare'); });
      cmpTabBtns = { picker: tabPick, compare: tabCmp };

      // Drop zone + browse.
      var drop = document.createElement('div');
      drop.className = 'ap-drop';
      drop.innerHTML = '<strong>Drop a file</strong> or click to browse' +
        '<span class="ap-drop-sub">' + esc(cfg.accept.replace(/\./g, ' ').trim()) + '</span>';

      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = cfg.accept;
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', function () {
        uploadFiles(fileInput.files);
        fileInput.value = '';   // allow re-selecting the same file
      });

      drop.addEventListener('click', function () { fileInput.click(); });
      drop.addEventListener('dragover', function (ev) {
        ev.preventDefault(); drop.classList.add('ap-dragover');
      });
      drop.addEventListener('dragleave', function () { drop.classList.remove('ap-dragover'); });
      drop.addEventListener('drop', function (ev) {
        ev.preventDefault();
        drop.classList.remove('ap-dragover');
        uploadFiles(ev.dataTransfer && ev.dataTransfer.files);
      });

      busyEl = document.createElement('div');
      busyEl.className = 'ap-busy';
      busyEl.style.display = 'none';

      listEl = document.createElement('div');
      listEl.className = 'ap-list';

      // Picker view = drop + list (existing). Compare view = A/B transport + compare list.
      pickView = document.createElement('div');
      pickView.className = 'ap-view';
      pickView.appendChild(drop);
      pickView.appendChild(fileInput);
      pickView.appendChild(busyEl);
      pickView.appendChild(listEl);

      cmpView = buildCompareView();
      cmpView.style.display = 'none';

      rootEl.appendChild(tabs);
      rootEl.appendChild(pickView);
      rootEl.appendChild(cmpView);
    }

    document.body.appendChild(rootEl);

    // Mobile drawer toggle.
    toggleEl = document.createElement('button');
    toggleEl.className = 'ap-toggle';
    toggleEl.type = 'button';
    toggleEl.textContent = '☰ Assets';
    toggleEl.addEventListener('click', function () { rootEl.classList.toggle('ap-open'); });
    document.body.appendChild(toggleEl);
  }

  // ---- public API ----

  function refresh() {
    if (!cfg) return Promise.resolve();
    if (tabMode) {
      // Refresh the currently active configured tab
      refreshConfiguredTab(activeConfigTab);
      return Promise.resolve();
    }
    return api('/api/list', {})
      .then(function (data) {
        clips = (data && data.clips) || [];
        // Drop selection if the selected clip no longer exists.
        if (selectedId != null && !findClip(selectedId)) { selectedId = null; fireSelect(); }
        // Drop compare slots whose clip vanished.
        if (cmpA && !findClip(cmpA.id)) cmpA = null;
        if (cmpB && !findClip(cmpB.id)) cmpB = null;
        renderList(null);
        if (activeTab === 'compare') renderCompare();
      })
      .catch(function (e) { clips = []; renderList(e); });
  }

  function selectById(id) {
    if (findClip(id)) select(id);
    else clearSelection();
  }

  function unmount() {
    closeMenu();
    clearAudio();
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    if (toggleEl && toggleEl.parentNode) toggleEl.parentNode.removeChild(toggleEl);
    rootEl = toggleEl = listEl = busyEl = fileInput = null;
    clips = []; selectedId = null;
    tabMode = false; configuredTabs = []; activeConfigTab = 0;
  }

  function mount(opts) {
    opts = opts || {};
    if (rootEl) unmount();   // idempotent remount
    cfg = {
      base: (opts.base || '/asset-management/library').replace(/\/+$/, ''),
      onSelect: opts.onSelect || null,
      title: opts.title || 'Asset Clipboard',
      accept: opts.accept || '.mp3,.m4a,.wav,.ogg,.flac,.aac'
    };
    // Configured-tabs mode: if tabs[] provided, skip legacy picker/compare UI
    if (opts.tabs && opts.tabs.length) {
      tabMode = true;
      configuredTabs = opts.tabs.map(function (t) {
        return {
          label: t.label || t.component,
          component: t.component,
          source: t.source || '',
          onSelect: t.onSelect || null,
          tools: t.tools || []
        };
      });
    } else {
      tabMode = false;
      configuredTabs = [];
    }
    ensureStylesheet();
    buildPanel();
    if (!tabMode) refresh();
    return AP;
  }

  var AP = {
    mount: mount,
    refresh: refresh,
    getSelected: getSelected,
    selectById: selectById,
    unmount: unmount
  };
  window.AssetPicker = AP;
})();
