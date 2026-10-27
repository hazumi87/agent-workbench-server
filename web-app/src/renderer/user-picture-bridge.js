// A status carries a hash, never image bytes. Read once per changed hash per window.
import { pictureOrNull, clearPictureUrls, refreshPictureAvatars } from './user-picture.js';
let key = null, picture = null, person = null, epoch = 0, pending = false;
let retryAt = 0, retryDelay = 2000;
const listeners = new Set();
export function onOwnPictureChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) fn(); };
function clear() { epoch++; key = picture = person = null; pending = false; retryAt = 0; retryDelay = 2000; clearPictureUrls(); notify(); }
export function resolvePictureProfile(me) {
  if (!me) return me;
  return {...me,picture:me.picture !== undefined ? me.picture : me.pictureKey && me.pictureKey === key ? picture : null};
}
export function withOwnPictureStatus(status) { return status ? {...status,me:resolvePictureProfile(status.me)} : status; }
async function accept(status, api) {
  const nextPerson = status?.signedIn ? JSON.stringify([status.accountId || '', status.origin || status.server || '', status.me?.handle || '']) : null;
  if (nextPerson !== person) { clear(); person = nextPerson; }
  const nextKey = status?.signedIn ? status.me?.pictureKey || null : null;
  if (nextKey !== key) { epoch++; key = nextKey; picture = null; pending = false; retryAt = 0; retryDelay = 2000; if (!key) clearPictureUrls(); notify(); }
  if (!key || picture || pending || Date.now() < retryAt) return;
  pending = true; const stamp = epoch, wanted = key; let loaded = false;
  try {
    const result = await api.rooms.picture();
    if (stamp !== epoch || !result?.ok || result.value?.key !== wanted) return;
    picture = pictureOrNull(result.value.picture);
    if (!picture) return;
    loaded = true;
    refreshPictureAvatars({key,picture}); notify();
  } finally {
    if (stamp === epoch) {
      pending = false;
      if (loaded) { retryAt = 0; retryDelay = 2000; }
      else { retryAt = Date.now() + retryDelay; retryDelay = Math.min(30000,retryDelay * 2); }
    }
  }
}
if (typeof window !== 'undefined' && window.wb?.on && window.wb.rooms?.picture) {
  const api = window.wb;
  api.on('rooms:account', clear);
  api.on('rooms:status', status => { void accept(status,api).catch(() => {}); });
  if (api.rooms.status) void api.rooms.status().then(status => accept(status,api)).catch(() => {});
  window.addEventListener?.('beforeunload', clear, {once:true});
}
