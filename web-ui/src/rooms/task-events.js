'use strict';
// Tasks seam S5 (the design notes, revision 3 item 5): the two events a module may get about a
// room's tasks carry ids only. room.tasks comes from the engine on the live socket and is checked here,
// in main, before anything is broadcast; rooms.shown is the shape the Workrooms page tells modules
// which room it shows. Anything else (an extra field, a non-string, a string over 128 characters, a
// frame over 1 KB) is dropped: a malformed frame never reaches a module.

const MAX_STR = 128;
const MAX_BYTES = 1024;

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const idOk = (x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_STR;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));

/** The raw frame text is small enough to look at (checked before JSON.parse). */
function frameBytesOk(text) {
  return typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_BYTES;
}

/** A room.tasks frame → `{ roomId, familyId|null }`, or null when it must be dropped. */
function checkTasksFrame(msg) {
  if (!isObj(msg) || msg.type !== 'room.tasks' || !onlyKeys(msg, ['type', 'roomId', 'familyId'])) {
    return null;
  }
  if (!idOk(msg.roomId) || (msg.familyId !== undefined && msg.familyId !== null && !idOk(msg.familyId))) {
    return null;
  }
  return { roomId: msg.roomId, familyId: msg.familyId ?? null };
}

/**
 * A rooms.shown payload → the same three fields, null for "no room shown", or undefined when it is
 * malformed (never delivered). `group` is a workgroup alias or null for the main room.
 */
function checkShown(p) {
  if (p === null) {
    return null;
  }
  if (!isObj(p) || !onlyKeys(p, ['roomId', 'familyId', 'group']) || !idOk(p.roomId) || !idOk(p.familyId)) {
    return undefined;
  }
  if (p.group !== null && !idOk(p.group)) {
    return undefined;
  }
  return { roomId: p.roomId, familyId: p.familyId, group: p.group };
}

/**
 * The family of a room, from main's OWN rooms cache (never from the frame): the main room's id, as the
 * engine keys families. null when the room is not one of this account's rooms.
 */
function familyOf(roomId, cache) {
  for (const v of Array.isArray(cache) ? cache : []) {
    const r = v && v.room;
    if (!r) {
      continue;
    }
    if (r.id === roomId) {
      return r.parent_id ? r.parent_id : r.id;
    }
    if (!r.parent_id && ((v.family && v.family.workgroups) || []).some((g) => g && g.id === roomId)) {
      return r.id;
    }
  }
  return null;
}

/** room.tasks from the live socket → what main broadcasts on `rooms:tasks`, or null (dropped). */
function tasksBroadcast(msg, cache) {
  const p = checkTasksFrame(msg);
  if (!p) {
    return null;
  }
  const familyId = familyOf(p.roomId, cache);
  return familyId ? { roomId: p.roomId, familyId } : null;
}

module.exports = { checkTasksFrame, checkShown, frameBytesOk, familyOf, tasksBroadcast, MAX_STR, MAX_BYTES };
