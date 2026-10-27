/* THE USAGE METER, titlebar half (ticket, Owner 2026-10-09). The engine (src/engine/usage-meter.ts)
 * validates what the agent-usage probes publish and serves it at GET /api/usage; this module only
 * turns one service's view into a line and a tooltip, and keeps it fresh.
 *
 * Rules (Owner [ref]): percent only (the CLIs report no token counts); always the 5-hour and the weekly
 * window; credits ONLY when the plan is used up; an old number is never shown as current (dimmed, with
 * its age, past 25 min); a login that expired says "login needed"; no data says "-"; a service with no
 * reading yet is greyed. Pure functions + one mount so a node test can ask the questions. */

/** The installation's full PC-stats page (Owner 2026-10-09): the titlebar line is the glance, this is the detail. */
export const MONITOR_URL = '';
const pct = (n) => (typeof n === 'number' ? `${Math.round(n)}%` : '?');
const CREDITS = { using: 'using credits', unknown: 'credits unknown', blocked: 'blocked' };

export function ageText(min) {
  if (min === null || min === undefined) return '';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** One service -> { text, cls, title }. `cls` is one of ok | stale | warn | absent. */
export function describe(view) {
  const name = view.label;
  if (view.state === 'absent') {
    return { text: `${name} —`, cls: 'absent', title: `${name}: no reading yet` };
  }
  const when = view.capturedAt ? `captured ${new Date(view.capturedAt).toLocaleString()} (${ageText(view.ageMin)} ago)` : '';
  if (view.state === 'auth_required') {
    return { text: `${name} · login needed`, cls: 'warn', title: `${name}: its login expired, so usage cannot be read. ${when}` };
  }
  if (view.state === 'error') {
    return { text: `${name} —`, cls: 'warn', title: `${name}: no usable reading. ${when}${lastGoodLine(view)}` };
  }
  let text = view.hasFiveHour === false ? `${name} wk ${pct(view.weekly)}` : `${name} 5h ${pct(view.fiveHour)} · wk ${pct(view.weekly)}`;
  if (view.credits) text += ` · ${CREDITS[view.credits]}`;
  if (view.state === 'stale') text += ` · ${ageText(view.ageMin)} ago`;
  const lines = view.windows.map((w) => `${w.label}: ${pct(w.usedPct)} used${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : ''}`);
  lines.push(when);
  if (view.state === 'stale') lines.push('Older than 25 minutes: the numbers may have moved.');
  return { text, cls: view.state === 'stale' ? 'stale' : 'ok', title: lines.join('\n') };
}

function lastGoodLine(view) {
  if (!view.lastGood) return '';
  const w = view.lastGood.windows.map((x) => `${x.label} ${pct(x.usedPct)}`).join(', ');
  return `\nLast good reading (${new Date(view.lastGood.capturedAt).toLocaleString()}): ${w}`;
}

/** The server line: CPU %, memory used / total, temperature, and the iGPU clock when the publisher has one
 *  (the integrated GPU reports frequency only). Warns on a nearly full memory, a pegged CPU or heat. */
export function describeHardware(h) {
  if (!h || h.state === 'absent') {
    return { text: 'server —', cls: 'absent', title: 'server: no hardware telemetry yet', href: MONITOR_URL };
  }
  const bits = [`cpu ${pct(h.cpuPct)}`];
  bits.push(h.memUsedGb !== null && h.memTotalGb !== null ? `mem ${h.memUsedGb.toFixed(1)}/${h.memTotalGb.toFixed(1)} GB` : `mem ${pct(h.memPct)}`);
  if (h.tempC !== null) bits.push(`${Math.round(h.tempC)}°C`);
  if (h.gpuMhz !== null) bits.push(`gpu ${Math.round(h.gpuMhz)} MHz`);
  const hot = (h.memPct ?? 0) >= 85 || (h.cpuPct ?? 0) >= 90 || (h.tempC ?? 0) >= 90;
  const free = h.memUsedGb !== null && h.memTotalGb !== null ? `\nFree memory: ${(h.memTotalGb - h.memUsedGb).toFixed(1)} GB` : '';
  const load = h.load1 !== null ? `\nLoad (1 min): ${h.load1}` : '';
  const gpu = h.gpuMhz !== null ? `\nIntegrated GPU clock${h.gpuMaxMhz !== null ? ` (max ${Math.round(h.gpuMaxMhz)} MHz)` : ''}; utilisation is not available on this kernel.` : '';
  const stale = h.state === 'stale' ? `\nNo update for ${h.ageSec}s: these numbers are old.` : '';
  return { text: `server ${bits.join(' · ')}`, cls: h.state === 'stale' ? 'stale' : hot ? 'warn' : 'ok', title: `server${free}${load}${gpu}${stale}\nOpen the full server monitor.`, href: MONITOR_URL };
}

/** Paint every service into `el` (one <span> each). Textual only: nothing from the engine is parsed as HTML. */
export function paint(el, snapshot) {
  el.textContent = '';
  for (const d of [...snapshot.services.map(describe), describeHardware(snapshot.hardware)]) {
    const s = document.createElement(d.href ? 'a' : 'span');
    if (d.href) {
      s.href = d.href;
      s.target = '_blank';
      s.rel = 'noopener';
    }
    s.className = `usage-svc ${d.cls}`;
    s.textContent = d.text;
    s.title = d.title;
    el.append(s);
  }
}

/** Fetch on mount, then every 10 s while the page is on screen. A missing endpoint (an older
 *  engine) or a failure leaves the meter empty rather than wrong. */
export function mountUsageMeter(el, { isHidden, onVisibility, intervalMs = 10_000 } = {}) {
  let timer = null;
  const load = async () => {
    try {
      const r = await fetch('/api/usage');
      if (!r.ok) throw new Error(String(r.status));
      paint(el, await r.json());
      el.hidden = false;
    } catch {
      el.hidden = true;
    }
  };
  const tick = () => {
    if (!(isHidden && isHidden())) load();
  };
  load();
  timer = setInterval(tick, intervalMs);
  if (onVisibility) onVisibility((visible) => visible && load());
  return () => clearInterval(timer);
}
