// The image viewer's host (the design notes; the design notes R1.2, R1.3): what answers the viewer
// page's verbs for ONE opening. The host binds the room, the message's pictures and whether it was sent; the page never
// names a room and can read or write nothing else: files.read takes exactly a bound picture (as a data URL) or that
// picture's companion (as text), files.write takes only a bound picture's companion, never after send, at most
// MAX_COMPANION bytes. Every other verb is refused. Pure: the reads and writes are injected, so it runs in tests.
// test/image-host.test.mjs.
//
// io: readPicture(roomId, name) → data URL · readCompanion(roomId, name) → text, or null when there is none ·
//     writeCompanion(roomId, name, text) → true, 'conflict' (changed elsewhere: held) or false · each throws when the
//     engine does not answer
// on: marks(id, count) · dismiss() · expand(on)

import { companionName } from '../../modules/image-viewer/ui/companion.js';

export const MAX_COMPANION = 256 * 1024;
const DIR = 'assets'; // message pictures live in the room's assets ()
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,/;
const MAX_PICTURES = 50;

const refused = (status, error, field) => ({ ok: false, kind: 'refused', status, error, field: field || null });
const TRANSPORT = Object.freeze({ ok: false, kind: 'transport' });
const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/** a: {roomId, pictures:[{id, name}], start?, sent?} → a host, or null when the binding is not usable. */
export function createImageHost(a, { io, on = {} }) {
  if (!isPlain(a) || typeof a.roomId !== 'string' || !a.roomId || a.roomId.length > 128) return null;
  if (!Array.isArray(a.pictures) || a.pictures.length < 1 || a.pictures.length > MAX_PICTURES) return null;
  const pictures = [];
  const byName = new Map();
  for (const p of a.pictures) {
    if (!isPlain(p) || typeof p.id !== 'string' || !ID.test(p.id) || pictures.some((x) => x.id === p.id)) return null;
    const companion = companionName(p.name);
    if (!companion || byName.has(p.name)) return null;
    pictures.push({ id: p.id, name: p.name, companion });
    byName.set(p.name, pictures[pictures.length - 1]);
  }
  const roomId = a.roomId;
  const sent = a.sent === true;
  const start = Number.isInteger(a.start) && a.start >= 0 && a.start < pictures.length ? a.start : 0;
  const byCompanion = new Map(pictures.map((p) => [p.companion, p]));
  let closed = false;

  async function read(input) {
    if (!isPlain(input) || input.dir !== DIR || typeof input.rel !== 'string') return refused(403, 'Not a picture this view was opened on.', 'rel');
    if (input.as === 'dataUrl') {
      const p = byName.get(input.rel);
      if (!p) return refused(403, 'Not a picture this view was opened on.', 'rel');
      const url = await io.readPicture(roomId, p.name);
      if (typeof url !== 'string' || !DATA_URL.test(url)) return TRANSPORT;
      return { ok: true, body: { dataUrl: url } };
    }
    if (input.as === 'text') {
      const p = byCompanion.get(input.rel);
      if (!p) return refused(403, 'Only a picture\'s own marks can be read.', 'rel');
      const text = await io.readCompanion(roomId, p.name);
      if (text === null) return refused(404, 'No marks yet.', 'not-found');
      if (typeof text !== 'string' || text.length > MAX_COMPANION) return TRANSPORT;
      return { ok: true, body: { text } };
    }
    return refused(400, 'Read a picture as dataUrl or its marks as text.', 'as');
  }

  async function write(input) {
    if (sent) return refused(403, 'This message was sent; its marks are view-only.', 'sent');
    if (!isPlain(input) || input.dir !== DIR || typeof input.rel !== 'string' || typeof input.text !== 'string') return refused(400, 'Not a marks file.', 'input');
    const p = byCompanion.get(input.rel);
    if (!p) return refused(403, 'Only a picture\'s own marks can be written.', 'rel');
    if (input.text.length > MAX_COMPANION) return refused(413, 'The marks are too large to keep.', 'text');
    const ok = await io.writeCompanion(roomId, p.name, input.text);
    if (ok === 'conflict') return refused(409, 'These marks were changed somewhere else. Close the picture and open it again to see them.', 'conflict');
    return ok === true ? { ok: true, body: { ok: true } } : TRANSPORT;
  }

  return Object.freeze({
    /** One request from the viewer page ({verb, input}) → its reply. */
    async call(verb, input) {
      if (closed) return { ok: false, kind: 'revoked' };
      try {
        let r;
        switch (verb) {
          case 'image.init':
            r = { ok: true, body: { pictures: pictures.map((p) => ({ id: p.id, name: p.name, dir: DIR, rel: p.name })), start, sent } };
            break;
          case 'files.read':
            r = await read(input);
            break;
          case 'files.write':
            r = await write(input);
            break;
          case 'image.marks':
            if (!isPlain(input) || !pictures.some((p) => p.id === input.id) || !Number.isInteger(input.count) || input.count < 0 || input.count > 1000) return refused(400, 'Not a marks count.', 'input');
            on.marks?.(input.id, input.count);
            r = { ok: true, body: {} };
            break;
          case 'dismiss':
            on.dismiss?.();
            r = { ok: true, body: {} };
            break;
          case 'expand':
            on.expand?.(!!(isPlain(input) && input.on === true));
            r = { ok: true, body: {} };
            break;
          default:
            return refused(403, 'Not an image viewer verb.', 'verb');
        }
        return closed ? { ok: false, kind: 'revoked' } : r; // a late reply after close is dropped
      } catch {
        return closed ? { ok: false, kind: 'revoked' } : TRANSPORT;
      }
    },
    close() {
      closed = true;
    },
    pictures: () => pictures.map((p) => ({ id: p.id, name: p.name })),
  });
}
