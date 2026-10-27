/* The "Title bar" tone swatches (hub V2, Owner 2026-10-05), shared by the Global
 * color palette group (the summary list) and each app's card under Apps.
 * One row of the five identity tones, 24px; the current one is pressed. Picking
 * the app's default clears the override (null) rather than storing it, so a
 * later change of the default still reaches a person who never chose. */
import { TONES, defaultTone, toneKey, toneFor } from '/app-tones.mjs';

/** @param {{slug?:string, app_slug?:string, key?:string, name?:string, title?:string}} app
 *  @param {object} me   the shared /api/rooms/me object (reads me.tones)
 *  @param {(patch:object)=>Promise} save
 *  @param {(msg:string)=>void} say   shows an error beside the control
 *  @param {()=>void} [done]          called after every pick, saved or not */
export function toneSwatches(app, me, save, say, done) {
  const key = app.key || toneKey(app);
  const probe = app.key ? { app_slug: app.key } : app;
  const wrap = document.createElement('span');
  wrap.className = 'tb-sw';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', `${app.name || app.title || key} title bar tone`);
  const paint = () => {
    const cur = toneFor(probe, me.tones);
    for (const b of wrap.children) {
      b.setAttribute('aria-pressed', String(b.dataset.tone === cur));
    }
  };
  for (const t of TONES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tone = t;
    b.title = t;
    b.setAttribute('aria-label', t);
    b.style.setProperty('--c', `var(--id-${t})`);
    b.addEventListener('click', async () => {
      const next = t === defaultTone(probe) ? null : t;
      try {
        say('');
        await save({ tones: { [key]: next } });
      } catch (e) {
        say(e?.message ?? String(e));
      }
      paint();
      done?.();
    });
    wrap.append(b);
  }
  paint();
  wrap.repaint = paint;
  return wrap;
}
