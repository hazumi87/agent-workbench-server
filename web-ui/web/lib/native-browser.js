'use strict';
// The three rooms substitutes that need the browser instead of an Electron dialog (src/rooms/index.js ctx.native; the desktop never
// sets it). Owner: a builder.
//   pickFiles   a file input (the person's own click opens the OS chooser); up to 10 files, bytes only up to 25 MB, like the desktop
//   saveFile    the browser's download: an <a download> on a blob URL (a download is never rendered, so a blob is safe here)
//   openAsset   a tab on the ENGINE'S OWN raw route, never a blob: URL. A blob: tab would run an uploaded SVG or HTML with this
//               page's origin and cookies; the engine serves its raw route with a sandboxing CSP and nosniff, and a rendered tab
//               on it has no access to the app. Only the room id and the file name travel; both are encoded.
const BLOB_TYPE_OK = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

function pickFiles({ max = 10, limit = 25 * 1024 * 1024, mimeOf = () => 'application/octet-stream' } = {}, doc = globalThis.document) {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    let done = false;
    const finish = (list) => { if (done) return; done = true; input.remove(); resolve(list); };
    input.addEventListener('cancel', () => finish([]));
    input.addEventListener('change', async () => {
      const out = [];
      for (const f of [...(input.files || [])].slice(0, max)) {
        try {
          const type = f.type && BLOB_TYPE_OK.test(f.type) ? f.type : mimeOf(f.name);
          out.push(f.size > limit ? { name: f.name, type, size: f.size } : { name: f.name, type, size: f.size, bytes: new Uint8Array(await f.arrayBuffer()) });
        } catch (e) { /* gone between the chooser and the read */ }
      }
      finish(out);
    });
    doc.body.appendChild(input);
    input.click();
  });
}

function saveFile({ name, type, buffer }, win = globalThis) {
  const doc = win.document;
  const url = win.URL.createObjectURL(new win.Blob([buffer], { type: 'application/octet-stream' })); // never a rendering type
  const a = doc.createElement('a');
  a.href = url;
  a.download = String(name || 'file').replace(/[\\/\0]/g, '_').slice(0, 200);
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => win.URL.revokeObjectURL(url), 30000);
  return true;
}

function assetUrl(roomId, name) {
  return '/api/rooms/' + encodeURIComponent(String(roomId)) + '/assets/raw/' + encodeURIComponent(String(name));
}
function openAsset({ roomId, name }, win = globalThis) {
  const w = win.open(assetUrl(roomId, name), '_blank', 'noopener,noreferrer');
  return !!w || w === null; // noopener returns null on success in some browsers: a blocked popup is the person's browser setting, not an error here
}

module.exports = { pickFiles, saveFile, openAsset, assetUrl };
