import { TONES, toneFor, defaultTone } from './app-tones.js';

// Only apps present in this build. The upstream pure table also describes future
// tools; that does not make them installed or add extra Settings rows.
export const APPS_IN_BUILD = Object.freeze([
  Object.freeze({ key: 'tasks', name: 'Tasks', icon: 'checklist', app_slug: 'tasks' }),
  Object.freeze({ key: 'assets', name: 'Scratchpad', icon: 'sticky_note_2', app_slug: 'assets' }),
]);
function tonesOf(profile) {
  const raw = profile?.tones;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const app of APPS_IN_BUILD) if (Object.hasOwn(raw, app.key) && TONES.includes(raw[app.key])) out[app.key] = raw[app.key];
  return out;
}

/** Scoped UI state; the engine is the only preference store. No localStorage. */
export function createAppToneSettings({ api, changed = () => {} } = {}) {
  let binding = null, epoch = 0, visible = false, loaded = false, loading = false, loadError = false, disposed = false;
  let overrides = {}, pending = null, errors = {};
  const capture = () => ({ binding, epoch });
  const current = token => {
    if (disposed || !visible || !binding || token.binding !== binding || token.epoch !== epoch) return false;
    try { return binding.current() === true; } catch { return false; }
  };
  const emit = () => { if (!disposed) changed(); };
  function retire(clear) {
    epoch++; visible = false; binding = null; pending = null; loading = false; errors = {};
    if (clear) { loaded = false; loadError = false; overrides = {}; }
  }
  function receive(status) {
    if (!current(capture())) return false;
    const next = tonesOf(status?.me);
    if (!next) { overrides = {}; loaded = false; loadError = true; emit(); return false; }
    overrides = next; loaded = true; loadError = false; emit(); return true;
  }
  const model = {
    state() {
      if (visible && binding && !current(capture())) retire(true);
      return { visible, loaded, loading, loadError, pending,
        canChange: current(capture()) && loaded && !loading && pending === null,
        apps: APPS_IN_BUILD.map(app => {
          const tone = toneFor(app, overrides), inherited = defaultTone(app);
          return { ...app, tone, defaultTone: inherited, changed: tone !== inherited, pending: app.key === pending, error: errors[app.key] === true };
        }), overrides: { ...overrides } };
    },
    async open() {
      if (disposed || visible) return false;
      epoch++; visible = true; loaded = false; loading = true; loadError = false; errors = {}; overrides = {};
      try { binding = api?.bind(); } catch { binding = null; }
      const token = capture();
      if (!current(token) || typeof binding.status !== 'function' || typeof binding.me !== 'function') {
        loading = false; loadError = true; emit(); return false;
      }
      emit();
      try { const status = await binding.status(); if (!current(token)) return false; return receive(status); }
      catch { if (current(token)) { overrides = {}; loaded = false; loadError = true; } return false; }
      finally { if (current(token)) { loading = false; emit(); } }
    },
    close() { retire(false); emit(); },
    accountChanged() { retire(true); emit(); },
    dispose() { retire(true); disposed = true; },
    receive,
    fence() { const token = capture(); return () => current(token); },
    async change(key, tone) {
      const app = APPS_IN_BUILD.find(item => item.key === key);
      if (!app || !TONES.includes(tone) || !model.state().canChange) return false;
      errors = {};
      if (tone === toneFor(app, overrides)) { emit(); return true; }
      const token = capture(), client = binding;
      pending = key; emit();
      try {
        // A default is inheritance, not a durable copy of today's default tone.
        const value = tone === defaultTone(app) ? null : tone;
        const response = await client.me({ tones: { [key]: value } });
        if (!current(token)) return false;
        if (!response?.ok) { errors[key] = true; return false; }
        let next = tonesOf(response.value);
        // Read the shared main-process cache after the reply, so another window's
        // merged per-key update is not overwritten by an older reply snapshot.
        try {
          const status = await client.status(); if (!current(token)) return false;
          next = tonesOf(status?.me) || next;
        } catch { if (!current(token)) return false; }
        if (!next) { errors[key] = true; return false; }
        overrides = next; loaded = true; loadError = false; return true;
      } catch { if (current(token)) errors[key] = true; return false; }
      finally { if (current(token)) { pending = null; emit(); } }
    },
    reset(key) {
      const app = APPS_IN_BUILD.find(item => item.key === key);
      return app ? model.change(key, defaultTone(app)) : Promise.resolve(false);
    },
  };
  return Object.freeze(model);
}
