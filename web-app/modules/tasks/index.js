// Tasks (first-party, class tool, role tasks): the rail card for the room the Workrooms page shows,
// opening the preview (the design notes). Data comes only from the engine's Tasks routes
// through the host (api.rooms.tasks, S4) with the window credential; nothing here talks to the
// network or holds a token. Until the host has the seams (S1, S2, S4, S5) it does nothing.

import { cardDescriptor } from './ui/core.js';

/** Revision 11: the Room Tasks card from room-tasks' summary.json, or null (no card) unless it answered ok. */
export function roomTasksDescriptor(r) {
  if (!r || r.ok !== true || !r.room) return null;
  const total = Number(r.room.total) || 0;
  const open = Number(r.room.open) || 0;
  const topics = Array.isArray(r.topics) ? r.topics.length : 0;
  return {
    title: 'Room Tasks',
    icon: 'checklist',
    pct: total ? Math.round(((Number(r.room.done) || 0) / total) * 100) : null,
    linked: null,
    spans: [],
    axis: null,
    line: open + ' open · ' + topics + (topics === 1 ? ' topic' : ' topics'), // the design : short enough for 256 px; the focus is in the view
    badge: null,
  };
}

const CARD_ID = 'tasks';
const RT_CARD_ID = 'roomtasks'; // revision 11: the Room Tasks (Vikunja) card; main draws a room-tasks card first
const TIMELINE_HOURS = 8; // the engine clamps 1..24; the card shows the last 7½ h of it

/**
 * The controller, separate from activate() so tests can drive it with a fake api.
 * opts.now: a clock; opts.minGapMs: the least time between two reads (default 30 s, the seam's rule).
 */
export function createController(api, opts = {}) {
  const now = opts.now || (() => Date.now());
  const minGapMs = opts.minGapMs ?? 30_000;
  let shown = null; // { roomId, familyId, group }
  let card = null;
  let lastRead = -Infinity;
  let pending = false;
  let ready = false;

  const hasSeams = () => !!(api.ui && api.ui.registerRailCard && api.ui.openSide && api.rooms && api.rooms.tasks);

  let rtCard = null;

  async function dispose(c) {
    try {
      await c.dispose();
    } catch {
      // the host already removed it
    }
  }
  async function dropLocal() {
    if (card) {
      const c = card;
      card = null;
      await dispose(c);
    }
  }
  async function dropRoomTasks() {
    if (rtCard) {
      const c = rtCard;
      rtCard = null;
      await dispose(c);
    }
  }
  /** Both cards go (a new room, none shown, stop). */
  async function drop() {
    await Promise.all([dropLocal(), dropRoomTasks()]);
  }

  /** Revision 11: the room's Room Tasks summary (room-tasks through the engine's panel proxy). Any failure, a
   *  404 for a room without a Room Tasks panel or {ok:false}, draws no card. */
  async function readRoomTasks(at) {
    let r;
    try {
      r = await api.rooms.tasks(at.roomId, 'room-summary');
    } catch (e) {
      if (e && e.status !== 404) api.log('tasks: could not read Room Tasks: ' + (e.message || e));
      r = null;
    }
    if (shown !== at) return;
    const d = roomTasksDescriptor(r);
    if (!d) {
      await dropRoomTasks();
      return;
    }
    if (!rtCard) {
      // main puts a room-tasks card first, and admits it only where its own cache has the room's Room Tasks panel
      rtCard = await api.ui.registerRailCard({ id: RT_CARD_ID, kind: 'room-tasks', onActivate: () => activate('room-tasks') });
    }
    if ((await rtCard.update(d)) === false) {
      rtCard = null;
    }
  }

  async function read() {
    const at = shown;
    if (!at) {
      return;
    }
    lastRead = now();
    pending = false;
    await Promise.all([readLocal(at), readRoomTasks(at)]);
  }

  async function readLocal(at) {
    let summary;
    let timeline;
    try {
      [summary, timeline] = await Promise.all([api.rooms.tasks(at.roomId, 'summary'), api.rooms.tasks(at.roomId, 'timeline', { hours: TIMELINE_HOURS })]);
    } catch (e) {
      // 404 = Tasks is off in this engine (the server server, or HARBOR_WB_TASKS=0): show nothing.
      if (e && e.status !== 404) {
        api.log('tasks: could not read the room: ' + (e.message || e));
      }
      await dropLocal();
      return;
    }
    if (shown !== at) {
      return; // the person moved on while we read
    }
    const d = cardDescriptor(summary, timeline, at.group ?? null, now());
    if (!d) {
      await dropLocal();
      return;
    }
    if (!card) {
      card = await api.ui.registerRailCard({ id: CARD_ID, onActivate: () => activate() });
    }
    if ((await card.update(d)) === false) {
      card = null; // the host refused it (a stale binding): the next read registers afresh
    }
  }

  /** Read now if the gap has passed, else remember to read at the next flush. */
  async function refresh() {
    if (now() - lastRead >= minGapMs) {
      await read();
    } else {
      pending = true;
    }
  }

  async function activate(source) {
    if (!shown) {
      return;
    }
    const params = { roomId: shown.roomId, group: shown.group ?? null };
    if (source === 'room-tasks') params.source = 'room-tasks'; // revision 11: the read-only Room Tasks view
    await api.ui.openSide({ page: 'ui/preview.html', params });
  }

  return {
    async start() {
      if (!hasSeams()) {
        api.log('tasks: this host has no rail card seam yet, so the Tasks card stays off');
        return;
      }
      ready = true;
      api.events.on('rooms.shown', async (p) => {
        shown = p && p.roomId ? { roomId: p.roomId, familyId: p.familyId ?? null, group: p.group ?? null } : null;
        await drop(); // a card is bound to one room: a new room gets a new card
        if (!shown) {
          return;
        }
        lastRead = -Infinity; // a new room always reads at once
        await read();
      });
      api.events.on('rooms.tasks', async (p) => {
        if (!shown || (p && p.familyId && shown.familyId && p.familyId !== shown.familyId)) {
          return;
        }
        await refresh();
      });
    },
    /** Run a deferred read if one is waiting and the gap has passed (the host's timer calls this). */
    async flush() {
      if (ready && pending && now() - lastRead >= minGapMs) {
        await read();
      }
    },
    activate,
    /** The add-task action: adds to the room shown, as the person (the window credential). */
    async addTask(input) {
      const title = typeof input?.title === 'string' ? input.title.trim() : '';
      if (!shown) {
        return 'Open a room first.';
      }
      if (!title) {
        return 'A task needs a title.';
      }
      await api.rooms.tasks(shown.roomId, 'add', { title, ...(shown.group ? { group: shown.group } : {}) });
      lastRead = -Infinity;
      await read();
      return 'Added: ' + title;
    },
    async stop() {
      shown = null;
      await drop();
    },
  };
}

let controller = null;
let timer = null;

export async function activate(api) {
  controller = createController(api);
  await controller.start();
  const c = controller;
  await api.tools.provide({ id: 'room.tasks', handlers: { 'add-task': (input) => c.addTask(input) } });
  // The host turns a module off by making its api throw (modules.js deactivate bumps rec.gen) and
  // removes its cards itself; the first throw here stops the timer for good.
  timer = setInterval(() => {
    controller.flush().catch(() => {
      clearInterval(timer);
      timer = null;
    });
  }, 5_000);
}

export async function deactivate() {
  clearInterval(timer);
  timer = null;
  if (controller) {
    await controller.stop();
    controller = null;
  }
}
