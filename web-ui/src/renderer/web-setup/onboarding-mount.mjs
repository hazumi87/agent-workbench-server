import {createOnboardingAPI} from './onboarding-api.mjs';
import {mountOnboarding} from './onboarding-page.mjs';
import {serverFolder} from './policy.mjs';

const registered = new WeakSet();
const refuse = () => { throw {code: 'settings-unconfirmed'}; };
// The router owns authenticated admission, the fullscreen host and retries. This
// consumer neither persists a completion hint nor changes the shell's visibility.
export function registerOnboardingGate({web}) {
  const router = web?.router;
  if (!router?.registerGate || !web.settings || registered.has(router)) return;
  router.registerGate({
    id: 'setup',
    async check({signal, current} = {}) {
      const verify = () => { if (signal?.aborted || current?.() === false) refuse(); };
      verify();
      const value = await web.settings.readSetup({signal, current});
      verify();
      if (!value || (value.completedAt !== null && !(Number.isFinite(value.completedAt) && value.completedAt >= 0)) ||
          (value.defaultFolder !== null && !serverFolder(value.defaultFolder))) refuse();
      return value.completedAt === null ? 'show' : 'pass';
    },
    mount(host, {view, signal, done}) {
      const generation = view.generation();
      let alive = true, shown = false;
      const current = () => alive && shown && !signal?.aborted && !view.signal().aborted && view.current(generation);
      const api = createOnboardingAPI({
        settings: web.settings,
        owner: () => ({signedIn: current(), key: `view-${generation}`}),
        async pickFolder(options) {
          if (typeof web.files?.chooseFolder !== 'function') refuse();
          const result = await web.files.chooseFolder(options);
          if (result?.ok === true) return result.path;
          if (result?.code === 'cancelled' || result?.code === 'changed') return null;
          refuse();
        },
        async launchRecipe(id, options) {
          const result = await router.launchRecipe(id, options);
          if (result?.ok !== true) refuse();
          return {opened: true};
        },
      });
      const page = mountOnboarding({host, api, onComplete: () => { if (current()) done(); }});
      return Object.freeze({
        show() { if (!alive || signal?.aborted || !view.current(generation)) return; shown = true; return page.show(); },
        hide() { shown = false; page.hide(); },
        reset() { shown = false; page.reset(); },
        destroy() { alive = false; shown = false; page.destroy(); },
        state: page.state,
      });
    },
  });
  registered.add(router);
}

if (typeof window !== 'undefined' && window.wb?.web) registerOnboardingGate({web: window.wb.web});
