/*
 * One review item, large (GET /rooms/:roomId/review/:n — view.mjs reviewPage): the tool.json
 * `links` target the host opens in its preview column. The PANEL no longer navigates here — its
 * Review tab renders the large view in-frame (view.js), so the host's action port survives. The
 * page is complete without this script (every version and image is a plain link; keys follow
 * those links); this adds:
 *   - the width tier classes (t-<tier> ge-<tier> on <html>, from <html data-tiers>) — the
 *     frame's OWN width: stacked below L, image | note beside from L up
 *   - keys: ← → images, [ ] versions, Esc back to the list;  swipe ← → on the image (axis-locked)
 *   - local times (the server writes UTC)
 *   - "Reply in chat": {panel:'compose', text:'#2 v3: '} to the host, AND a clipboard copy + toast
 *   - {panel:'height'} on every layout change;  host -> app {panel:'focus', ref:'review/2[/v1]'}
 * textContent only; every URL relative.
 */
(function () {
  'use strict';

  var html = document.documentElement;
  var body = document.querySelector('.rv-b');
  var back = document.getElementById('back');
  var toastTimer = null;

  function post(msg) {
    try {
      parent.postMessage(msg, '*');
    } catch (e) {
      /* opened standalone */
    }
  }
  function reportHeight() {
    post({ panel: 'height', px: Math.ceil(document.body.getBoundingClientRect().height) }); // content, not the frame (see view.js)
  }

  /* width tiers — the one table is <html data-tiers="m:360 l:640 xl:1000"> (view.mjs TIERS) */
  var TIERS = (html.getAttribute('data-tiers') || '').split(' ').map(function (p) {
    var kv = p.split(':');
    return [kv[0], Number(kv[1])];
  }).sort(function (a, b) {
    return a[1] - b[1];
  });
  function applyTier() {
    var w = html.clientWidth;
    var tier = 's';
    var cls = [];
    TIERS.forEach(function (t) {
      if (w >= t[1]) {
        tier = t[0];
        cls.push('ge-' + t[0]);
      }
    });
    cls.push('t-' + tier);
    html.className = cls.join(' ');
  }
  applyTier();

  function toast(text) {
    var t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
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
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
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
      return ok;
    }
    var done = function (ok) {
      toast(ok ? 'Copied — paste it in chat' : 'Start your reply with “' + text.trim() + '”');
    };
    try {
      navigator.clipboard.writeText(text).then(function () {
        done(true);
      }, function () {
        done(legacy());
      });
    } catch (e) {
      done(legacy());
    }
  }

  /* local times: "2:14 PM", or "Sep 27, 2:14 PM" when not today */
  var times = document.querySelectorAll('time[datetime]');
  for (var k = 0; k < times.length; k++) {
    var d = new Date(times[k].getAttribute('datetime'));
    if (!isNaN(d)) {
      var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      times[k].textContent = d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
    }
  }

  function goBack() {
    if (back) back.click();
  }

  /* host -> app: open another item (a room line's link, when the frame already shows one) */
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || typeof e.data !== 'object' || e.data.panel !== 'focus') return;
    var m = /^review\/(\d+)(?:\/v(\d+))?$/.exec(String(e.data.ref || ''));
    if (m) location.assign(m[1] + (m[2] ? '?v=' + m[2] : '')); // this page is review/<n>: a sibling
  });

  if (!body) {
    // the 404 page: Esc still goes back
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') goBack();
    });
    reportHeight();
    return;
  }

  var cur = document.getElementById('cur');
  var curImg = document.getElementById('curimg');
  var curId = document.getElementById('curid'); // the id under the picture, with a copy button
  var tiles = Array.prototype.slice.call(document.querySelectorAll('#strip .st'));
  var idx = Math.max(0, tiles.findIndex(function (t) {
    return t.classList.contains('on');
  }));
  var vers = Array.prototype.slice.call(document.querySelectorAll('#vers .ver'));
  var vIdx = vers.findIndex(function (a) {
    return a.classList.contains('on');
  });

  function show(i) {
    if (!tiles.length) return;
    idx = (i + tiles.length) % tiles.length;
    var id = tiles[idx].getAttribute('data-id');
    var file = '../file/' + encodeURIComponent(id);
    cur.setAttribute('href', file);
    curImg.src = file;
    curImg.alt = '#' + body.getAttribute('data-n') + ' image ' + (idx + 1) + ' of ' + tiles.length;
    if (curId) curId.textContent = id;
    tiles.forEach(function (t, k) {
      t.classList.toggle('on', k === idx);
    });
  }
  /* Transparent art (an SVG icon, a cut-out) sits on the dark stage: sample it and, if it is mostly
     transparent, back it with white when its ink is dark, the dark stage when it is light (the user: the
     black hand SVG was invisible). Opaque images keep the stage. Needs the CORS-open file route. */
  function backdrop() {
    cur.style.background = '';
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 48;
      var g = c.getContext('2d');
      g.drawImage(curImg, 0, 0, 48, 48);
      var px = g.getImageData(0, 0, 48, 48).data;
      var clear = 0, lum = 0, ink = 0;
      for (var k = 0; k < px.length; k += 4) {
        if (px[k + 3] < 250) clear++;
        if (px[k + 3] > 128) { ink++; lum += 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]; }
      }
      if (clear > 0.02 * 48 * 48 && ink && lum / ink < 115) cur.style.background = '#f4f4f2';
    } catch (e) {
      /* tainted or not decodable: keep the stage */
    }
  }
  curImg.addEventListener('load', backdrop);
  if (curImg.complete && curImg.naturalWidth) backdrop();
  tiles.forEach(function (t, k) {
    t.addEventListener('click', function (e) {
      e.preventDefault();
      show(k);
    });
  });
  function version(step) {
    var a = vers[vIdx + step];
    if (a) a.click();
  }

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'ArrowRight') show(idx + 1);
    else if (e.key === '[') version(-1);
    else if (e.key === ']') version(1);
    else if (e.key === 'Escape') goBack();
    else return;
    e.preventDefault();
  });

  /* swipe on the image only: lock the axis after 8px; a horizontal swipe of 40px steps */
  var sx = 0, sy = 0, axis = null;
  cur.addEventListener('touchstart', function (e) {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    axis = null;
  }, { passive: true });
  cur.addEventListener('touchmove', function (e) {
    var dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    if (axis === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (axis === 'x') e.preventDefault();
  }, { passive: false });
  cur.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - sx;
    if (axis === 'x' && Math.abs(dx) > 40 && tiles.length > 1) {
      show(dx < 0 ? idx + 1 : idx - 1);
      e.preventDefault(); // not a tap: don't open the file
    }
    axis = null;
  });

  var cpId = document.getElementById('cpid');
  if (cpId) cpId.addEventListener('click', function () {
    copy(curId.textContent);
  });

  var reply = document.getElementById('reply');
  reply.addEventListener('click', function () {
    var text = reply.getAttribute('data-text');
    post({ panel: 'compose', text: text });
    copy(text);
  });

  document.addEventListener('load', function (e) {
    if (e.target && e.target.tagName === 'IMG') reportHeight();
  }, true);
  if (typeof ResizeObserver === 'function') {
    var rsTimer = null;
    new ResizeObserver(function () {
      applyTier();
      clearTimeout(rsTimer);
      rsTimer = setTimeout(reportHeight, 100);
    }).observe(html);
  }
  reportHeight();
})();
