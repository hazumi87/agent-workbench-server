/* ============================================================================
 * AGENTS · CHATTER [chatter] (Owner 2026-10-06: "analyze with data to determine
 * it's happening, and then act either directly or through rules changes").
 * Mounted by web/settings.mjs like the other groups. Reads GET /api/chatter
 * (the engine's report) and writes PUT /api/chatter/quiet (a person's window
 * only; the cookie rides along).
 *
 *   Quiet agents   an agent marked quiet gets no direct messages from other
 *                  agents; only the person reaches it
 *   Last 24 hours  what crossed a threshold, with an example line each
 *   Message shape  per room, agent lines by label + must-deliver [shape]
 * ========================================================================== */

const RULE_WORDS = {
  ack_only: 'acknowledgement-only lines',
  lead_echo: "lead repeating a worker",
  dm_budget: 'over the direct-message budget',
  dm_repeat: 'repeated direct messages',
};

/** A finding as one readable line: what, where, how much against the limit. */
export function findingLine(f) {
  /* [agent comms] a rule's own count: what it stopped (enforce) or would have stopped (watch) */
  if (f.kind === 'refused' || f.kind === 'watched') {
    const rule = RULE_WORDS[f.examples?.[0]] ?? f.examples?.[0] ?? 'a rule';
    return `@${f.seat}: ${f.kind === 'refused' ? 'stopped' : 'would have stopped'} ${f.value} (${rule})`;
  }
  const where = f.room?.name ?? f.seat ?? f.pane ?? '';
  const who = f.seat && f.room ? ` · @${f.seat}` : '';
  const what = {
    to_person_ratio: 'lines to you per line from you',
    xpost: 'cross-post copies',
    echo: "lead re-tellings of a worker's line",
    repeat: 'repeated lines',
    dm_rate: 'direct messages in one hour',
  }[f.kind] ?? f.kind;
  return `${where}${who}: ${f.value} ${what} (limit ${f.threshold})`;
}

/** [shape] The columns of the shape table, in order (engine/chatter.ts SHAPE_LABELS). */
export const SHAPE_COLS = ['action', 'reply', 'control', 'ack', 'status', 'relay', 'blast'];

/** [shape] One row per room: its name, the count per label, must-deliver, total. */
export function shapeRows(report) {
  return (report?.shape?.rooms ?? []).map((r) => ({
    name: r.name ?? r.room_id,
    counts: SHAPE_COLS.map((k) => r[k] ?? 0),
    mustDeliver: r.must_deliver ?? 0,
    total: r.total ?? 0,
  }));
}

/** Slugs to offer for quieting: agents that received direct messages, minus those already quiet. */
export function quietCandidates(report) {
  const quiet = new Set(report?.quiet ?? []);
  return [...new Set((report?.panes ?? []).map((p) => p.slug).filter(Boolean))].filter((s) => !quiet.has(s));
}

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

function ensureStyles() {
  if (document.querySelector('link[data-chs]')) {
    return;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/settings-chatter.css';
  l.dataset.chs = '1';
  document.head.append(l);
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((j && j.error) || `HTTP ${res.status}`);
  }
  return j;
}

/**
 * @param {HTMLElement} el
 */
export async function mountChatterSettings(el) {
  ensureStyles();
  const g = mk('section', 'chs');
  g.setAttribute('aria-label', 'Agents chatter');
  el.textContent = '';
  el.append(g);
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');

  async function paint() {
    let r;
    try {
      r = await call('GET', '/api/chatter?hours=24');
    } catch (e) {
      g.textContent = '';
      g.append(mk('p', 'pv-msg', `Could not read the report: ${e?.message ?? e}`));
      return;
    }
    g.textContent = '';
    g.append(mk('h3', 'chs-h', 'Quiet agents'));
    g.append(mk('p', 'pv-note', 'A quiet agent gets no direct messages from other agents. Only you reach it. The sender is told why.'));
    const list = mk('ul', 'chs-list');
    for (const slug of r.quiet ?? []) {
      const li = mk('li', 'chs-item');
      const off = mk('button', 'pv-btn', 'Unquiet');
      off.type = 'button';
      off.addEventListener('click', () => setQuiet(slug, false));
      const refused = r.refusals?.[slug] ?? 0;
      li.append(mk('span', 'chs-slug', `@${slug}`), mk('span', 'pv-note chs-n', refused ? `${refused} refused` : ''), off);
      list.append(li);
    }
    if (!(r.quiet ?? []).length) {
      list.append(mk('li', 'pv-note', 'None.'));
    }
    g.append(list);
    const row = mk('div', 'chs-row');
    const inp = mk('input', 'pv-in chs-in');
    inp.placeholder = 'agent slug, e.g. video-to-3d';
    inp.setAttribute('list', 'chsCands');
    const dl = mk('datalist');
    dl.id = 'chsCands';
    for (const s of quietCandidates(r)) {
      const o = mk('option');
      o.value = s;
      dl.append(o);
    }
    const add = mk('button', 'pv-btn pri', 'Mark quiet');
    add.type = 'button';
    add.addEventListener('click', () => inp.value.trim() && setQuiet(inp.value.trim(), true));
    row.append(inp, dl, add);
    g.append(row, msg);

    g.append(mk('h3', 'chs-h', 'Last 24 hours'));
    const fs = r.findings ?? [];
    if (!fs.length) {
      g.append(mk('p', 'pv-note', 'Nothing crossed a limit.'));
    }
    const fl = mk('ul', 'chs-list');
    for (const f of fs) {
      const li = mk('li', 'chs-find');
      li.append(mk('span', '', findingLine(f)));
      const ex = f.examples?.[0];
      if (ex?.text) {
        li.append(mk('small', 'pv-note chs-ex', ex.line ? `#${ex.line} ${ex.text}` : ex.text));
      }
      fl.append(li);
    }
    g.append(fl);

    /* [shape] what kind of messages agents send, per room (report only; nothing is held) */
    g.append(mk('h3', 'chs-h', 'Message shape, last 24 hours'));
    g.append(mk('p', 'pv-note', 'Each agent line sorted by what it is. "Must" = lines that had to reach someone (a stop, your words, a question, a finished dependency).'));
    const rows = shapeRows(r);
    if (!rows.length) {
      g.append(mk('p', 'pv-note', 'No agent lines in this window.'));
    } else {
      const wrap = mk('div', 'chs-shape');
      const t = mk('table', 'chs-tbl');
      const hr = mk('tr');
      for (const h of ['Room', ...SHAPE_COLS, 'must']) hr.append(mk('th', '', h));
      t.append(hr);
      for (const row of rows) {
        const tr = mk('tr');
        tr.append(mk('td', 'chs-room', row.name));
        for (const n of row.counts) tr.append(mk('td', 'chs-num', n ? String(n) : '·'));
        tr.append(mk('td', 'chs-num', String(row.mustDeliver)));
        t.append(tr);
      }
      wrap.append(t);
      g.append(wrap);
    }
  }

  async function setQuiet(slug, quiet) {
    try {
      msg.textContent = 'Saving…';
      msg.dataset.kind = '';
      await call('PUT', '/api/chatter/quiet', { slug, quiet });
      await paint();
      msg.textContent = quiet ? `@${slug} is quiet` : `@${slug} is no longer quiet`;
    } catch (e) {
      msg.textContent = `Not saved: ${e?.message ?? e}`;
      msg.dataset.kind = 'error';
    }
  }

  await paint();
  return {};
}
