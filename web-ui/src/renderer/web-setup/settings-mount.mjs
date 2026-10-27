import {mountAgentSettings, mountFolderSettings} from './settings-page.mjs';
// Entry included only by the web build's mounts manifest: puts Agents and Folders into the Settings router. The router
// owns each page's show / hide / reset (no watching of DOM visibility); the pages own their contents.

// The four read/write methods come from the settings facade; the folder chooser from the files facade. chooseFolder
// answers {ok,path} or {ok:false,code}: cancelled/changed are a quiet null, any other code is thrown as the code alone.
export function settingsPageApi(web) {
  const api = {...web.settings};
  if (typeof web.recipes?.writeApproval === 'function') {
    api.writeRecipeApproval = (id, patch, options) => web.recipes.writeApproval(id, patch, options);
  }
  if (typeof web.files?.chooseFolder === 'function') {
    api.pickFolder = async options => {
      const result = await web.files.chooseFolder(options);
      if (result?.ok === true) return {path: result.path};
      if (result?.code === 'cancelled' || result?.code === 'changed') return null;
      throw Error(typeof result?.code === 'string' ? result.code : 'unavailable');
    };
  }
  return api;
}

const registered = new WeakSet();
export function registerSettingsPages({web, mounts = {agents: mountAgentSettings, folders: mountFolderSettings}}) {
  const router = web?.router;
  if (!router || !web.settings || registered.has(router)) return;
  registered.add(router);
  const api = () => settingsPageApi(web);
  router.registerPage({id: 'agents', name: 'Agents', label: 'Agents', icon: 'smart_toy', value: 'Auto-approve',
    mount: host => mounts.agents({host, api: api()})});
  router.registerPage({id: 'folders', name: 'Folders', label: 'Folders', icon: 'folder_managed', value: 'Trusted',
    mount: host => mounts.folders({host, api: api()})});
}

if (typeof window !== 'undefined' && window.wb?.web) registerSettingsPages({web: window.wb.web});
