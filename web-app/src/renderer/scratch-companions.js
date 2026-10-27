// Pre-send mark-up (a reviewer's ruling, Planning ; engine contract Client ): an unsent picture lives in the
// person's own draft scratch for the room, and so do its marks, as a companion bound to that one picture. This adapter
// gives image-companions.js the same read/write shape the room-files client has, over the scratch routes, so the
// revision rules hold unchanged: the ETag of the same read, a create that never overwrites (x-companion-of; 409 when
// one exists), a replace only with If-Match (412 on a stale one), never a blind retry. readDraftPicture reads the
// picture's own bytes as a data URL. Web build only (same-origin fetch, the sign-in cookie). test/scratch-companions.test.mjs.
//
// deps: roomId · pictures: [{id, name}] (the tray's uploaded pictures, from the binding) · fetch (same-origin)

const MAX_COMPANION = 256 * 1024;

export function createScratchFiles({ roomId, pictures, fetch: f }) {
  const base = '/api/rooms/' + encodeURIComponent(roomId) + '/scratch';
  const byCompanionName = new Map(pictures.map((p) => [p.name + '.annotations.svg', p]));
  const companionIds = new Map(); // picture id → its companion's scratch id, learned from a read or a create
  let destroyed = false;
  const ctl = new AbortController();
  const call = (path, init) => f(base + path, { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal, ...init });

  return Object.freeze({
    async read(_dir, rel) {
      const p = byCompanionName.get(rel);
      if (!p || destroyed) return { ok: false, code: 'changed' };
      let list;
      try {
        const r = await call('', { method: 'GET', headers: { accept: 'application/json' } });
        if (r.status !== 200) return { ok: false, code: 'unavailable', status: r.status };
        list = await r.json();
      } catch {
        return { ok: false, code: 'unavailable' };
      }
      const c = (Array.isArray(list && list.files) ? list.files : []).find((x) => x && x.companionOf === p.id);
      if (!c) {
        companionIds.delete(p.id);
        return { ok: false, code: 'not-found', status: 404 };
      }
      companionIds.set(p.id, c.id);
      try {
        const r = await call('/' + encodeURIComponent(c.id), { method: 'GET' });
        if (r.status === 404) return { ok: false, code: 'not-found', status: 404 };
        if (r.status !== 200) return { ok: false, code: 'unavailable', status: r.status };
        const etag = r.headers.get('etag');
        const blob = await r.blob();
        if (blob.size > MAX_COMPANION) return { ok: false, code: 'too-large' };
        return { ok: true, blob, ...(etag ? { revision: etag } : {}) };
      } catch {
        return { ok: false, code: 'unavailable' };
      }
    },

    /** No revision: create (never over an existing one); a revision: replace exactly that version. */
    async write(_dir, rel, blob, { revision } = {}) {
      const p = byCompanionName.get(rel);
      if (!p || destroyed) return { ok: false, code: 'changed' };
      const unconfirmed = { ok: false, code: 'unconfirmed' };
      try {
        let r;
        if (revision === undefined) {
          r = await call('', { method: 'POST', headers: { 'content-type': 'image/svg+xml', 'x-filename': encodeURIComponent(rel), 'x-companion-of': p.id }, body: blob });
        } else {
          const id = companionIds.get(p.id);
          if (!id) return { ok: false, code: 'reload-required' };
          r = await call('/' + encodeURIComponent(id), { method: 'PUT', headers: { 'content-type': 'image/svg+xml', 'if-match': revision }, body: blob });
        }
        if (r.status === 409 || r.status === 412) return { ok: false, code: 'conflict', status: r.status };
        if (r.status === 428) return { ok: false, code: 'reload-required', status: 428 };
        if (r.status < 200 || r.status >= 300) return r.status >= 500 ? unconfirmed : { ok: false, code: 'refused', status: r.status };
        let j = null;
        try { j = await r.json(); } catch { j = null; }
        const file = j && j.file;
        if (file && typeof file.id === 'string') companionIds.set(p.id, file.id);
        return { ok: true, ...(file && typeof file.etag === 'string' ? { revision: file.etag } : {}) };
      } catch {
        return unconfirmed; // it may have landed: the store reads it back
      }
    },

    destroy() {
      destroyed = true;
      try { ctl.abort(); } catch { /* already */ }
    },
  });
}

/** A draft picture's bytes as a data URL (the viewer page accepts image data URLs only). null when it can't be read. */
export async function readDraftPicture({ roomId, fileId, fetch: f }) {
  try {
    const r = await f('/api/rooms/' + encodeURIComponent(roomId) + '/scratch/' + encodeURIComponent(fileId), { credentials: 'same-origin', cache: 'no-store' });
    if (r.status !== 200) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'data:' + type + ';base64,' + btoa(bin);
  } catch {
    return null;
  }
}
