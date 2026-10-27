import policy from '../../recipe-import.js';

const error = code => Object.assign(new Error(code), {code});
const clone = value => JSON.parse(JSON.stringify(value));

// The browser reads the pack; the injected foundation adapter alone writes recipes.
// No source folder is assumed to exist on the server, and no approval/trust is copied.
export function createRecipeImport({importSelected, checkFolder = async () => false}) {
  if (typeof importSelected !== 'function' || typeof checkFolder !== 'function') throw error('invalid-adapter');
  let epoch = 0, rows = null, busy = false, finished = false, disposed = false, abort = null;
  const alive = token => {
    if (disposed) throw error('disposed');
    if (token !== epoch) throw error('stale-operation');
  };
  function cancel() { epoch++; rows = null; abort?.abort(); }
  async function open(file, {names = []} = {}) {
    if (disposed) throw error('disposed');
    if (busy) throw error('busy');
    const token = ++epoch;
    rows = null; finished = false;
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.text !== 'function') throw error('invalid-file');
    if (file.size > policy.MAX_BYTES) throw error('file-too-large');
    const text = await file.text();
    alive(token);
    // Reuse the desktop's bounded, non-evaluating pack and acknowledgement policy.
    // Empty folder is intentional: folders in a local export are not server facts.
    const preview = policy.parsePackDocument(text, {platform:'linux', folderExists:()=>false, names});
    rows = preview.rows.map(row => ({...row, folder:'', autoApprove:'follow'}));
    return clone({...preview, rows});
  }
  async function commit(selections, acknowledgements = {}) {
    if (disposed) throw error('disposed');
    if (busy) throw error('busy');
    if (finished) throw error('operation-finished');
    if (!rows) throw error('no-preview');
    const token = epoch;
    busy = true;
    const saved = [];
    let attempted = false;
    try {
      // Clone before an await so changing the checkboxes cannot change this batch.
      const chosen = clone(selections);
      // Validate selection shape and acknowledgement gates before any I/O.
      const recipes = policy.commitSelection(rows, chosen.map(s=>({...s,target:'local',folder:''})), {
        platform:'linux',folderExists:()=>false,
        acceptSecrets:acknowledgements.acceptSecrets===true,
        acceptPermissions:acknowledgements.acceptPermissions===true,
      });
      const selected = chosen.filter(s=>s.selected);
      for (let i=0; i<selected.length; i++) {
        const raw = selected[i].folder;
        if (typeof raw !== 'string' || raw.length > 300) throw error('folder-unavailable');
        const folder = raw.trim();
        if (folder && folder !== '~') {
          if (!folder.startsWith('/') || folder.startsWith('//') || /[\u0000-\u001f]/.test(folder)) throw error('folder-unavailable');
          const found = await checkFolder(folder);
          alive(token);
          if (found !== true) throw error('folder-unavailable');
        }
        recipes[i].folder = folder || '~';
        recipes[i].autoApprove = 'follow';
      }
      alive(token);
      // The foundation owns the only POST loop and its recipe mapping. The signal
      // stops later writes, but never pretends to undo one already sent.
      attempted = true; finished = true;
      abort = new AbortController();
      let results;
      try { results = await importSelected(clone(recipes), {signal:abort.signal}); }
      catch { return {status:'unconfirmed',saved}; }
      if (!Array.isArray(results) || results.length > recipes.length) return {status:'unconfirmed',saved};
      for (let i=0; i<results.length; i++) {
        const result = results[i];
        if (result?.index !== undefined && result.index !== i) return {status:'unconfirmed',saved};
        const kind=result?.status || (result?.ok===true?'saved':result?.ok===false?(result.unconfirmed===true?'unconfirmed':'refused'):null);
        if (kind==='saved' && typeof result.id === 'string' && result.id) saved.push(selected[i].index);
        else if (kind==='not-sent' && (token!==epoch||disposed)) return {status:'cancelled',saved};
        else if (kind==='refused') return {status:'refused',saved,index:selected[i].index};
        else return {status:'unconfirmed',saved,index:selected[i].index};
      }
      if (token !== epoch || disposed) return {status:'cancelled',saved};
      if (results.length !== recipes.length) return {status:'unconfirmed',saved};
      return {status:'complete',saved};
    } finally {
      busy = false; abort = null;
      if (attempted) rows = null;
    }
  }
  return Object.freeze({open,commit,cancel,dispose(){disposed=true;cancel();}});
}
