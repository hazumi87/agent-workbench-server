// The image viewer's marks files over slice 3's room-files client (src/renderer/web-files/room-files-client.js, its
// read/write contract from a builder, Client /): one store per viewer opening, keyed by picture name.
// It keeps the revision from the SAME read that gave the text: a write sends If-Match with it, or If-None-Match * when
// the file did not exist. A lost race (conflict) is never retried: the picture's marks are held until the viewer is
// opened again. A write the client could not confirm is checked by reading the file back: our own text means it
// landed; anything else is a conflict. test/image-companions.test.mjs.
//
// files: {read(dir, rel) → {ok:true, blob, revision?} | {ok:false, code}, write(dir, rel, blob, {revision?}) →
//         {ok:true, revision?} | {ok:false, code}, destroy()}

const DIR = 'assets';
const NAME = (name) => name + '.annotations.svg';

export function createCompanionStore(files) {
  const revs = new Map(); // picture name → the revision last read or written; null: no file; absent: unknown
  const conflicted = new Set();

  async function read(name) {
    const r = await files.read(DIR, NAME(name));
    if (r && r.ok === true) {
      if (typeof r.revision === 'string') revs.set(name, r.revision);
      else revs.delete(name);
      return await r.blob.text();
    }
    if (r && r.code === 'not-found') {
      revs.set(name, null);
      return null;
    }
    throw Object.assign(new Error('marks read: ' + (r && r.code)), { code: (r && r.code) || 'unavailable' });
  }

  /** → true (saved), 'conflict' (changed elsewhere: held), or false (not saved; the page may try again). */
  async function write(name, text) {
    if (conflicted.has(name)) return 'conflict';
    if (!revs.has(name)) {
      try { await read(name); } catch { return false; } // learn the revision first; never write blind over a file
      if (!revs.has(name)) return false; // a file without a revision: nothing safe to send If-Match with
    }
    const rev = revs.get(name);
    const r = await files.write(DIR, NAME(name), new Blob([text], { type: 'text/plain' }), rev === null ? {} : { revision: rev });
    if (r && r.ok === true) {
      if (typeof r.revision === 'string') revs.set(name, r.revision);
      else revs.delete(name); // re-read before the next write
      return true;
    }
    if (r && r.code === 'conflict') {
      conflicted.add(name);
      return 'conflict';
    }
    if (r && r.code === 'unconfirmed') {
      try {
        if ((await read(name)) === text) return true;
      } catch {
        return false;
      }
      conflicted.add(name);
      return 'conflict';
    }
    return false;
  }

  return Object.freeze({ read, write, destroy: () => { try { files.destroy?.(); } catch { /* already gone */ } } });
}
