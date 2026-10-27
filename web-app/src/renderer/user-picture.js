// Your picture: inline raster only. The engine owns persistence; no local photo cache.
const PICK_LIMIT = 2 * 1024 * 1024;
const STORE_LIMIT = 256 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const PICTURE_WORDS = {
  size: 'That file is too large. Choose one under 2 MB.',
  type: 'That file is not a picture we can use. Choose a PNG, JPEG or WebP.',
  save: "Couldn't save. Check your connection and try again.",
};
export function pictureOrNull(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(STORE_LIMIT / 3) + 32) return null;
  const match = /^data:image\/(?:png|jpeg|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(value);
  if (!match || !match[1]) return null;
  const bytes = match[1].length / 4 * 3 - (match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0);
  return bytes <= STORE_LIMIT ? value : null;
}
// At most the saved picture and one optimistic preview. Every matching avatar shares a blob URL.
const pictureUrls = new Map();
const avatarProfiles = new WeakMap();
export function clearPictureUrls() {
  for (const url of pictureUrls.values()) URL.revokeObjectURL(url);
  pictureUrls.clear();
}
export function pictureObjectUrl(value) {
  if (!pictureOrNull(value)) return null;
  if (pictureUrls.has(value)) return pictureUrls.get(value);
  const [head, base64] = value.split(',');
  const binary = atob(base64), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const type = head.slice(5).split(';')[0];
  try { pictureDimensions(bytes,type); } catch { return null; } // remote/web-set pictures get the same pre-decode guard
  const url = URL.createObjectURL(new Blob([bytes], {type}));
  pictureUrls.set(value, url);
  while (pictureUrls.size > 2) { const oldest = pictureUrls.keys().next().value; URL.revokeObjectURL(pictureUrls.get(oldest)); pictureUrls.delete(oldest); }
  return url;
}
export function refreshPictureAvatars(profile) {
  for (const node of document.querySelectorAll('.wr-user-picture')) {
    const meta = avatarProfiles.get(node);
    if (meta && !node.classList.contains('ac-picture-preview') && meta.me?.pictureKey === profile.key) {
      paintPictureAvatar(node, {...meta.me,picture:profile.picture},meta.size);
    }
  }
}
export function pictureInitials(me = {}) {
  const name = String(me?.name || '').trim();
  const handle = String(me?.handle || '').replace(/^@/, '').trim();
  const text = name || (/^(?:you|user)$/i.test(handle) ? '' : handle);
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > 1 ? ([...words[0]][0] + [...words.at(-1)][0]).toUpperCase() : ([...text][0] || '').toUpperCase();
}
export function squareCrop(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > 40_000_000) throw Error(PICTURE_WORDS.type);
  const size = Math.min(width, height);
  return { sx: (width - size) / 2, sy: (height - size) / 2, size };
}
/** Read only container headers; never allocate decoded pixels for an oversized image. */
export function pictureDimensions(bytes, type) {
  if (!(bytes instanceof Uint8Array)) throw Error(PICTURE_WORDS.type);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at, size) => String.fromCharCode(...bytes.subarray(at, at + size));
  let width, height;
  if (type === 'image/png' && bytes.length >= 24 &&
      view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
      view.getUint32(8) === 13 && text(12,4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at < bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217 || marker === 218 || marker === undefined) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > bytes.length) break;
      const size = view.getUint16(at);
      if (size < 2 || at + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (size < 8) break;
        height = view.getUint16(at + 3); width = view.getUint16(at + 5); break;
      }
      at += size;
    }
  } else if (type === 'image/webp' && bytes.length >= 20 && text(0,4) === 'RIFF' && text(8,4) === 'WEBP') {
    const end = view.getUint32(4,true) + 8;
    if (end > bytes.length || end < 20) throw Error(PICTURE_WORDS.type);
    for (let at = 12; at + 8 <= end;) {
      const tag = text(at,4), size = view.getUint32(at+4,true), data = at + 8;
      if (data + size > end) break;
      if (tag === 'VP8X' && size >= 10) {
        width = 1 + bytes[data+4] + (bytes[data+5]<<8) + (bytes[data+6]<<16);
        height = 1 + bytes[data+7] + (bytes[data+8]<<8) + (bytes[data+9]<<16); break;
      }
      if (tag === 'VP8L' && size >= 5 && bytes[data] === 47) {
        const packed = view.getUint32(data+1,true); width = 1 + (packed & 16383); height = 1 + ((packed >>> 14) & 16383); break;
      }
      if (tag === 'VP8 ' && size >= 10 && !(bytes[data] & 1) && text(data+3,3) === '\x9d\x01\x2a') {
        width = view.getUint16(data+6,true) & 16383; height = view.getUint16(data+8,true) & 16383; break;
      }
      at = data + size + (size & 1);
    }
  }
  squareCrop(width,height); // validates positive dimensions and the 40 MP allocation ceiling
  return {width,height};
}
function read(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error(PICTURE_WORDS.type));
    reader.readAsDataURL(file);
  });
}
function decode(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(Error(PICTURE_WORDS.type));
    image.src = src;
  });
}
function encode(image, { sx, sy, size }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error(PICTURE_WORDS.type);
  ctx.drawImage(image, sx, sy, size, size, 0, 0, 256, 256);
  for (const type of ['image/webp', 'image/png', 'image/jpeg']) {
    const value = canvas.toDataURL(type, 0.88);
    if (pictureOrNull(value)) return value;
  }
  throw Error(PICTURE_WORDS.type);
}
export async function preparePicture(file, deps = {}) {
  if (!file || !TYPES.has(file.type)) throw Error(PICTURE_WORDS.type);
  if (!Number.isFinite(file.size) || file.size > PICK_LIMIT) throw Error(PICTURE_WORDS.size);
  try {
    const source = await (deps.read || read)(file);
    const encoded = String(source).split(',')[1];
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    pictureDimensions(bytes, file.type); // BEFORE Image.src or any pixel decoder
    const image = await (deps.decode || decode)(source);
    const crop = squareCrop(image.naturalWidth, image.naturalHeight);
    const value = await (deps.encode || encode)(image, crop);
    if (!pictureOrNull(value)) throw Error(PICTURE_WORDS.type);
    return value;
  } catch { throw Error(PICTURE_WORDS.type); }
}
function identity(st) {
  return st?.signedIn && st.me ? JSON.stringify([st.accountId || '', st.origin || st.server || '', st.me.handle || '', st.me.name || '']) : null;
}
// A generation fences saves and file decoding across sign-out, account/server changes and destruction.
export function createPictureEditor(deps) {
  let generation = 0, key, busy = false, picture = null, error = '', saved = false, disposed = false;
  const state = () => ({ picture, busy, error, saved, enabled: !!key && !disposed });
  const emit = () => deps.change?.(state());
  function sync() {
    const st = deps.status(), next = identity(st);
    if (next !== key) { key = next; generation++; busy = false; error = ''; saved = false; }
    if (!busy) picture = key ? pictureOrNull(st.me?.picture) : null;
    emit();
  }
  sync();
  const current = (stamp, person) => !disposed && stamp === generation && person === identity(deps.status());
  async function write(value, stamp, person, previous) {
    picture = value; emit();
    try {
      const result = await deps.save({ picture: value });
      if (!current(stamp, person)) { sync(); return false; }
      if (!result?.ok) throw Error('save');
      picture = result.value?.picture === undefined ? value : pictureOrNull(result.value.picture);
      error = ''; saved = true;
      return true;
    } catch {
      if (current(stamp, person)) { picture = previous; error = PICTURE_WORDS.save; }
      return false;
    } finally {
      if (current(stamp, person)) { busy = false; emit(); }
    }
  }
  function begin() {
    sync();
    if (!key || busy || disposed) return null;
    busy = true; error = ''; saved = false; emit();
    return { stamp: generation, person: key, previous: picture };
  }
  async function set(value) {
    if (value !== null && !pictureOrNull(value)) return false;
    const job = begin();
    return job ? write(value, job.stamp, job.person, job.previous) : false;
  }
  async function choose(file) {
    const job = begin();
    if (!job) return false;
    try {
      const value = await (deps.prepare || preparePicture)(file);
      if (!current(job.stamp, job.person)) { sync(); return false; }
      return await write(value, job.stamp, job.person, job.previous);
    } catch (e) {
      if (current(job.stamp, job.person)) { busy = false; error = e.message; emit(); }
      return false;
    }
  }
  async function remove() {
    const person = identity(deps.status()), stamp = generation, previous = picture;
    if (!previous) return false;
    const ok = await set(null);
    if (ok) deps.removed?.(() => current(stamp, person) ? set(previous) : Promise.resolve(false));
    return ok;
  }
  return { sync, state, set, choose, remove, invalidate() { generation++; key = null; picture = null; busy = false; error = ''; saved = false; emit(); }, destroy() { disposed = true; generation++; } };
}
let avatarPalettePainter=null;
export function setUserPicturePalette(painter){avatarPalettePainter=typeof painter==='function'?painter:null;}
export function refreshUserPicturePalettes() {
  for (const node of document.querySelectorAll('.wr-user-picture')) {
    const meta = avatarProfiles.get(node);
    if (meta?.me) avatarPalettePainter?.(node, meta.me);
  }
}
export function paintPictureAvatar(node, me, size = 32) {
  avatarProfiles.set(node, {me,size});
  node.textContent = '';
  node.classList.add('wr-user-picture');
  node.classList.remove('has-picture');
  if(me)avatarPalettePainter?.(node,me);
  Object.assign(node.style, { display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: size + 'px', height: size + 'px', borderRadius: '50%', overflow: 'hidden' });
  if (node.getAttribute('aria-hidden') === 'true') { node.removeAttribute('role'); node.removeAttribute('aria-label'); }
  else { node.setAttribute('role', 'img'); node.setAttribute('aria-label', 'Your picture'); }
  const fallback = () => {
    node.textContent = pictureInitials(me);
    if (!node.textContent) {
      const glyph = document.createElement('span');
      glyph.className = 'ms'; glyph.textContent = 'person'; glyph.setAttribute('aria-hidden', 'true');
      node.appendChild(glyph);
    }
  };
  fallback();
  const value = pictureOrNull(me?.picture);
  const source = value ? pictureObjectUrl(value) : null;
  if (source) {
    const image = document.createElement('img'); image.alt = ''; image.style.cssText = 'width:100%;height:100%;object-fit:cover';
    image.addEventListener('load', () => { if (image.parentNode === node) node.classList.add('has-picture'); });
    image.addEventListener('error', () => { if (image.parentNode === node) { node.classList.remove('has-picture'); fallback(); } }, { once: true });
    node.textContent = ''; node.appendChild(image); image.src = source;
  }
  return node;
}
export function userPictureAvatar(me, size = 32) {
  const node = document.createElement('span'); node.className = 'wr-av';
  node.style.setProperty('--avs', size + 'px');
  node.setAttribute('aria-hidden', 'true');
  return paintPictureAvatar(node, me, size);
}
