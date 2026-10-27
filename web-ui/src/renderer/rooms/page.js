// Workrooms (W1, read): the Workrooms tab drawn by the app's renderer over the rooms client in main
// (window.wb.rooms is the only door). the design's step-5 page (workbench-step5-workrooms, #w1):
//  - a room-tab strip under the bar: "All rooms" (the grid button with the count), then each open room
//    (plate, name, unread, ✕), remembered across restarts;
//  - All rooms: M3 cards (color band, name, seats · lead, unread, workgroup chips, who's in it, the
//    last line, Open room · ⋯), "N hidden · Show" / "Showing N hidden · Hide them", New room (W3: opens
//    briefing-table's page in the browser), "No rooms yet";
//  - a room: the 48 px header (plate, name, crumb, info · search · filter · ⋯), the connection strip
//    (worst wins), the line (./line.js), the room's rail (Room chat and its workgroups, the seats) pinned
//    at 1000 px and up, an overlay from the left flag below;
//  - signed out: the tab's own sign-in (ROOMS-API.md §1.3; the lead , 2 and 6);
//  - the image viewer (./viewer.js);
//  - W2: the composer under the line (./composer.js, the design's #w2), Reply from the line, the unsent rows;
//    the room's ⋯ (Notes, Assets) and the side column beside the line (./side.js).
// A FOLDER OF ITS OWN with src/rooms: nothing here reaches into the CLI Manager.
import { icon } from '../m3-chrome.js';
import { userPictureAvatar } from '../user-picture.js';
import { resolvePictureProfile } from '../user-picture-bridge.js';
import { el, createLine, avatarEl, seatColor, setSeatColors, colorOf, timeWords } from './line.js';
import { createViewer } from './viewer.js';
import { createFrameLink, isModuleFrameSrc } from '../module-frame.js';
import { createComposer } from './composer.js';
import { createSide } from './side.js';
import { createStarterWorkrooms } from './starter-workrooms.js';
import { createTemplateMount } from '../room-templates/mount.js';
import { createAgentWizard } from '../first-run/agent-wizard.js';
import { createPeople, closeMenus, openMenu, seatGlyph, roomGlyph, seatState } from './people.js';
import { prefillFor, isToMe } from './rules.js';
import { openDialog } from './dialog.js';
import { decorateRoomActivity, applyRoomActivityContext, createRoomActivityAnnouncements, ROOM_ACTIVITY_SIZE, TEAM_ACTIVITY_SIZE } from './room-activity.js';
import { groupLabel, plate, isCollapsed, toggleCollapsed, isUnpinned, setUnpinned as storeUnpinned } from '../srail.js';

// the design  (the owner ): the room's rail is pinned by default from 700 px (the room keeps 440 px), 272 px
// wide, 240 px under 900; under 700 it is an overlay from the slim flag. Unpinning is remembered per window.
const PIN_FROM = 700;
const SLIM_UNDER = 900;
const WIDE_FROM = 1000; // the side column beside the line and the room's full crumb
const TABS_KEY = 'wb.rooms.tabs';
const UNREAD_KINDS = new Set(['chat', 'attachment', 'voice']);

const WORDS = {
  signedOut: (host) => 'Sign in to see your rooms on ' + (host || 'the room service') + '.',
  wrong: "That username and password didn't match.",
  unreachable: (host) => "Can't reach the rooms on " + (host || 'the server') + '.',
  offline: "You're offline.",
  password: (host) => 'Set a password first, on ' + (host || 'the server') + ' in the browser.',
  noRooms: 'No rooms yet',
  noRoomsBody: 'A room is where you and your agents talk. Make one and choose who sits in it.',
  polling: "Live updates aren't connected. New messages may take a few seconds to show.",
  offlineStrip: "You're offline. The line catches up when you're back.",
  down: (host, s) => "Can't reach the rooms on " + (host || 'the server') + '. Trying again in ' + s + ' s.',
  // A1: why the quiet sign-in didn't happen, as [before, link, after, where the link goes]
  auto: {
    'not-linked': ["Your Workbench account isn't linked to Rooms yet. Link it on your ", 'Rooms account page', " and you'll sign in here by itself.", 'engine'],
    off: ['Signing in with your Workbench account is turned off for Rooms. Sign in below the usual way.'],
    unreachable: ["Couldn't reach your Workbench account just now, so you weren't signed in automatically. Sign in below, or try again later."],
    'not-allowed': ["Your Workbench account isn't allowed to use Rooms. Ask whoever runs Rooms for access, or sign in below with another account."],
    'no-account': ["You're not signed in to a Workbench account, so Rooms can't sign you in by itself. Sign in under ", 'Settings › Accounts', ', or sign in below.', 'accounts'],
  },
};

export function createRoomsPage(deps) {
  const host = deps.host;
  let destroyed = false;
  const localState = () => deps.localState?.();
  const placeOf = id => localState()?.rooms?.find(room => room.id === id)?.place || 'local';
  const filesAvailable = () => !localState() || placeOf(currentRoomId()) !== 'local' || localState().fileStoreReady === true;
  let placeFilter = 'all';
  function canCreateRoom() {
    if (destroyed) return false;
    const local = localState();
    // 0.24.0 cannot switch the account-bound dispatcher to another place.
    if (local && ((placeFilter !== 'all' && placeFilter !== 'local') || local.lastRoomPlace !== 'local')) {
      deps.snackbar?.((globalThis.wb && globalThis.wb.web ? 'In this version you can create rooms only on this server. Choose This server, then try again.' : 'In this version you can create rooms only on this computer. Choose This computer, then try again.'));
      return false;
    }
    return true;
  }
  async function newRoom() {
    try {
      if (!canCreateRoom()) return;
      if(templateMount?.open({screen:'picker'}))return;
      const local = localState();
      if (local?.servers.length && await people.chooseRoomPlace(local) == null) return;
      if (canCreateRoom()) await people.newRoom();
    } catch (error) { if (!destroyed) deps.snackbar?.(error.message || "Couldn't choose a room location."); }
  }
  function appendLocation(host, room) {
    const chip = deps.locationChip?.({ ...room, place: placeOf(room.id) });
    if (chip) host.appendChild(chip);
  }

  const subscriptions = [];
  const outsideCleanups = new Set();
  function subscribe(channel, fn) {
    const off = window.wb.on(channel, payload => { if (!destroyed) fn(payload); });
    if (typeof off === 'function') subscriptions.push(off);
  }
  function watchOutside(node, fn) {
    let timer;
    const cleanup = () => { clearTimeout(timer); document.removeEventListener('pointerdown', away, true); outsideCleanups.delete(cleanup); };
    const away = e => { if (!node.isConnected) { cleanup(); return; } fn(e); if (!node.isConnected) cleanup(); };
    timer = setTimeout(() => { if (!destroyed && node.isConnected) document.addEventListener('pointerdown', away, true); else cleanup(); }, 0);
    outsideCleanups.add(cleanup);
    return cleanup;
  }
  function closePageMenus() {
    for (const cleanup of [...outsideCleanups]) cleanup();
    closeMenus(root);
  }
  let accountId = null;
  let accountEpoch = 0;
  let colorAccount, roomColors;
  function roomSeed(view) {
    const room=view?.room||view;
    if(!deps.roomColors)return room?.color||null;
    if(!roomColors||colorAccount!==accountId){colorAccount=accountId;roomColors=deps.roomColors.create(accountId);}
    const hidden=hiddenIds(),activeFamily=familyOf(currentRoomId()),open=new Set(st.tabs.flatMap(t=>[t.familyId,t.roomId]));
    const visible=(st.rooms||[]).filter(v=>{
      if(!v?.room)return false;
      const id=v.room.id,family=v.room.parent_id||id;
      return open.has(id)||(st.active==='all'?st.showHidden||!hidden.has(id)&&!hidden.has(family):family===activeFamily);
    });
    return roomColors.seed(room,visible);
  }
  function roomPalette(node,view){const seed=roomSeed(view);if(seed)deps.roomColors?.apply(node,seed);return node;}
  function systemPalette(node){deps.roomColors?.system(node);}

  const tabsKey = () => TABS_KEY + ':' + (accountId || 'local');
  let gridQuery = ''; // the phone's "Find a room or seat" field (under 600 px), kept across repaints
  const st = {
    status: { signedIn: false, conn: 'signed-out', server: '', me: null, retryAt: 0 },
    rooms: [],
    tabs: [], // [{ familyId, roomId }]
    active: 'all', // 'all' | familyId
    showHidden: false,
    width: 0,
    railOpen: false,
    shown: false,
    newForMe: new Map(), // familyId -> room name (something addressed to you in a tab you can't see)
    signinBusy: false,
    signinError: null,
    retryTick: null,
  };

  // ---- DOM
  const root = el('div', 'wr');
  const activityDescriptionPrefix='room-activity-'+Math.random().toString(36).slice(2);
  let activityDescriptionSequence=0;
  const activityLive=el('div','ra-room-live');activityLive.setAttribute('role','status');activityLive.setAttribute('aria-live','polite');activityLive.setAttribute('aria-atomic','true');
  const activityAnnouncements=createRoomActivityAnnouncements();
  function clearActivity(){activityAnnouncements.reset();if(activityLive.textContent)activityLive.textContent='';}
  const strip = el('div', 'wr-tabs');
  strip.setAttribute('role', 'tablist');
  const roomHead = el('div', 'wr-roomhead');
  roomHead.hidden = true;
  const bodyRow = el('div', 'wr-body');
  const rail = el('aside', 'wr-rail');
  rail.setAttribute('aria-label', 'Room');
  // This toolbar stays mounted through polling, room changes and resizing. In
  // particular, never recreate or assign the search input during a repaint:
  // the browser owns its focus, selection direction and active IME composition.
  const railToolbar = el('div', 'wr-railtoolbar');
  const railSearch = el('label', 'wr-railq');
  railSearch.innerHTML = icon('search');
  const railInput = el('input', 'wr-railqi');
  railInput.type = 'search'; railInput.placeholder = 'Find a room or seat';
  railInput.setAttribute('aria-label', 'Find a room or seat');
  const railClear = el('button', 'wr-ib wr-railqx');
  railClear.type = 'button'; railClear.title = 'Clear'; railClear.setAttribute('aria-label', 'Clear');
  railClear.innerHTML = icon('close'); railClear.hidden = true;
  railSearch.append(railInput, railClear);
  const railPin = el('button', 'sr-hb sr-pin wr-pin'); railPin.type = 'button';
  railPin.addEventListener('click', () => setUnpinned(pinned()));
  const railClose = el('button', 'sr-hb sr-close'); railClose.type = 'button'; railClose.title = 'Close';
  railClose.setAttribute('aria-label', 'Close the list'); railClose.innerHTML = icon('close');
  railClose.addEventListener('click', () => closeRail());
  railToolbar.append(railSearch, railPin, railClose);
  const railBody = el('div', 'wr-railb');
  rail.append(railToolbar, railBody);
  const main = el('div', 'wr-main');
  const inlineTerminal = el('section', 'wr-inline-terminal');
  inlineTerminal.setAttribute('aria-label', 'Seat terminal'); inlineTerminal.hidden = true;
  let inlineView = null, inlineEpoch = 0;
  let inlineOpener = null; // the control a seat's terminal layer was opened from: Back returns focus there
  // full pages (a module's, opened from its preview): a tab in the strip; their frames stay attached here and are only
  // shown or hidden (a moved iframe reloads, and a reload ends its link)
  const toolHost = el('section', 'wr-toolpages');
  toolHost.hidden = true;
  const toolPages = []; // {key, title, icon, from, wrap, dispose}
  const toolPageOf = (key) => toolPages.find((t) => t.key === key) || null;
  bodyRow.append(rail, main, toolHost);
  const signin = el('div', 'wr-signin');
  signin.hidden = true;
  const viewer = createViewer({
    image: (roomId, name) => window.wb.rooms.image(roomId, name).then((r) => (r && r.ok ? r.value : null)),
    download: (roomId, name) => window.wb.rooms.download(roomId, name),
    openWindow: (roomId, name) => window.wb.rooms.openWindow(roomId, name),
  });
  let starterSettingsGeneration=0;
  const invalidateStarterSettings=()=>{starterSettingsGeneration++;};
  const canUseStarter = () => accountId===null && !st.status.accountId;
  function makeStarterControls() {
    if (!window.wb.starterRooms) return null;
    return createStarterWorkrooms({api:window.wb.starterRooms.bind(),snackbar:deps.snackbar,onVisibilityChange:invalidateStarterSettings,onSettings:()=>{if(!destroyed&&canUseStarter())deps.openStarterSettings?.();},onGridChange:()=>{if(!destroyed&&st.active==='all')paint();},
      onOpen:id=>{void (async()=>{const epoch=accountEpoch,bound=window.wb.rooms.bind();try{const r=await bound.list(true);
        if(!destroyed&&epoch===accountEpoch&&accountId===null&&bound.current()&&r?.ok){st.rooms=r.value||[];openRoom(id,id);}
      }catch(e){if(!destroyed&&epoch===accountEpoch)deps.snackbar?.(e.message||"Couldn't open the room.");}})();},
      onSetupAgents:deps.agentSetup?()=>{if(destroyed||!st.shown||!canUseStarter())return;activate('all');agentWizard?.reopen();}:undefined,
      onTerminal:seat=>{void (async()=>{const epoch=accountEpoch,navigation=inlineEpoch,selected=st.active,shown=st.shown,bound=window.wb.rooms.bind();
        const current=()=>!destroyed&&shown&&st.shown&&epoch===accountEpoch&&navigation===inlineEpoch&&selected===st.active&&canUseStarter()&&bound.current();
        if(!current())return;
        try{const r=await bound.room(seat.roomId);if(!current()||!r?.ok)return;
          const s=r.value?.seats?.find(s=>s.id===seat.id&&!s.left_at);if(s)openStarterTerminal(seat.roomId,r.value,s);
        }catch{if(current())deps.snackbar?.("Couldn't open the terminal.");}})();}});
  }
  let starter = makeStarterControls(),starterVisibilityVersion=0;
  function resetStarterControls(){invalidateStarterSettings();starterVisibilityVersion++;starter?.destroy();starter=makeStarterControls();if(starter)root.insertBefore(starter.roomMount(),bodyRow);}
  root.append(activityLive, strip, roomHead, ...(starter?[starter.roomMount()]:[]), bodyRow, signin, viewer.el);
  host.appendChild(root);
  const notificationHost=deps.notificationBanner?el('div','wr-notification-host'):null;
  if(notificationHost){notificationHost.hidden=true;root.insertBefore(notificationHost,roomHead);}
  const notificationBanner=notificationHost?deps.notificationBanner({host:notificationHost,
    context:()=>({visible:!destroyed&&st.shown&&st.active==='all'&&st.status.signedIn===true,key:String(accountEpoch)})}):null;

  const templateHost=deps.roomTemplates?el('section',''):null;
  if(templateHost)templateHost.hidden=true;
  const templateMount=templateHost?createTemplateMount({host:templateHost,api:deps.roomTemplates,
    onOpenRoom:async(id,current)=>{const bound=window.wb.rooms.bind();const response=await bound.list(true);if(!current()||!bound.current()||!response?.ok)return;
      if(!response.value?.some(v=>v.room?.id===id))return;st.rooms=response.value;openRoom(id,id);},
    onBuiltin:async(input,current)=>{if(!current())return {ok:false,code:'stale'};
      if(input.templateId==='blank'){const local=localState();if(local?.servers.length&&await people.chooseRoomPlace(local)==null)return {ok:false,code:'cancelled'};if(!current()||!canCreateRoom())return {ok:false,code:'stale'};await people.newRoom();return {ok:true,handled:true};}
      if(!canUseStarter()||!window.wb.starterRooms)return {ok:false,code:'unavailable'};
      const result=await window.wb.starterRooms.bind().open({template:input.templateId});if(!current())return {ok:false,code:'stale'};
      if(!result?.roomId)return {ok:false,code:'unavailable'};
      const bound=window.wb.rooms.bind(),response=await bound.list(true);if(!current()||!bound.current()||!response?.ok)return {ok:false,code:'stale'};
      st.rooms=response.value||[];openRoom(result.roomId,result.roomId);return {ok:true,handled:true};}}):null;
  function syncTemplates(){const local=localState();templateMount?.context({shown:st.shown&&st.status.signedIn&&!disconnected(currentRoomId()),
    local:accountId===null&&!st.status.accountId&&(!local||local.localRooms.status==='running'),scope:deps.templateScope?.(),roomId:currentRoomId()||null});}
  const agentHost = deps.agentSetup ? el('section', '') : null;
  const agentGrid = agentHost ? el('div','wr-grid') : null;
  const agentListing = agentHost ? el('div','lf-room-listing') : null;
  if(agentGrid){const heading=el('div','wr-gh');heading.appendChild(el('h4',null,'Rooms'));agentGrid.append(heading,agentHost,agentListing);}
  const agentWizard = agentHost ? createAgentWizard({host:agentHost,api:deps.agentSetup,onVisibility:on=>{deps.agentSetupVisibility?.(on);agentListing.hidden=on;const actions=agentGrid.querySelector('.wr-ghr');if(actions)actions.hidden=on;}}) : null;
  function paintAgentWizard() {
    const local=localState();
    agentWizard?.context({shown:st.shown && st.active==='all',
      local:accountId===null && local?.fileStoreReady===true && local.lastRoomPlace==='local',scope:accountEpoch+':'+(accountId||'local')});
  }


  const line = createLine({
    me: () => (st.status.me && st.status.me.handle) || null,
    userAvatar: () => personAvatar(32),
    seatIndex: (handle) => seatIndexOf(handle),
    thumb: (roomId, name, w) => window.wb.rooms.thumb(roomId, name, w).then((r) => (r && r.ok ? r.value : null)),
    openImage: (items, index) => (deps.openImageViewer?.(items, index) ? undefined : viewer.open(items, index)), // the markup viewer when it is on, else the built-in
    hasMarks: (roomId, name) => (window.wb.web?.files?.hasMarks ? window.wb.web.files.hasMarks(roomId, name) : Promise.resolve(false)), // web build: does a sent picture have a <name>.annotations.svg
    loadLatest: () => loadLatest(),
    onLatest: () => { cmp.pendingAgain(); markHeld(); paintRoom(); },
    loadOlder: (before) => window.wb.rooms.line(currentRoomId(), { before }).then((r) => (r && r.ok ? r.value : { entries: [], hasOlder: false })),
    markSeen: (lastId) => {
      const id = currentRoomId();
      if (id) {
        if (!disconnected(id)) window.wb.rooms.seen(id, lastId).catch(() => {});
      }
    },
    onReply: (e) => cmp.reply(replyOf(e)),
    lineMenu: (e, at, row) => lineMenu(e, at, row),
    onMention: (handle) => cmp.insertMention(handle),
    // W3: a seat by id (a delivery line names it so); Wake it and Nudge deliver a line again; Deliver now
    handleOf: (seatId) => {
      const s = seatsOf(viewOf(currentRoomId())).find((x) => x.id === seatId);
      return s ? s.handle : null;
    },
    // a seat that never ran (people.neverRan's test, inline: desktop tests load page.js as bare source)
    seatNeverRan: (seatId) => {
      const s = seatsOf(viewOf(currentRoomId())).find((x) => x.id === seatId);
      return !!s && (s.status === 'never-started' || s.status === 'empty' || (!s.occupant && (s.actions || []).includes('start') && s.status !== 'dehydrated' && s.status !== 'ended'));
    },
    // a line to a seat that never started: "Start it" starts that seat the way its row's Start does
    startSeatByHandle: async (handle) => {
      const v = viewOf(currentRoomId()); const s = v && seatsOf(v).find((x) => x.handle === String(handle || '').replace(/^@/, ''));
      if (!s) return false;
      return (await people.start(v.room.id, s)) !== false;
    },
    wakeDeliver: async (seatId, lineId) => {
      const r = await window.wb.rooms.wakeDeliver(currentRoomId(), seatId, lineId);
      if (!r || !r.ok) {
        deps.snackbar && deps.snackbar((r && r.message) || "Couldn't wake it.");
        return false;
      }
      return true;
    },
    deliverHeld: async (paneid) => {
      const r = await window.wb.rooms.deliverHeld(currentRoomId(), paneid);
      if (!r || !r.ok) {
        deps.snackbar && deps.snackbar((r && r.message) || "Couldn't deliver them.");
        return false;
      }
      return true;
    },
    // what a mention names: you, the room, the lead, a room of the family by alias, or a seat (null)
    addressKind: (handle) => addressKindOf(handle),
    onRetry: (id) => cmp.retry(id),
    onDiscard: (id) => cmp.discard(id),
    // P05: the room's seat by id (an approval plate shows only under a line its own seat wrote), and Approve's one line
    seatOf: (seatId) => seatsOf(viewOf(currentRoomId())).find((x) => x.id === seatId) || null,
    approvalReply: (e) => cmp.reply({ ...replyOf(e, { authorOnly: true }), placeholder: 'Say what you want instead' }), // "Reply…": nothing is sent
    approve: async (e) => {
      const roomId = currentRoomId();
      if (!roomId || e.room_id !== roomId) return false;
      let r = null;
      try { r = await window.wb.rooms.post(roomId, { text: 'Approved.', reply_to: e.id }); } catch (err) { r = null; }
      const v = r && r.ok ? r.value : null;
      if (!v || v.status === 'refused' || v.status === 'confirm') {
        deps.snackbar && deps.snackbar((v && v.refused && v.refused.error) || (r && r.message) || "Couldn't send your approval. Try again.");
        return false;
      }
      return true; // the line itself arrives with the room's broadcast and turns the plate into "You approved this at …"
    },
  });
  // "Enter sends the message" (web): saved per person on the engine (PATCH /api/rooms/me {enterSubmits}), the same in every browser tab. Unset = Enter sends.
  const enterListeners = new Set();
  const enterSendsNow = () => !(st.status.me && st.status.me.enterSubmits === false);
  const enterChan = typeof BroadcastChannel === 'function' && deps.enterSetting ? new BroadcastChannel('wb-enter-submits') : null;
  const enterPref = !deps.enterSetting ? null : {
    get: enterSendsNow,
    subscribe: (fn) => { enterListeners.add(fn); return () => enterListeners.delete(fn); },
    async set(v) {
      const on = !!v;
      const r = await window.wb.rooms.me({ enterSubmits: on }).catch(() => null);
      if (!r || r.ok === false) { deps.snackbar && deps.snackbar("Couldn't save that. Try again."); return false; }
      st.status.me = { ...(st.status.me || {}), enterSubmits: on };
      for (const fn of enterListeners) fn(on);
      try { enterChan && enterChan.postMessage({ enterSubmits: on }); } catch { /* none */ }
      return true;
    },
  };
  if (enterChan) enterChan.onmessage = (e) => { const v = e && e.data && e.data.enterSubmits; if (typeof v === 'boolean') { st.status.me = { ...(st.status.me || {}), enterSubmits: v }; for (const fn of enterListeners) fn(v); } };
  const cmp = createComposer({
    host: main,
    enterPref,
    sendMenu: (at, items) => openMenu(root, at, items),
    paintMention:(span,handle,kind,index)=>{
      const seed=kind==='you'?personColor():colorOf(handle)||(index!=null?deps.roomColors?.seedForHandle?.(handle):null);
      if(seed){deps.roomColors?.apply(span,seed);span.dataset.identityPalette='true';span.dataset.at=handle;}
    },
    onReplyChanged: () => paintRoom(),
    onAttachmentsChanged: () => side.refreshNoteAttachments(),
    openImageMarkup: deps.openImageMarkup ? (o) => deps.openImageMarkup(o) : undefined, // the host's editable viewer; absent: a tile does nothing new
    filesAvailable,
    filesUnavailableText: () => localState() && localState().fileStoreReady !== true ? 'Finish setting up first.' : null,
    roomId: () => currentRoomId(),
    roomName: () => {
      const v = viewOf(currentRoomId());
      return v && v.room ? v.room.name : '';
    },
    // the @ list: the shown room's seats, with what each is doing ("working", "parked")
    seats: () => seatsOf(viewOf(currentRoomId())).map((s) => ({ handle: s.handle, state: (s.occupant && s.occupant.activity) || s.status || '' })),
    // then @lead, @room, and the family's other rooms by alias (a line there cross-posts)
    extraAddresses: () => {
      const v = viewOf(currentRoomId());
      if (!v || !v.room) {
        return [];
      }
      const out = [];
      const lead = leadOf(v);
      if (lead) {
        out.push({ handle: 'lead', state: 'lead · ' + lead, glyph: 'star' });
      }
      out.push({ handle: 'room', state: 'everyone here', glyph: 'groups' });
      const fam = viewOf(familyOf(v.room.id));
      const others = fam ? [fam.room, ...((fam.family && fam.family.workgroups) || [])] : [];
      for (const r of others) {
        if (r && r.alias && r.id !== v.room.id) {
          out.push({ handle: r.alias, state: r.name, glyph: 'tag' });
        }
      }
      return out;
    },
    seatIndex: (handle) => seatIndexOf(handle),
    addressKind: (handle) => addressKindOf(handle), // 0.22.2: the typed names' colors
    conn: () => st.status.conn,
    roomConnected: id => !disconnected(id),
    snackbar: (text, o) => placeSnack(deps.snackbar ? deps.snackbar(text, o) : null),
    pendingAdd: (e) => line.addPending(e),
    pendingUpdate: (e) => line.updatePending(e),
    pendingRemove: (id) => line.removePending(id),
    scrollToBottom: () => line.scrollToBottom(),
    pickFiles: () => window.wb.rooms.pickFiles(),
    newNote: request => { openSide('notes'); return side.newNote({ origin: 'chat', request }); },
    openNote: (id, request) => { openSide('notes'); return side.editNote(id, request); },
    // "/notes" opens the column here; it never goes to the room service
    localCommand: (word) => {
      if (word === 'notes') {
        openSide('notes');
        return true;
      }
      return false;
    },
  });
  const side = createSide({
    filesAvailable,
    roomConnected: id => !disconnected(id),
    roomId: () => currentRoomId(),
    roomName: () => {
      const v = viewOf(currentRoomId());
      return v && v.room ? v.room.name : '';
    },
    me: () => (st.status.me && st.status.me.handle) || null,
    thumb: (roomId, name, w) => window.wb.rooms.thumb(roomId, name, w).then((r) => (r && r.ok ? r.value : null)),
    openImage: (items, index) => (deps.openImageViewer?.(items, index) ? undefined : viewer.open(items, index)), // the markup viewer when it is on, else the built-in
    download: (roomId, name) => window.wb.rooms.download(roomId, name),
    attachNote: (attachment, note, request) => cmp.putNote(attachment, note, request),
    hasNote: id => cmp.hasNote(id),
    noteRequest: () => cmp.noteRequest(),
    lineText: (lineId) => {
      const e = line.entry(lineId);
      const t = e && e.body ? String(e.body).replace(/\s+/g, ' ').trim() : '';
      return t ? (t.length > 60 ? t.slice(0, 60) + '…' : t) : null;
    },
    narrow: () => !wide(),
    // W3: the room's brief, read and saved through the room (PATCH brief)
    brief: () => {
      const v = viewOf(currentRoomId());
      return { text: (v && v.room && v.room.brief) || '' };
    },
    saveBrief: async (text, request) => {
      const r = await request.api.patch(request.roomId, { brief: String(text || '').trim() });
      if (!request.api.current()) return false;
      if (!r || !r.ok) {
        deps.snackbar && deps.snackbar((r && r.message) || "Couldn't save the brief.");
        return false;
      }
      return true;
    },
    clearBrief: () => people.clearBrief(currentRoomId()),
    // the quoted message under an asset: its line, scrolled to and flashed (over the line, the column steps aside)
    jump: async (lineId) => {
      if (!wide()) {
        await side.close();
      }
      return line.jumpTo(lineId);
    },
    onClose: () => {
      main.classList.remove('withside');
      syncToolLayer();
      cmp.focus();
    },
    onToolChange: () => syncToolLayer(),
  });
  bodyRow.appendChild(side.el);
  // the design s10, the final walk: on a phone (web) a tool layer, the preview over the room or the full page, is the whole screen with ONE
  // back arrow. html[data-wb-toollayer] hides the app bar and the room header (rooms.css), and what is behind the preview is inert,
  // so neither its buttons nor Tab reach it. The desktop's top bar is its window chrome, so this is the web build's only.
  let toolLayer = null;
  // focus guards: Tab past either end of the open layer comes back into it (the preview's frame keeps its own Tab order inside)
  const guardIn = el('span', 'wr-layerguard'), guardOut = el('span', 'wr-layerguard');
  const layerEl = () => (toolLayer === 'page' ? toolHost : toolLayer === 'preview' ? side.el : null);
  const layerStops = () => { const host = layerEl(); return host ? [...host.querySelectorAll('button, [tabindex="0"], iframe, a[href], input, textarea, select')].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null && !n.closest('[hidden]')) : []; };
  guardIn.addEventListener('focus', () => { const f = layerStops(); (f[f.length - 1] || layerEl())?.focus?.(); });
  guardOut.addEventListener('focus', () => { layerStops()[0]?.focus(); });
  function syncToolLayer() {
    const html = document.documentElement;
    const web = !!(globalThis.wb && globalThis.wb.web);
    const phone = web && !destroyed && st.shown && st.status.signedIn && st.width > 0 && st.width < 600;
    const page = phone ? toolPageOf(st.active) : null;
    const next = !phone ? null : page ? 'page' : side.isOpen() && side.toolOpen && side.toolOpen() ? 'preview' : inlineView && inlineView.handle && inlineView.roomId === currentRoomId() && !inlineTerminal.hidden ? 'terminal' : null; // a seat's terminal is a layer too (final-plus 5): the whole screen, only its own header
    if (next === toolLayer) return;
    toolLayer = next;
    if (html && html.dataset) { if (next) html.dataset.wbToollayer = next; else delete html.dataset.wbToollayer; }
    for (const n of [roomHead, rail, main, strip]) n.inert = next === 'preview';
    const skip = typeof document.querySelector === 'function' ? document.querySelector('.wb-skip') : null; // the page's skip link: nothing to skip to under a layer
    if (skip) skip.inert = !!next;
    const host = layerEl();
    if (host && host.parentNode) {
      guardIn.tabIndex = guardOut.tabIndex = 0;
      host.parentNode.insertBefore(guardIn, host);
      host.parentNode.insertBefore(guardOut, host.nextSibling);
      // after this paint shows it (the full page is unhidden later in the same paint): focus goes into the layer
      const into = () => { if (!destroyed && toolLayer === next && !host.contains(document.activeElement)) layerStops()[0]?.focus(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(into); else into();
    } else {
      guardIn.remove(); guardOut.remove();
    }
  }
  // W3: the people side (the seats in the rail and their menu, the room's ⋯, New room and New workgroup)
  const people = createPeople({
    canSaveTemplate:id=>templateMount?.canSave(viewOf(id)?.room)===true,
    saveTemplate:id=>{if(templateMount?.canSave(viewOf(id)?.room))templateMount.open({screen:'save',roomId:id});},
    host: root,
    isLocal: () => st.status.localMode === true,
    canCreateRoom,
    blockedStart: s => deps.blockedRecipe?.(s),
    platform: deps.platform,
    newRecipe: () => deps.newRecipe?.(),
    roomName: (id) => {
      const v = viewOf(id);
      return v && v.room ? v.room.name : '';
    },
    view: (id) => viewOf(id),
    disconnected: id => disconnected(id),
    setConnected: (id, on) => setConnected(id, on),
    snackbar: (text, options) => deps.snackbar && deps.snackbar(text, options),
    openRoom: (familyId, roomId) => openRoom(familyId, roomId),
    afterArchive: (roomId) => closeTab(roomId),
    afterDissolve: (parentId) => {
      if (parentId) {
        pick(parentId);
      }
    },
    openSide: (kind, mode) => openSide(kind, mode),
    // phone: the presence avatar leaves the header and is a row of the room's ⋯ menu (it opens the same "You're signed in on" popover under ⋯)
    phoneMenuRows: () => (st.width < 600 ? [{ id: 'presence', label: "Where you're signed in", icon: 'devices', fn: () => { const more = root.querySelector('.wr-roomhead .wr-more') || root.querySelector('.wr-more'); if (more) presenceMenu(more); } }] : []),
    openTerminal: (roomId, v, s) => openTerminal(roomId, v, s),
    selectSeat: (roomId, v, s) => openInlineTerminal(roomId, v, s),
    seatEnded: (roomId, seatId) => { if (inlineView?.roomId === roomId && inlineView.seatId === seatId) closeInlineTerminal(); },
    selectedSeat: roomId => inlineView?.roomId === roomId ? inlineView.seatId : null,
    // the seat ⋮'s Move to workgroup…: the family's rooms (the main room and its workgroups)
    familyRooms: (roomId) => {
      const fam = viewOf(familyOf(roomId));
      if (!fam || !fam.room) {
        return [];
      }
      return [{ id: fam.room.id, name: fam.room.name, main: true }].concat(((fam.family && fam.family.workgroups) || []).filter((g) => g.state !== 'archived').map((g) => ({ id: g.id, name: g.name, main: false })));
    },
    // B5: a main room's ⋮ › Hide for me (the same as its card's Hide)
    hideRoom: (roomId) => toggleHidden(roomId, true),
  });
  // P01 (the design s12): the seats that need you, told where you look when you are elsewhere (the web build's watcher, rooms/needs-you.js):
  // the Workrooms number, the tab title, one browser notification per wait. The room list is read again every 15 s while it is not
  // already polled (All rooms polls it itself), so a seat that starts waiting in another room is noticed.
  const needs = !deps.needsYou ? null : deps.needsYou({
    poll: () => { if (!destroyed && st.status.signedIn && !(st.shown && st.active === 'all')) window.wb.rooms.list(true).catch(() => {}); }, // force: a plain list() answers from its cache
  });
  // a phone has no rail: the room's seats open as a bottom sheet from the header's "Seats · n" button (the design s8)
  // (deps.seatsSheet is the web build's factory, rooms/seats-sheet.js: the desktop has the rail at every width, and the page's extracted-source tests load no new module)
  const seatsSheet = !deps.seatsSheet ? null : deps.seatsSheet({
    host: root,
    view: () => viewOf(currentRoomId()),
    roomId: () => currentRoomId(),
    seats: (v) => seatsOf(v),
    lead: (v) => leadOf(v),
    start: (roomId, s) => people.start(roomId, s),
    startWhy: () => people.startWhy(),
    seatItems: (roomId, v, s) => people.seatItems(roomId, v, s),
    open: (roomId, v, s) => openInlineTerminal(roomId, v, s),
    addSeat: (roomId) => people.addSeat(roomId),
  });
  // a phone has no rail: the room's chats (the room chat and its workgroups) open as a bottom sheet from the header's "Chats" button (the design s11)
  const chatsSheet = !deps.chatsSheet ? null : deps.chatsSheet({
    host: root,
    family: () => { const t = activeTab(); const fam = t && viewOf(t.familyId); const v = t && (viewOf(t.roomId) || fam); return fam && v ? { fam, currentId: v.room.id } : null; },
    viewOf: (id) => viewOf(id),
    open: (roomId) => pick(roomId),
    newWorkgroup: (familyId) => people.newWorkgroup(familyId),
  });
  // the room's tools in one list (a tool card, or an added tool's page): the header's Tools button, its small menu and, on a phone, its sheet (the design s10)
  const toolNote2 = (it) => [it.pct !== null && it.pct !== undefined ? it.pct + '% done' : '', it.line].filter(Boolean).join(' · ');
  function toolItems() {
    const out = [];
    for (const c of (deps.toolCards ? deps.toolCards() : [])) {
      if (!c || !c.card) continue;
      out.push({ key: c.moduleId + ':' + (c.cardId || 'main'), icon: c.card.icon, title: c.card.title, line: c.card.line || '', pct: c.card.pct ?? null, badge: c.card.badge ? c.card.badge.count : 0,
        open: () => deps.activateToolCard && deps.activateToolCard(c.moduleId, c.cardId || 'main') });
    }
    for (const p of (deps.pluginPages ? deps.pluginPages() : [])) {
      if (!p || typeof p.id !== 'string' || typeof p.url !== 'string' || !isModuleFrameSrc(p.url)) continue;
      out.push({ key: 'plugin:' + p.id, icon: 'extension', title: p.name, line: '', pct: null, badge: 0, open: () => { if (!(deps.openPluginPage && deps.openPluginPage(p.id))) openToolSide('plugin:' + p.id, p.url, { title: p.name }); } });
    }
    return out;
  }
  const toolsSheet = !deps.toolsSheet ? null : deps.toolsSheet({ host: root, items: () => toolItems() });
  function syncToolsButton() {
    if (destroyed || typeof root.querySelectorAll !== 'function') return;
    const n = toolItems().length;
    for (const b of root.querySelectorAll('.wr-toolsb')) {
      b.hidden = n === 0;
      b.title = 'Tools'; b.setAttribute('aria-label', 'Tools, ' + n);
      const c = b.querySelector('.wr-toolsn'); if (c) c.textContent = String(n);
    }
    if (toolsSheet?.isOpen()) { if (n === 0) toolsSheet.close(); else toolsSheet.refresh(); }
  }
  // W3b: a seat's CLI as a Terminals pane, behind "Open seats in Terminals" (off by default; the design )
  const terminalDialogs = new Set();
  function closeInlineTerminal(repaint = true) {
    const old = inlineView; inlineView = null; inlineEpoch++;
    inlineTerminal.hidden = true; inlineTerminal.textContent = '';
    syncToolLayer();
    if (old?.handle) { const back = inlineOpener; inlineOpener = null; requestAnimationFrame(() => { if (destroyed) return; if (back && back.isConnected && back.offsetParent !== null) back.focus(); else (root.querySelector('.wr-seatsb') || root.querySelector('.wr-roomhead button'))?.focus(); }); } // leaving: focus goes back to what opened it
    try { if (old?.handle) void Promise.resolve(old.handle.dispose()).catch(() => {}); } catch { /* already detached */ }
    if (repaint && st.active !== 'all' && st.status.signedIn) paintRoom();
  }
  function mountInlineTerminal(col) {
    const on = !!inlineView && inlineView.roomId === currentRoomId();
    col.classList.toggle('has-terminal', on); inlineTerminal.hidden = !on;
    if (on && inlineTerminal.parentElement !== col) col.appendChild(inlineTerminal);
    if (on) requestAnimationFrame(() => inlineView?.handle?.fit());
    syncToolLayer();
  }
  async function openInlineTerminal(roomId, v, s) {
    if (!st.shown || !st.status.signedIn || currentRoomId() !== roomId || !deps.openSeatTerminalInline || !seatsOf(viewOf(roomId)).some(seat => seat.id === s.id)) return;
    if (inlineView?.roomId === roomId && inlineView.seatId === s.id) { inlineView.handle?.fit(); return; }
    if (!inlineView) inlineOpener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    closeInlineTerminal(false);
    const request = window.wb.rooms.bind(), ownerEpoch = accountEpoch;
    const selected = { roomId, seatId: s.id, epoch: ++inlineEpoch, handle: null };
    inlineView = selected; st.railOpen = false;
    const current = () => inlineView === selected && inlineEpoch === selected.epoch && ownerEpoch === accountEpoch &&
      request.current() && st.shown && st.status.signedIn && currentRoomId() === roomId;
    inlineTerminal.textContent = 'Opening @' + s.handle + "'s terminal…";
    paintRoom();
    try {
      const handle = await deps.openSeatTerminalInline({ room: roomId, seat: s.id, handle: s.handle,
        roomName: v.room.name, vendor: s.vendor || s.occupant?.vendor, host: inlineTerminal, current,
        stateWord: () => { const seat = seatsOf(viewOf(roomId)).find(x => x.id === s.id); return seat ? seatState(seat) : ''; }, onClose: () => { if (current()) closeInlineTerminal(); } }); // stateWord: the seat's state in the Seats sheet's words, under its name in the phone layer's header
      if (!current()) { if (handle) void Promise.resolve(handle.dispose()).catch(() => {}); return; }
      selected.handle = handle;
      if (handle) { syncToolLayer(); requestAnimationFrame(() => { if (current()) inlineTerminal.querySelector('.pane-back')?.focus(); }); } // the layer opens on its arrow
      if (!handle) inlineTerminal.textContent = "Couldn't open this terminal. Select Room chat to return, then try the seat again.";
    } catch {
      if (current()) inlineTerminal.textContent = "Couldn't open this terminal. Select Room chat to return, then try the seat again.";
    }
  }
  let starterTerminalOperation = null;
  function openStarterTerminal(roomId, v, s) {
    const request = window.wb.rooms.bind(), ownerEpoch = accountEpoch, navigation = inlineEpoch, selected = st.active;
    const valid = () => !destroyed && st.shown && canUseStarter() && request.current() &&
      ownerEpoch === accountEpoch && navigation === inlineEpoch && selected === st.active &&
      seatsOf(viewOf(roomId)).some(seat => seat.id === s.id && !seat.left_at && seat.occupant?.id === s.occupant?.id);
    if (!valid() || !deps.openSeatTerminal || starterTerminalOperation?.current()) return;
    const operation = {busy:false,current:()=>starterTerminalOperation===operation && valid()};
    starterTerminalOperation = operation;
    const clear = () => {if(starterTerminalOperation===operation)starterTerminalOperation=null;};
    let dlg = null;
    const refused = () => {
      if(operation.current()){
        const words="Couldn't open this terminal. Try again.";
        if(dlg?.error)dlg.error(words);else deps.snackbar?.(words);
      }
      return false;
    };
    const go = async enable => {
      if(operation.busy || !operation.current())return false;
      operation.busy=true;let completed=false;
      try {
        if(enable){await deps.setTerminals(true);if(!operation.current())return false;}
        if(!operation.current())return false;
        if(deps.terminalsOn?.()!==true)return refused();
        const bridge=window.wb.starterRooms?.bind();
        if(typeof bridge?.terminalIntent!=='function')return refused();
        const admitted=await bridge.terminalIntent(roomId,s.id);
        if(!operation.current())return false;
        if(deps.terminalsOn?.()!==true || admitted?.ok!==true)return refused();
        const opened=await deps.openSeatTerminal({room:roomId,seat:s.id,handle:s.handle,roomName:v.room.name,controlOnOpen:true,current:operation.current});
        if(opened==null || opened===false || opened?.ok===false)return refused();
        completed=true;return true;
      } catch { return refused(); }
      finally {
        operation.busy=false;
        // A refused consent action stays retryable in THIS still-current dialog.
        if(completed || !dlg || !operation.current())clear();
      }
    };
    if(deps.terminalsOn?.()===true){void go(false);return;}
    dlg=openDialog(root,{
      title:`Open @${s.handle}'s terminal?`,
      text:`You'll see what @${s.handle} is doing and can type in it. Anything you type goes straight to the agent. This turns on terminal access for your agents; you can turn it off in Settings.`,
      actions:[{label:'Not now',fn:()=>{clear();return true;}},{label:'Open terminal',kind:'filled',primary:true,fn:()=>go(true)}],
      onClose:()=>{terminalDialogs.delete(dlg);clear();},
    });
    terminalDialogs.add(dlg);return dlg;
  }
  function openTerminal(roomId, v, s) {
    const request = window.wb.rooms.bind();
    const go = () => request.current() && deps.openSeatTerminal && deps.openSeatTerminal({ room: roomId, seat: s.id, handle: s.handle, roomName: v.room.name });
    if (deps.terminalsOn && deps.terminalsOn()) {
      return go();
    }
    const dlg = openDialog(root, {
      title: 'Turn on Open seats in Terminals?',
      text: "You can then watch a seat's CLI as a pane. You only type after you choose Take control.",
      actions: [
        { label: 'Not now' },
        {
          label: 'Turn on',
          kind: 'filled',
          primary: true,
          fn: async () => {
            if (!request.current()) return false;
            await deps.setTerminals(true);
            if (!request.current()) return false;
            go();
            return true;
          },
        },
      ],
      onClose: () => terminalDialogs.delete(dlg),
    });
    terminalDialogs.add(dlg);
    return dlg;
  }
  function openSide(tab, mode) {
    if (st.active === 'all' || disconnected(currentRoomId())) {
      return;
    }
    closeInlineTerminal(false);
    paintRoom();
    st.railOpen = false;
    side.open(tab, mode);
    main.classList.toggle('withside', wide());
  }
  // Tasks seam S2: a module's own page in the side column, for the room shown (the design notes).
  // S4: a wbmod: page goes through the frame link (module-frame.js): declared to main, sandboxed, one
  // port for the load it started; main's modules:frame-revoke for its owner ends it.
  const frameLinks = new Map(); // owner -> link
  const toolLinks = new Map(); // key -> { link, lastAt, pending, timer }: S4 step 6's host events
  let frameSeq = 0;
  // S4 step 6 (revision 7, item 4): the theme a tool page gets is the app's colour roles, checked: role names
  // only, plain colour values (hex, rgb, hsl, oklch with numbers only), 40 characters at most, 64 at most.
  const THEME_KEY = /^--md-sys-color-[a-z-]{1,40}$/;
  const THEME_VALUE = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch)\(\s*-?[\d.]+%?(\s*[, ]\s*-?[\d.]+%?){2}(\s*[,/]\s*[\d.]+%?)?\s*\))$/;
  function themePayload() {
    const vars = typeof deps.themeVars === 'function' ? deps.themeVars() || {} : {};
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(vars)) {
      if (n >= 64) break;
      if (THEME_KEY.test(k) && typeof v === 'string' && v.trim().length <= 40 && THEME_VALUE.test(v.trim())) {
        out[k] = v.trim();
        n++;
      }
    }
    return out;
  }
  const nowMs = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
  function sendToolEvent(entry) {
    entry.timer = null;
    if (entry.pending === undefined) return;
    entry.lastAt = nowMs();
    entry.link.post({ event: 'rooms.tasks', payload: entry.pending });
    entry.pending = undefined;
  }
  subscribe('modules:frame-revoke', (p) => {
    const link = p && typeof p.owner === 'string' ? frameLinks.get(p.owner) : null;
    if (link) link.revoke();
  });
  /**
   * One module page's frame link (S4): sandboxed, declared to the module host, one port per load (module-frame.js).
   * The preview and the full page share it, so a full page is exactly as contained as the preview.
   * isShown: is this key's page still the one shown; close: close it here (the fixed dismiss, Escape in the page);
   * popout: the page may ask for its full page (the preview only).
   */
  function moduleLink(key, src, { title, binding, onDispose, isShown, close, popout }) {
    const owner = String(key) + '.' + (++frameSeq);
    const link = createFrameLink({
      doc: document, src, owner, title: title || 'Tool',
      onConnect: () => link.post({ event: 'theme', payload: themePayload() }),
      declare: (url, o) => window.wb.moduleFrameExpect({ url, owner: o }),
      // S4 step 5: the module host admits the request (modules.js toolRequest) against this page's own
      // binding; without the hook nothing is admitted
      onMessage: (m) => {
        // Escape inside the page (S4 step 6): the exact fixed dismiss closes THIS link's page here, never
        // through the admission, main or the engine; an old link cannot close a newer page
        if (isFixed(m, 'dismiss')) {
          if (toolLinks.get(key) === entry && isShown()) {
            link.post({ id: m.id, ok: true, body: null });
            close();
          } else link.post({ id: m.id, ok: false, kind: 'refused', status: 409, error: 'This page is no longer shown.' });
          return;
        }
        // S3: the pop-out, the same way: this link's own binding to the module host, never the Tasks admission
        if (isFixed(m, 'popout')) {
          if (!popout || toolLinks.get(key) !== entry || !isShown() || typeof deps.toolWindowOpen !== 'function') {
            link.post({ id: m.id, ok: false, kind: 'refused', status: 409, error: 'This page is no longer shown.' });
            return;
          }
          Promise.resolve(deps.toolWindowOpen(binding)).then((r) => {
            if (r && r.ok === true) link.post({ id: m.id, ok: true, body: null });
            else if (r && r.kind === 'refused') link.post({ id: m.id, ok: false, kind: 'refused', status: r.status, error: r.error, field: r.field ?? null });
            else link.post({ id: m.id, ok: false, kind: r && r.kind === 'revoked' ? 'revoked' : 'transport' });
          }, () => link.post({ id: m.id, ok: false, kind: 'transport' }));
          return;
        }
        if (typeof deps.toolRequest === 'function') deps.toolRequest(binding, owner, m, (r) => link.post(r));
        else if (m && Number.isInteger(m.id)) link.post({ id: m.id, ok: false, kind: 'transport' });
      },
      // the link ended (revoked, closed): an open delete confirmation for it closes
      onClose: () => { if (typeof deps.toolCancel === 'function') deps.toolCancel(owner); },
    });
    frameLinks.set(owner, link);
    const entry = { link, lastAt: -Infinity, pending: undefined, timer: null };
    toolLinks.set(key, entry);
    const frame = link.frame;
    frame.className = 'wr-toolframe';
    const dispose = () => {
      frameLinks.delete(owner);
      if (typeof deps.toolCancel === 'function') deps.toolCancel(owner);
      if (toolLinks.get(key) === entry) toolLinks.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      link.close();
      if (onDispose) onDispose();
    };
    return { frame, dispose };
  }
  function openToolSide(key, src, { title, onDispose, binding } = {}) {
    if (destroyed || st.active === 'all' || disconnected(currentRoomId())) return false;
    closeInlineTerminal(false);
    st.railOpen = false;
    let frame;
    let dispose = onDispose;
    if (isModuleFrameSrc(src)) { // desktop wbmod:, web /app/modules|plugins/<id>/ui/
      ({ frame, dispose } = moduleLink(key, src, { title, binding, onDispose, popout: true,
        isShown: () => !!(side.toolOpen && side.toolOpen() === key), close: () => closeToolSide(key) }));
    } else {
      frame = el('iframe', 'wr-toolframe');
      frame.title = title || 'Tool';
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.src = src;
    }
    const ok = side.openTool(key, frame, { title, onDispose: dispose, binding });
    main.classList.toggle('withside', wide());
    return ok;
  }
  /** exactly {id, verb, input: {}} for one of the page's fixed local verbs (dismiss, popout) */
  function isFixed(m, verb) {
    const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && (Object.getPrototypeOf(o) === null || Object.getPrototypeOf(Object.getPrototypeOf(o)) === null);
    if (!plain(m)) return false;
    const keys = Object.keys(m);
    if (keys.length !== 3 || !Number.isInteger(m.id) || m.verb !== verb) return false;
    return plain(m.input) && Object.keys(m.input).length === 0;
  }
  function closeToolSide(key) {
    if (!destroyed && side.toolOpen && side.toolOpen() === key) void side.closeTool(); // the column as it was; a parked draft returns
  }

  // ---- Full pages (the owner's pattern: rail brief → preview → full page as a tab; the the lead and the design, 2026-10-26).
  // A module's full page is a tab in this strip next to "All rooms" and the room tabs. On a phone the strip is hidden, so
  // the same page fills the screen with a 48 px "Back to the room" bar instead (rooms.css). The page is the module's own
  // page through moduleLink: the same sandbox, nonce hello and admission as its preview.
  function openToolPage({ key, src, title, icon: glyph, binding, onDispose } = {}) {
    if (destroyed || typeof key !== 'string' || !key || !isModuleFrameSrc(src) || !st.status.signedIn) return false;
    if (toolPageOf(key)) { activate(key); return true; }
    const from = st.active; // the room it was opened from: "Back to the room" returns there
    const { frame, dispose } = moduleLink(key, src, { title, binding, onDispose, popout: false,
      isShown: () => st.active === key, close: () => closeToolPage(key) });
    const wrap = el('div', 'wr-toolpage');
    const bar = el('div', 'wr-toolpagebar');
    // on a phone the full page's way back is ONE step, to the tool's preview (the design's s10): "Back to {tool name}"
    const backWords = 'Back to ' + String(title || 'Tool').slice(0, 60);
    const back = el('button', 'wr-ib wr-toolpageback');
    back.type = 'button';
    back.title = backWords;
    back.setAttribute('aria-label', backWords);
    back.innerHTML = icon('arrow_back');
    back.addEventListener('click', () => closeToolPage(key));
    bar.append(back, el('span', 'wr-toolpaget', backWords));
    wrap.append(bar, frame);
    toolHost.appendChild(wrap);
    toolPages.push({ key, title: String(title || 'Tool').slice(0, 60), icon: /^[a-z0-9_]{1,40}$/.test(glyph || '') ? glyph : 'extension', from, wrap, dispose });
    activate(key);
    return true;
  }
  function closeToolPage(key) {
    const i = toolPages.findIndex((t) => t.key === key);
    if (i < 0) return;
    const t = toolPages[i];
    toolPages.splice(i, 1);
    t.wrap.remove();
    try { t.dispose(); } catch { /* the module host owns its own clean-up */ }
    if (destroyed) return;
    if (st.active === key) activate(st.tabs.some((x) => x.familyId === t.from) ? t.from : 'all');
    else paintStrip();
  }
  function closeAllToolPages() {
    for (const t of toolPages.splice(0)) { t.wrap.remove(); try { t.dispose(); } catch { /* gone */ } }
  }
  // the jump-to-latest button floats over the line, above the composer whatever its height
  const composerObserver = new ResizeObserver(() => { if (!destroyed) root.style.setProperty('--cmp-h', Math.round(cmp.el.getBoundingClientRect().height) + 'px'); });
  composerObserver.observe(cmp.el);
  // the composer's snackbar sits 8 px above it, bottom left, never over what you're typing
  function placeSnack(s) {
    if (s && s.style && cmp.el.isConnected) {
      const r = cmp.el.getBoundingClientRect();
      s.classList.add('wr-snack');
      s.style.left = Math.round(r.left + 12) + 'px';
      s.style.bottom = Math.round(window.innerHeight - r.top + 8) + 'px';
    }
    return s;
  }
  // W3: the lines each busy seat holds, for the line's "Held for <seat> · it's busy" [Deliver now]
  function heldMap(v) {
    const map = {};
    for (const s of seatsOf(v)) {
      const ids = (s.waiting && s.waiting.ids) || [];
      if (s.occupant && s.occupant.id && ids.length) {
        for (const id of ids) {
          map[String(id)] = { handle: s.handle, paneid: s.occupant.id };
        }
      }
    }
    return map;
  }
  function markHeld() {
    const v = viewOf(currentRoomId());
    if (v) {
      line.markHeld(heldMap(v));
    }
  }
  // the reply chip's words: who, and the start of what they said
  function replyOf(e, { authorOnly = false } = {}) {
    const mine = e.author === 'user';
    const text = String(e.body || (e.meta && e.meta.attachments && e.meta.attachments.length ? e.meta.attachments.map((a) => a.name).join(', ') : '')).replace(/\s+/g, ' ').trim();
    // C8 (the owner ): the author, then every seat the line @-names, as editable text (rules.js)
    const v = viewOf(currentRoomId());
    const seats = seatsOf(v);
    const ctx = { seats: seats.map((x) => x.handle), leadHandle: leadOf(v), me: (st.status.me && st.status.me.handle) || null, handleOfSeat: (id) => (seats.find((x) => x.id === id) || {}).handle };
    const prefill = authorOnly ? (mine || e.kind === 'fact' ? '' : prefillFor({ ...e, body: '' }, ctx)) : prefillFor(e, ctx);
    return { id: e.id, thread: e.meta?.turn?.thread ?? e.meta?.thread ?? e.thread ?? e.id, handle: mine ? 'you' : e.author, user: mine, excerpt: text.length > 80 ? text.slice(0, 80) + '…' : text, prefill };
  }

  // C9 (the design <commit>; a reviewer , ruling ): the line's "…" menu, the same three items on every line:
  // Reply (R), Copy text (the bubble's visible text, no quote header or meta line), Copy line link (#id). No edit
  // or delete: lines are append-only.
  function lineMenu(e, at, row) {
    const v = viewOf(currentRoomId());
    const mine = e.author === 'user';
    const fact = e.kind === 'fact' || e.kind === 'delivery' || e.kind === 'command';
    const who = mine ? 'You' : fact ? 'fact' : '@' + e.author;
    const color = !mine && !fact ? 'var(--md-sys-color-on-surface)' : null;
    const copy = async (text, ok) => {
      try {
        const copied = await window.wb.copyText(text);
        if (copied === false) return; // the web handler already showed the precise refusal/fallback
        deps.snackbar && deps.snackbar(ok);
      } catch (err) {
        deps.snackbar && deps.snackbar('Could not copy');
      }
    };
    const shown = () => {
      const t = row && row.querySelector('.wr-text');
      return (t ? t.textContent : fact ? e.body || '' : String(e.body || '')).trim();
    };
    if (row) {
      row.classList.add('menu-open');
    }
    const items = [
      { head: { who, color, sub: [timeWords(e.ts), 'Line #' + e.id].filter(Boolean).join(' · ') } },
      { id: 'reply', label: 'Reply', icon: 'reply', hint: 'R', fn: () => cmp.reply(replyOf(e)) },
      { id: 'copy', label: 'Copy text', icon: 'content_copy', fn: () => copy(shown(), 'Copied the text') },
      { id: 'link', label: 'Copy line link', icon: 'link', hint: '#' + e.id, fn: () => copy(lineLink(v, e.id), 'Copied the line link') },
    ];
    const m = openMenu(root, at, items);
    if (m && row) {
      const done = new MutationObserver(() => {
        if (!m.isConnected) {
          row.classList.remove('menu-open');
          done.disconnect();
        }
      });
      done.observe(root, { childList: true, subtree: true });
    }
    return m;
  }
  // the room's address with #line-<id> (briefing-table's room page opens there)
  function lineLink(v, id) {
    const base = String(st.status.origin || (st.status.server ? 'https://' + st.status.server : '')).replace(/\/+$/, '');
    const room = v && v.room ? v.room.id : currentRoomId();
    return base + '/room.html?room=' + encodeURIComponent(room) + '#line-' + id;
  }

  // C2: a seat's color is its recipe's (GET /api/recipes, `color`: the art's color wins), read once per sign-in
  // and again when a seat names a recipe not seen yet
  const recipeColors = new Map();
  let recipeAsk = 0, recipeRead = 0;
  function loadRecipeColors(force) {
    if (!force && Date.now() - recipeAsk < 30000) return;
    recipeAsk=Date.now();
    const epoch=accountEpoch, read=++recipeRead;
    window.wb.rooms.recipes().then(r=>{
      if(destroyed||epoch!==accountEpoch||read!==recipeRead||!r?.ok||!Array.isArray(r.value?.recipes))return;
      const next=new Map();
      for(const x of r.value.recipes)if(x?.id&&/^#[0-9a-f]{6}$/i.test(String(x.color||'')))next.set(x.id,x.color);
      const changed=next.size!==recipeColors.size||[...next].some(([id,color])=>recipeColors.get(id)!==color);
      recipeColors.clear();for(const [id,color]of next)recipeColors.set(id,color);
      if(changed&&st.status.signedIn){paint();line.recolor?.();cmp.recolor?.();}
    }).catch(()=>{});
  }
  function recipeColorOf(s) {
    if (!s || !s.recipe_id) {
      return null;
    }
    const c = recipeColors.get(s.recipe_id);
    if (!c) {
      loadRecipeColors(false);
    }
    return c || null;
  }
  // the seat by handle in the shown room's family (the main room's seats, then its groups')
  function familySeat(handle) {
    const id = currentRoomId();
    if (!id) {
      return null;
    }
    const fam = viewOf(familyOf(id));
    const views = fam ? [fam].concat(((fam.family && fam.family.workgroups) || []).map((g) => viewOf(g.id)).filter(Boolean)) : [viewOf(id)];
    for (const v of views) {
      const s = seatsOf(v).find((x) => x.handle === handle);
      if (s) {
        return s;
      }
    }
    return null;
  }
  setSeatColors((handle) => recipeColorOf(familySeat(handle)), {
    apply: deps.roomColors?.apply,
    seedForHandle: deps.roomColors?.seedForHandle,
    me: () => personColor(),
  });
  const seatHue = (handle) => colorOf(handle) || seatColor(Math.max(0, seatIndexOf(handle) || 0));

  // A4: your own color tints your bubbles (15 %, 22 % outline) and your initials
  const myColor = () => (st.status.me && /^#[0-9a-f]{6}$/i.test(String(st.status.me.color || '')) ? st.status.me.color : null);
  function personColor(){return myColor()||deps.roomColors?.defaultSeed?.(accountId,[...st.rooms.map(v=>v.room?.color),...recipeColors.values()]);}
  let paintedPersonSeed;
  function personAvatar(size) {
    const avatar=userPictureAvatar(resolvePictureProfile(st.status.signedIn ? st.status.me : null),size);
    const seed=personColor();
    if(seed){deps.roomColors?.apply(avatar,seed);avatar.dataset.identityPalette='true';}
    return avatar;
  }
  function paintMyColor() {
    const seed=personColor();
    if(seed!==paintedPersonSeed){paintedPersonSeed=seed;line.recolor?.();cmp.recolor?.();}
  }

  // ---- helpers over the rooms list
  const viewOf = (id) => st.rooms.find((v) => v.room && v.room.id === id) || null;
  const families = () => st.rooms.filter((v) => v.room && !v.room.parent_id && v.room.state !== 'archived');
  const hiddenIds = () => new Set((st.status.me && st.status.me.hiddenRooms) || []);
  const disconnected = id => (st.status.disconnectedRooms || []).includes(String(id));
  const familyUnread = v => (disconnected(v.room.id) ? 0 : Number(v.unread) || 0) + ((v.family && v.family.workgroups) || []).reduce((n, w) => n + (disconnected(w.id) ? 0 : Number(w.unread) || 0), 0);
  async function setConnected(id, on) {
    const epoch = accountEpoch;
    const request = window.wb.rooms.bind?.() || window.wb.rooms;
    const r = await request.connection(id, on).catch(() => null);
    if (destroyed || epoch !== accountEpoch || (request.current && !request.current())) return;
    if (!r?.ok) { deps.snackbar?.(r?.message || "Couldn't change the room connection."); return; }
    deps.snackbar?.(on ? 'Room reconnected.' : 'Room disconnected. Reconnect from its ⋯ menu.', on ? undefined : {
      action: { label: 'Undo', fn: () => { if (!destroyed && epoch === accountEpoch && (!request.current || request.current())) setConnected(id, true); } },
    });
  }
  const seatsOf = (v) => (v && Array.isArray(v.seats) ? v.seats.filter((s) => !s.left_at) : []);
  const leadOf = (v) => {
    const s = seatsOf(v).find((x) => x.is_lead || (v.room && x.id === v.room.lead_seat));
    return s ? s.handle : null;
  };
  const liveCount = (v) => seatsOf(v).filter((s) => s.status === 'live' || s.status === 'parked').length;
  const activeTab = () => st.tabs.find((t) => t.familyId === st.active) || null;
  const currentRoomId = () => (st.active === 'all' ? null : (activeTab() || {}).roomId || null);
  const canPin = () => st.width >= PIN_FROM;
  const pinned = () => canPin() && !st.unpinned;
  const wide = () => st.width >= WIDE_FROM;
  st.unpinned = isUnpinned('workrooms');
  const setUnpinned = (on) => {
    st.unpinned = !!on;
    storeUnpinned('workrooms', st.unpinned); // per window and per tab (srail.js)
    st.railOpen = false;
    paint();
  };
  // one seat, one color everywhere: its position in the family's seat order (the main
  // room's seats first, then the groups' seats not in it), the same in the cards, the rail, the line, mentions
  function seatOrder(familyId) {
    const fam = viewOf(familyId);
    const out = [];
    const push = (v) => {
      for (const s of seatsOf(v)) {
        if (!out.includes(s.handle)) {
          out.push(s.handle);
        }
      }
    };
    if (fam) {
      push(fam);
      for (const g of (fam.family && fam.family.workgroups) || []) {
        const gv = viewOf(g.id);
        if (gv) {
          push(gv);
        }
      }
    }
    return out;
  }
  function familyOf(roomId) {
    const v = viewOf(roomId);
    return v && v.room ? v.room.parent_id || v.room.id : roomId;
  }
  /** What an @word names: 'you' | 'room' | 'lead' | 'alias' (a family room) | null (a seat, or nothing). */
  function addressKindOf(handle) {
    const h = String(handle || '').toLowerCase();
    const me = st.status.me && st.status.me.handle ? String(st.status.me.handle).toLowerCase() : null;
    if (h === 'user' || (me && h === me)) {
      return 'you';
    }
    if (h === 'room' || h === 'lead') {
      return h;
    }
    const v = viewOf(currentRoomId());
    const fam = v && v.room ? viewOf(familyOf(v.room.id)) : null;
    const rooms = fam ? [fam.room, ...((fam.family && fam.family.workgroups) || [])] : [];
    return rooms.some((r) => r && r.alias && r.alias.toLowerCase() === h) ? 'alias' : null;
  }
  function seatIndexOf(handle, roomId) {
    const id = roomId || currentRoomId();
    if (!id) {
      return null;
    }
    const i = seatOrder(familyOf(id)).indexOf(String(handle || '').replace(/^@/, ''));
    return i >= 0 ? i : null;
  }
  const serverName = () => st.status.serverName || st.status.server;

  function saveTabs() {
    try {
      localStorage.setItem(tabsKey(), JSON.stringify({ tabs: st.tabs, active: st.active }));
    } catch (e) {
      // not remembered
    }
  }
  function loadTabs() {
    try {
      const j = JSON.parse(localStorage.getItem(tabsKey()) || 'null');
      if (j && Array.isArray(j.tabs)) {
        st.tabs = j.tabs.filter((t) => t && t.familyId).map((t) => ({ familyId: String(t.familyId), roomId: String(t.roomId || t.familyId) }));
        st.active = j.active && st.tabs.some((t) => t.familyId === j.active) ? j.active : 'all';
      }
    } catch (e) {
      st.tabs = [];
    }
  }

  function tellVisible() {
    syncTemplates();
    window.wb.rooms.visible(st.shown && st.status.signedIn && !disconnected(currentRoomId()), st.shown ? currentRoomId() : null);
  }

  // ---- the strip
  function plateEl(v, size) {
    // A family folder summarizes its known workgroups as well as its own
    // seats. Only authorized, account-scoped views already in this page count.
    const members = new Map();
    for (const view of [v, ...((v?.family?.workgroups || []).map(g => viewOf(g.id)))]) {
      for (const seat of seatsOf(view)) members.set(seat.id, seat);
    }
    return roomPalette(roomGlyph([...members.values()], size, disconnected(v?.room?.id)),v);
  }
  function paintStrip() {
    strip.textContent = '';
    const all = el('button', 'wr-tab all' + (st.active === 'all' ? ' on' : ''));
    all.type = 'button';
    all.setAttribute('role', 'tab');
    all.setAttribute('aria-selected', String(st.active === 'all'));
    all.innerHTML = icon('grid_view');
    const visibleFamilies = families().filter((v) => !hiddenIds().has(v.room.id));
    all.appendChild(el('span', 'al', 'All rooms'));
    all.appendChild(el('span', 'n', String(visibleFamilies.length)));
    all.title = 'All rooms';
    all.addEventListener('click', () => activate('all'));
    strip.appendChild(all);
    const narrow = st.width < WIDE_FROM;
    for (const t of st.tabs) {
      const v = viewOf(t.familyId);
      if (!v) {
        continue;
      }
      const b = el('button', 'wr-tab' + (st.active === t.familyId ? ' on' : ''));
      b.type = 'button';
      b.dataset.family = t.familyId;
      roomPalette(b,v);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(st.active === t.familyId));
      b.appendChild(plateEl(v, 16));
      const full = v.room.name;
      b.appendChild(el('span', 'al', narrow && st.active !== t.familyId ? full.split(/\s+/)[0] : full));
      b.title = full;
      const n = familyUnread(v);
      if (n > 0 && st.active !== t.familyId) {
        b.appendChild(el('span', 'wr-badge', String(n)));
      }
      const x = el('button', 'wr-tabx');
      x.type = 'button';
      x.title = 'Close tab';
      x.setAttribute('aria-label', 'Close tab');
      x.innerHTML = icon('close');
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(t.familyId);
      });
      b.appendChild(x);
      b.addEventListener('click', () => activate(t.familyId));
      b.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          closeTab(t.familyId); // "Middle-click closes"
        }
      });
      strip.appendChild(b);
    }
    for (const t of toolPages) {
      const b = el('button', 'wr-tab wr-tooltab' + (st.active === t.key ? ' on' : ''));
      b.type = 'button';
      b.dataset.toolpage = t.key;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(st.active === t.key));
      b.innerHTML = icon(t.icon);
      b.appendChild(el('span', 'al', t.title));
      b.title = t.title;
      const x = el('button', 'wr-tabx');
      x.type = 'button';
      x.title = 'Close tab';
      x.setAttribute('aria-label', 'Close tab');
      x.innerHTML = icon('close');
      x.addEventListener('click', (e) => { e.stopPropagation(); closeToolPage(t.key); });
      b.appendChild(x);
      b.addEventListener('click', () => activate(t.key));
      b.addEventListener('auxclick', (e) => { if (e.button === 1) closeToolPage(t.key); });
      strip.appendChild(b);
    }
  }

  function openRoom(familyId, roomId) {
    if (destroyed) return;
    let t = st.tabs.find((x) => x.familyId === familyId);
    if (!t) {
      t = { familyId, roomId: roomId || familyId };
      st.tabs.push(t);
    } else if (roomId) {
      t.roomId = roomId;
    }
    activate(familyId);
  }
  function closeTab(familyId) {
    const i = st.tabs.findIndex((x) => x.familyId === familyId);
    if (i < 0) {
      return;
    }
    const wasActive = st.active === familyId;
    st.tabs.splice(i, 1);
    if (wasActive) {
      invalidateStarterSettings();
      closeInlineTerminal(false);
      const next = st.tabs[i] || st.tabs[i - 1];
      st.active = next ? next.familyId : 'all';
    }
    saveTabs();
    paint();
    if (wasActive) openLine();
  }
  function activate(which) {
    if (destroyed) return;
    invalidateStarterSettings();
    closeInlineTerminal(false);
    st.active = which;
    if(which==='all')void starter?.shown(null);
    st.railOpen = false;
    if (which !== 'all') {
      st.newForMe.delete(which);
    }
    saveTabs();
    paint();
    openLine();
  }

  // ---- All rooms
  function paintGrid() {
    const finding = typeof document !== 'undefined' && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('wr-gfin') ? { at: document.activeElement.selectionStart } : null; // a repaint keeps the person typing in the find field
    if(!agentGrid || agentGrid.parentElement!==main)main.textContent = '';
    main.className = 'wr-main grid';
    const page = el('div', agentGrid ? '' : 'wr-grid');
    const mountGrid=()=>{if(agentGrid){agentListing.replaceChildren(page);if(agentGrid.parentElement!==main)main.appendChild(agentGrid);}else main.appendChild(page);};
    const hidden = hiddenIds();
    if(starter&&canUseStarter())page.appendChild(starter.grid({rooms:st.rooms,hiddenIds:hidden,showHidden:st.showHidden,disconnectedIds:new Set(st.status.disconnectedRooms||[]),fresh:st.status.signedIn&&st.status.conn==='live'}));
    const fams = families();
    if (placeFilter !== 'all' && placeFilter !== 'local' && !localState()?.servers.some(server => server.id === placeFilter)) placeFilter = 'all';
    // W3: archived rooms sit with the hidden ones (the design #w3: "You can reopen it from Hidden rooms")
    const archivedFams = st.rooms.filter((v) => v.room && !v.room.parent_id && v.room.state === 'archived');
    const shown = fams
      .filter(v=>!canUseStarter()||!starter?.knownRootIds().includes(v.room.id))
      .filter((v) => (st.showHidden ? true : !hidden.has(v.room.id)))
      .concat(st.showHidden ? archivedFams : [])
      .filter(v => placeFilter === 'all' || placeOf(v.room.id) === placeFilter)
      .sort((a, b) => (b.room.last_active_at || 0) - (a.room.last_active_at || 0));
    const nHidden = fams.filter((v) => hidden.has(v.room.id)).length + archivedFams.length;
    const head = el('div', 'wr-gh');
    head.appendChild(el('h4', null, 'Rooms'));
    const right = el('div', 'wr-ghr');
    if (nHidden) {
      const h = el('span', 'wr-hid');
      const link = el('button', 'wr-link');
      link.type = 'button';
      if (st.showHidden) {
        h.appendChild(document.createTextNode('Showing ' + nHidden + ' hidden · '));
        link.textContent = 'Hide them';
      } else {
        h.appendChild(document.createTextNode(nHidden + ' hidden · '));
        link.textContent = 'Show';
      }
      link.addEventListener('click', () => {
        st.showHidden = !st.showHidden;
        paintGrid();
      });
      h.appendChild(link);
      right.appendChild(h);
    }
    if (fams.length) {
      // with no rooms the centered button is the one
      const nb = el('button', 'wr-outl');
      nb.type = 'button';
      nb.innerHTML = icon('add');
      nb.appendChild(document.createTextNode('New room'));
      nb.addEventListener('click', () => newRoom());
      right.appendChild(nb);
    }
    head.appendChild(right);
    if(!agentGrid)page.appendChild(head);
    else {right.hidden=!agentHost.hidden;agentGrid.children[0].replaceChildren(...Array.from(head.children));}
    const locations = localState();
    if (locations?.servers.length && locations.localRooms.status !== 'running') {
      const localNotice = el('section'); page.appendChild(localNotice); deps.renderLocalStatus?.(localNotice, locations);
    }
    if (locations?.servers.length) {
      const filters = el('div', 'lf-segments'); filters.setAttribute('aria-label', 'Room location');
      for (const place of [{id:'all',name:'All'},{id:'local',name:globalThis.wb&&globalThis.wb.web?'This server':'This computer'}, ...locations.servers]) {
        const b = el('button', 'lf-button text', place.name); b.type = 'button';
        b.setAttribute('aria-pressed', String(placeFilter === place.id));
        b.addEventListener('click', () => { placeFilter = place.id; paintGrid(); }); filters.appendChild(b);
      }
      page.appendChild(filters);
    }

    if(templateHost)page.appendChild(templateHost);
    if (!fams.length) {
      const empty = el('div', 'wr-empty');
      empty.innerHTML = icon('forum');
      empty.appendChild(el('div', 'wr-et', WORDS.noRooms));
      empty.appendChild(el('div', 'wr-eb', WORDS.noRoomsBody));
      const b = el('button', 'wr-filled');
      b.type = 'button';
      b.innerHTML = icon('add');
      b.appendChild(document.createTextNode('New room'));
      b.addEventListener('click', () => newRoom());
      empty.appendChild(b);
      page.appendChild(empty);
      mountGrid();
      return;
    }
    // under 600 px there is no rail to search: a field at the very top of the list finds a room by name, then a seat by name (the design s11)
    let findBox = null, findResults = null;
    if (st.width < 600 && fams.length) {
      findBox = el('div', 'wr-gfind');
      const input = el('input', 'wr-gfin');
      input.type = 'search'; input.placeholder = 'Find a room or seat'; input.value = gridQuery;
      input.setAttribute('aria-label', 'Find a room or seat'); input.autocomplete = 'off'; input.spellcheck = false;
      const clear = el('button', 'wr-ib wr-gclear');
      clear.type = 'button'; clear.title = 'Clear'; clear.setAttribute('aria-label', 'Clear'); clear.innerHTML = icon('close'); clear.hidden = !gridQuery;
      findBox.append(el('span', 'wr-gfic', ''), input, clear);
      findBox.firstChild.innerHTML = icon('search');
      findResults = el('div', 'wr-gres'); findResults.setAttribute('aria-live', 'polite');
      const paintResults = () => {
        const q = gridQuery.trim().toLowerCase();
        clear.hidden = !gridQuery;
        findResults.replaceChildren();
        cardsWrap.hidden = !!q;
        if (!q) return;
        const rooms = shown.filter((v) => String(v.room.name || '').toLowerCase().includes(q));
        const seatHits = [];
        for (const v of shown) for (const x of seatsOf(v)) if (String(x.handle || '').toLowerCase().includes(q)) seatHits.push({ v, x });
        if (!rooms.length && !seatHits.length) { findResults.appendChild(el('div', 'wr-gnone', 'No room or seat matches \u201c' + gridQuery.trim() + '\u201d.')); return; }
        for (const v of rooms) findResults.appendChild(card(v, hidden.has(v.room.id) || v.room.state === 'archived'));
        for (const { v, x } of seatHits) {
          const b = el('button', 'wr-gseat');
          b.type = 'button'; b.dataset.seat = x.handle; b.dataset.room = v.room.id;
          b.append(el('span', 'wr-gsn', '@' + x.handle + ' \u00b7 ' + v.room.name));
          b.addEventListener('click', () => { gridQuery = ''; openRoom(v.room.id); });
          findResults.appendChild(b);
        }
      };
      input.addEventListener('input', () => { gridQuery = input.value; paintResults(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && gridQuery) { e.stopPropagation(); gridQuery = ''; input.value = ''; paintResults(); } });
      clear.addEventListener('click', () => { gridQuery = ''; input.value = ''; paintResults(); input.focus(); });
      findBox.paint = paintResults;
    }
    const cardsWrap = el('div', 'wr-cardswrap');
    const cards = el('div', 'wr-cards');
    for (const v of shown) {
      cards.appendChild(card(v, hidden.has(v.room.id) || v.room.state === 'archived'));
    }
    const nc = el('div', 'wr-card new');
    nc.innerHTML = icon('add');
    nc.appendChild(el('div', 'wr-nct', 'New room'));
    nc.appendChild(el('div', 'wr-ncs', 'name it, choose agents'));
    nc.addEventListener('click', () => newRoom());
    cards.appendChild(nc);
    cardsWrap.appendChild(cards);
    if (findBox) { page.prepend(findResults); page.prepend(findBox); }
    page.appendChild(cardsWrap);
    mountGrid();
    if (findBox) { findBox.paint(); if (finding) { const i = findBox.querySelector('.wr-gfin'); i.focus(); try { i.setSelectionRange(finding.at, finding.at); } catch { /* none */ } } }
  }
  function card(v, isHidden) {
    const off = disconnected(v.room.id);
    const c = el('div', 'wr-card' + (isHidden ? ' hidden' : '') + (off ? ' disconnected' : ''));
    c.dataset.room = v.room.id;
    const band = el('div', 'wr-band');
    roomPalette(band,v);
    band.appendChild(plateEl(v, 36));
    const tx = el('div', 'wr-bt');
    tx.appendChild(el('div', 'wr-bn', v.room.name));
    const seats = seatsOf(v);
    const lead = leadOf(v);
    const live = liveCount(v);
    // P01 (the design s12): the family's seats that need you: "@{seat} needs you" in the line, the chip "Needs you · {n}" with its icon
    // (needs-you.js seatNeedsYou's test, inline: desktop tests load page.js as bare source)
    const needsYouSeat = (s) => { const o = s && s.status === 'live' ? s.occupant : null; return !!o && (o.state == null || o.state === 'live') && (!!o.blocked || o.activity === 'waiting' || o.activity === 'waiting-seen'); };
    const waiting = off ? [] : [v, ...((v.family && v.family.workgroups) || []).map((g) => viewOf(g.id)).filter(Boolean)].flatMap((x) => seatsOf(x).filter(needsYouSeat));
    tx.appendChild(el('div', 'wr-bs', (off ? 'Disconnected · ' : '') + seats.length + (seats.length === 1 ? ' seat' : ' seats') + (off ? '' : waiting.length ? ' · @' + waiting[0].handle + ' needs you' : lead ? ' · lead @' + lead : live ? '' : ', none live')));
    appendLocation(tx, v.room);
    band.appendChild(tx);
    const archived = v.room.state === 'archived';
    if (isHidden) {
      band.appendChild(el('span', 'wr-tag', archived ? 'Archived' : 'Hidden'));
    }
    if (waiting.length && !isHidden) {
      const chip = el('span', 'wr-needschip');
      chip.innerHTML = icon('priority_high');
      chip.appendChild(document.createTextNode('Needs you · ' + waiting.length));
      band.appendChild(chip);
    }
    const n = familyUnread(v);
    if (n > 0 && !isHidden && !off) {
      band.appendChild(el('span', 'wr-badge big', String(n)));
    }
    c.appendChild(band);
    const content = el('div', 'wr-cc');
    const groups = (v.family && v.family.workgroups) || [];
    if (groups.length) {
      const chips = el('div', 'wr-chips');
      for (const g of groups) {
        const ch = el('button', 'wr-gchip');
        ch.type = 'button';
        const sq = el('span', 'sq');
        roomPalette(ch,viewOf(g.id)||g);
        sq.style.background = 'var(--md-sys-color-primary)';
        ch.append(sq, document.createTextNode(g.name));
        ch.title = 'Open ' + v.room.name + ' at ' + g.name;
        ch.addEventListener('click', (e) => {
          e.stopPropagation();
          openRoom(v.room.id, g.id); // "A workgroup chip opens the room straight at that group"
        });
        chips.appendChild(ch);
      }
      content.appendChild(chips);
    }
    if (seats.length && !off) {
      // The same vendor/lifecycle glyph as the seat rail, at card-preview size.
      const who = el('div', 'wr-who');
      seats.slice(0, 4).forEach((s) => {
        const m = seatGlyph(s, !!(s.is_lead || s.id === v.room.lead_seat), 24);
        m.classList.add('wr-cardseat');
        m.title = '@' + s.handle;
        who.appendChild(m);
      });
      if (seats.length > 4) {
        who.appendChild(el('span', 'wr-markmore', '+' + (seats.length - 4))); // at most 4, then "+N"
      }
      content.appendChild(who);
    }
    if (!off && v.last && (v.last.text || v.last.author)) {
      const l = el('div', 'wr-last');
      if (v.last.author === 'room') {
        l.textContent = v.last.text || ''; // the room's own line (a fact) has no sender
      } else {
        const a = el('b', null, v.last.author === 'user' ? 'You' : '@' + v.last.author);
        l.append(a, document.createTextNode(' ' + (v.last.text || '')));
      }
      content.appendChild(l);
    } else if (isHidden && !off) {
      content.appendChild(el('div', 'wr-last', 'No messages yet'));
    }
    c.appendChild(content);
    const foot = el('div', 'wr-cf');
    const archived0 = v.room.state === 'archived';
    const reopen = async () => {
      const r = await window.wb.rooms.state(v.room.id, 'reopen');
      if (!r || !r.ok) {
        deps.snackbar && deps.snackbar((r && r.message) || "Couldn't reopen it.");
      }
    };
    const open = el('button', 'wr-outl');
    open.type = 'button';
    // an archived room can't be opened until it's reopened: [Reopen] in place of [Open room]
    open.textContent = archived0 ? 'Reopen' : 'Open room';
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      if (archived0) {
        reopen();
      } else {
        openRoom(v.room.id);
      }
    });
    const more = el('button', 'wr-ib');
    more.type = 'button';
    more.title = archived ? 'More' : isHidden ? 'Unhide' : 'Hide';
    more.setAttribute('aria-label', 'Room options');
    more.innerHTML = icon('more_horiz');
    more.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (archived) {
        // the ⋯ stays a menu: Reopen is its one item (a bare ⋯ that acts is a trap)
        const b = more.getBoundingClientRect();
        openMenu(root, { x: b.right - 180, y: b.bottom + 2 }, [{ id: 'reopen', label: 'Reopen', icon: 'unarchive', fn: reopen }]);
        return;
      }
      toggleHidden(v.room.id, !isHidden);
    });
    foot.append(open, more);
    c.appendChild(foot);
    c.addEventListener('dblclick', () => {
      if (!archived0) {
        openRoom(v.room.id);
      }
    });
    return c;
  }
  async function toggleHidden(id, hide) {
    const set = new Set(hiddenIds());
    if (hide) {
      set.add(id);
    } else {
      set.delete(id);
    }
    const r = await window.wb.rooms.me({ hiddenRooms: [...set] });
    if (r && r.ok && r.value) {
      st.status.me = { ...(st.status.me || {}), hiddenRooms: r.value.hiddenRooms || [...set] };
      paint();
    }
  }

  // ---- a room
  function paintRoom() {
    if (destroyed) return;
    if (toolPageOf(st.active)) return; // a full page is shown: no room view to paint (paint() owns that switch)
    if(templateHost)root.insertBefore(templateHost,bodyRow);
    const t = activeTab();
    const fam = t && viewOf(t.familyId);
    const v = t && (viewOf(t.roomId) || fam);
    if (inlineView && (!v || inlineView.roomId !== v.room.id || !seatsOf(v).some(s => s.id === inlineView.seatId))) closeInlineTerminal(false);
    roomHead.hidden = !st.status.signedIn || !t || !fam || !v;
    // a repaint replaces the header's buttons: focus the person had on one of them (Seats, Chats, Tools, Search, Filter, ⋯) moves to its new twin, so a sheet's
    // "focus returns to the button" is not lost when a poll repaints in between
    const hadFocus = typeof document !== 'undefined' && document.activeElement && document.activeElement.classList && roomHead.contains && roomHead.contains(document.activeElement)
      ? ['wr-seatsb', 'wr-chatsb', 'wr-toolsb', 'wr-searchb', 'wr-filterb', 'wr-more'].find((c) => document.activeElement.classList.contains(c)) : null;
    roomHead.replaceChildren(...(roomHead.hidden ? [] : [headerEl(v)]));
    if (hadFocus) { const again = roomHead.querySelector('.' + hadFocus + ':not([hidden])'); if (again) again.focus({ preventScroll: true }); }
    if (toolsSheet?.isOpen() && (roomHead.hidden || !v)) toolsSheet.close(false);
    if (seatsSheet?.isOpen()) { if (roomHead.hidden || !v || disconnected(v.room.id)) seatsSheet.close(); else seatsSheet.refresh(); }
    if (chatsSheet?.isOpen()) { if (roomHead.hidden || !v) chatsSheet.close(false); else chatsSheet.refresh(); }
    if (v && disconnected(v.room.id)) {
      closeInlineTerminal(false);
      line.setVisible?.(false);
      line.clear();
      cmp.close({ save: false });
      cmp.el.remove(); cmp.drop.remove();
      side.suspend?.(); viewer.hide();
      main.className = 'wr-main room'; main.dataset.room = v.room.id;
      const empty = el('div', 'wr-empty wr-disconnected');
      empty.append(el('h2', '', 'Disconnected'), el('p', '', "This room's live connection is closed, so nothing here updates. Your messages and files are kept."));
      const reconnect = el('button', 'wr-filled', 'Reconnect room');
      reconnect.type = 'button'; reconnect.addEventListener('click', () => setConnected(v.room.id, true));
      empty.append(reconnect); main.replaceChildren(empty);
      tintMain(v, fam); paintRail(fam, v);
      return;
    }
    if (t && fam && v && main.dataset.room === v.room.id && main.firstChild && main.firstChild.classList.contains('wr-roomcol')) {
      // the same room: new header and strip in place; the line and the composer stay put (focus, caret, scroll)
      const col = main.firstChild;
      if (st.shown && line.el.parentElement !== col) col.append(line.el, line.jump, thinkRow, cmp.el, cmp.drop);
      col.replaceChild(stripEl(), col.children[0]);
      col.replaceChild(toolsEl(v), col.children[1]);
      tintMain(v, fam);
      paintRail(fam, v);
      mountInlineTerminal(col);
      return;
    }
    main.textContent = '';
    main.className = 'wr-main room';
    main.dataset.room = '';
    if (!t || !fam || !v) {
      rail.hidden = true;
      main.appendChild(el('div', 'wr-gone', 'This room is gone.'));
      return;
    }
    main.dataset.room = v.room.id;
    const col = el('div', 'wr-roomcol');
    col.appendChild(stripEl());
    col.appendChild(toolsEl(v));
    tintMain(v, fam);
    line.setFilter(filterFn(v.room.id));
    line.setShowClosedFloor(!!filterOf(v.room.id).closedFloor);
    if (st.shown) { col.appendChild(line.el); col.appendChild(line.jump); }
    col.appendChild(thinkRow);
    col.appendChild(cmp.el);
    col.appendChild(cmp.drop);
    main.appendChild(col);
    mountInlineTerminal(col);
    paintRail(fam, v);
  }
  // One pane palette owns the room area. System controls and message content
  // are explicitly re-pinned so they cannot inherit a room's identity.
  function tintMain(v, fam) {
    const seed=roomSeed(v);
    main.classList.toggle('tint',!!seed);
    roomPalette(root,v);
    systemPalette(line.el); systemPalette(side.el); systemPalette(thinkRow); systemPalette(viewer.el);
    for(const selector of ['.wr-ib','.wr-cib','.wr-act','.wr-filled'])for(const button of root.querySelectorAll(selector))systemPalette(button);
    for(const button of cmp.el.querySelectorAll('button'))systemPalette(button);
    const field=cmp.el.querySelector('.wr-ci'),send=cmp.el.querySelector('.wr-send');
    roomPalette(field,v);roomPalette(send,v);
  }

  // ---- C7: who is thinking about your message. One chip per seat above
  // the message box, its avatar (24 px) with a turning ring and its handle in its color, on only while all three
  // hold: the seat has seen your newest line (reads[handle] === 'seen'), it is working (occupant.activity ===
  // 'streaming', read on the room poll), and it has written nothing since yours. The seat's avatar in the line keeps
  // a ring meanwhile.
  const thinkRow = el('div', 'wr-think');
  thinkRow.hidden = true;
  function thinkingSeats() {
    const id = currentRoomId();
    const v = id && viewOf(id);
    if (!v) {
      return [];
    }
    const entries = line.state().roomId === id ? line.entries() : [];
    let mine = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].author === 'user' && !entries[i].pending) {
        mine = entries[i];
        break;
      }
    }
    if (!mine) {
      return [];
    }
    return seatsOf(v).filter((x) => {
      const o = x.occupant || null;
      if (!o || o.activity !== 'streaming' || !mine.reads || mine.reads[x.handle] !== 'seen') {
        return false;
      }
      return !entries.some((e) => e.id > mine.id && (e.author === x.handle || (e.author_seat && e.author_seat === x.id)));
    });
  }
  function paintThinking() {
    const seats = thinkingSeats();
    const key = seats.map((x) => x.handle).join(',');
    line.setWorking(new Set(seats.map((x) => x.handle)));
    if (thinkRow.dataset.key === key) {
      return;
    }
    thinkRow.dataset.key = key;
    thinkRow.textContent = '';
    thinkRow.hidden = !seats.length;
    const order = seatOrder(familyOf(currentRoomId()));
    for (const x of seats) {
      const c = el('span', 'wr-thinkc');
      const color = colorOf(x.handle) || seatColor(Math.max(0, order.indexOf(x.handle)));
      c.style.setProperty('--c', color);
      c.title = x.handle + ' is working on your message';
      c.setAttribute('role', 'status');
      const av = el('span', 'wr-thinka');
      av.appendChild(avatarEl(x.handle, 24, Math.max(0, order.indexOf(x.handle))));
      c.append(av, el('span', 'wr-thinkh', '@' + x.handle));
      thinkRow.appendChild(c);
    }
  }

  // ---- C3: search in this room and the filter (the design's "Search and filter", u1 and u2)
  const finds = new Map(); // roomId -> { open, q, results, more, loading, error, at }
  const filters = new Map(); // roomId -> { kinds: Set, from: 'all' | 'me' | seat id }
  const KINDS = [
    ['messages', 'Messages', (e) => e.kind === 'chat'],
    ['floor', 'Floor and joins', (e) => e.kind === 'fact'],
    ['delivery', 'Delivery notes', (e) => e.kind === 'delivery'],
    ['attachments', 'Attachments', (e) => e.kind === 'attachment'],
    ['commands', 'Commands', (e) => e.kind === 'command'],
    ['voice', 'Voice', (e) => e.kind === 'voice'],
  ];
  const findOf = (id = currentRoomId()) => {
    if (!finds.has(id)) {
      finds.set(id, { open: false, q: '', results: null, more: false, loading: false, error: null, at: -1 });
    }
    return finds.get(id);
  };
  const filterOf = (id = currentRoomId()) => {
    if (!filters.has(id)) {
      filters.set(id, { kinds: new Set(KINDS.map((k) => k[0])), from: 'all', closedFloor: false });
    }
    return filters.get(id);
  };
  const filterOn = (id) => {
    const f = filterOf(id);
    return f.from !== 'all' || f.kinds.size !== KINDS.length || !!f.closedFloor;
  };
  function filterFn(id) {
    if (!filterOn(id)) {
      return null;
    }
    const f = filterOf(id);
    const v = viewOf(id);
    return (e) => {
      const k = KINDS.find((x) => x[2](e));
      if (k && !f.kinds.has(k[0])) {
        return false;
      }
      if (f.from === 'me') {
        return isToMe(e, st.status.me && st.status.me.handle); // C10: the person's "To me" (ROOMS-API §4.10): a quote never counts
      }
      if (f.from !== 'all') {
        const seat = seatsOf(v).find((x) => x.id === f.from);
        return e.author_seat === f.from || e.target_seat === f.from || (!!seat && (e.author === seat.handle || e.target === seat.handle));
      }
      return true;
    };
  }
  function filterWords(id) {
    const f = filterOf(id);
    const parts = [];
    if (f.from === 'me') {
      parts.push('To me');
    } else if (f.from !== 'all') {
      const s = seatsOf(viewOf(id)).find((x) => x.id === f.from);
      parts.push('@' + (s ? s.handle : 'seat'));
    }
    if (f.closedFloor) {
      parts.push('Closed floor lines');
    }
    if (f.kinds.size !== KINDS.length) {
      const off = KINDS.filter((k) => !f.kinds.has(k[0]));
      if (off.length === 1) {
        parts.push('all but ' + off[0][1]); // the design , 5
      } else {
        parts.push(...KINDS.filter((k) => f.kinds.has(k[0])).map((k) => k[1]));
      }
      if (!f.kinds.size) {
        parts.push('Nothing');
      }
    }
    return 'Showing: ' + parts.join(' · ');
  }
  function applyFilter(id) {
    line.setFilter(filterFn(id));
    line.setShowClosedFloor(!!filterOf(id).closedFloor); // C11: off by default
    paintRoom();
  }
  // the row under the header: the find bar (and its results), then the filter's chip
  function toolsEl(v) {
    const box = el('div', 'wr-tools');
    const id = v.room.id;
    const f = findOf(id);
    if (f.open) {
      const bar = el('div', 'wr-find');
      const fld = el('label', 'wr-findf');
      fld.innerHTML = icon('search');
      const inp = el('input', 'wr-findi');
      inp.type = 'search';
      inp.placeholder = 'Search ' + v.room.name;
      inp.setAttribute('aria-label', 'Search ' + v.room.name);
      inp.value = f.q;
      fld.appendChild(inp);
      bar.appendChild(fld);
      const cnt = el('span', 'wr-findn', f.loading ? 'Searching…' : f.results ? (f.more ? '200+ results · showing the newest 200' : f.results.length + (f.results.length === 1 ? ' result' : ' results')) : '');
      bar.appendChild(cnt);
      const step = (ic, title, d) => {
        const b = el('button', 'wr-ib');
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = icon(ic);
        b.disabled = !f.results || !f.results.length;
        b.addEventListener('click', () => pickResult(id, f.at + d));
        return b;
      };
      bar.append(step('keyboard_arrow_up', 'Newer', -1), step('keyboard_arrow_down', 'Older', 1));
      const x = el('button', 'wr-ib wr-findx');
      x.type = 'button';
      x.title = 'Close search';
      x.setAttribute('aria-label', 'Close search');
      x.innerHTML = icon('close');
      x.addEventListener('click', () => closeFind());
      bar.appendChild(x);
      inp.addEventListener('input', () => {
        f.q = inp.value;
        clearTimeout(f.timer);
        f.timer = setTimeout(() => runFind(id), 250);
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeFind();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(f.timer);
          if (f.results && f.q === f.ran) {
            pickResult(id, f.at + (e.shiftKey ? -1 : 1));
          } else {
            runFind(id);
          }
        } else if (e.key === 'ArrowDown' && f.results && f.results.length) {
          e.preventDefault();
          const first = box.querySelector('.wr-findr');
          if (first) {
            first.focus();
          }
        }
      });
      box.appendChild(bar);
      if (f.results && f.showList) {
        const list = el('div', 'wr-findl');
        list.setAttribute('role', 'listbox');
        list.appendChild(el('div', 'wr-findlh', f.results.length ? (f.more ? '200+ results · showing the newest 200' : f.results.length + (f.results.length === 1 ? ' result' : ' results')) : 'No results for ' + f.ran));
        f.results.forEach((r, i) => {
          const b = el('button', 'wr-findr' + (i === f.at ? ' on' : ''));
          b.type = 'button';
          b.setAttribute('role', 'option');
          const plain = (r.snippet || []).map((x) => x.t).join('');
          const who = r.author === 'user' ? 'You' : r.kind === 'fact' ? (/has the floor|turn is next/.test(plain) ? 'floor line' : 'fact') : r.author;
          b.appendChild(el('span', 'wr-findw', [who, timeWords(r.ts)].filter(Boolean).join(' · ')));
          const sn = el('span', 'wr-finds');
          for (const part of r.snippet || []) {
            sn.appendChild(part.hit ? el('mark', null, part.t) : document.createTextNode(part.t));
          }
          b.appendChild(sn);
          b.addEventListener('click', () => pickResult(id, i));
          b.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const all = [...list.querySelectorAll('.wr-findr')];
              const n = all[all.indexOf(b) + (e.key === 'ArrowDown' ? 1 : -1)];
              (n || inp).focus();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              f.showList = false;
              paintRoom();
              const again = main.querySelector('.wr-findi');
              if (again) {
                again.focus();
              }
            }
          });
          list.appendChild(b);
        });
        box.appendChild(list);
      }
      if (f.focus) {
        f.focus = false;
        requestAnimationFrame(() => {
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        });
      }
    }
    if (filterOn(id)) {
      const chip = el('div', 'wr-fchip');
      chip.appendChild(el('span', null, filterWords(id)));
      const x = el('button', 'wr-fchipx');
      x.type = 'button';
      x.title = 'Show everything';
      x.setAttribute('aria-label', 'Show everything');
      x.innerHTML = icon('close');
      x.addEventListener('click', () => {
        filters.delete(id);
        applyFilter(id);
      });
      chip.appendChild(x);
      box.appendChild(chip);
    }
    return box;
  }
  function openFind() {
    const id = currentRoomId();
    if (!id) {
      return;
    }
    const f = findOf(id);
    f.open = true;
    f.focus = true;
    paintRoom();
  }
  function closeFind() {
    const id = currentRoomId();
    finds.delete(id);
    line.clearRing();
    paintRoom();
    cmp.focus();
  }
  async function runFind(id) {
    if (destroyed || !st.shown || id !== currentRoomId()) return;
    const epoch = accountEpoch, token = lineToken;
    const f = findOf(id);
    const q = f.q.trim();
    if (!q) {
      f.results = null;
      f.ran = '';
      f.showList = false;
      paintRoom();
      return;
    }
    f.loading = true;
    f.ran = f.q;
    paintRoom();
    const r = await window.wb.rooms.search(id, q, 200);
    if (destroyed || !st.shown || epoch !== accountEpoch || token !== lineToken || id !== currentRoomId() || finds.get(id) !== f || f.q !== f.ran) {
      return; // typed on meanwhile
    }
    f.loading = false;
    f.results = r && r.ok && r.value && Array.isArray(r.value.results) ? r.value.results : [];
    f.more = f.results.length >= 200;
    f.at = -1;
    f.showList = true;
    if (!r || !r.ok) {
      deps.snackbar && deps.snackbar((r && r.message) || "Couldn't search this room.");
    }
    paintRoom();
    const again = main.querySelector('.wr-findi');
    if (again && document.activeElement !== again) {
      again.focus();
    }
  }
  async function pickResult(id, i) {
    const f = findOf(id);
    if (!f.results || !f.results.length) {
      return;
    }
    f.at = Math.max(0, Math.min(f.results.length - 1, i));
    f.showList = false;
    const r = f.results[f.at];
    paintRoom();
    const ok = await line.reveal(r.id);
    if (!ok) {
      deps.snackbar && deps.snackbar('That line is no longer in this room.');
    }
  }
  // the filter (the funnel): Show by kind, From Everyone · To me · a seat; [Reset] [Done]
  function openFilter(anchor, v) {
    const id = v.room.id;
    const cur = filterOf(id);
    const draft = { kinds: new Set(cur.kinds), from: cur.from, closedFloor: !!cur.closedFloor };
    closePageMenus();
    const pop = el('div', 'wr-menu wr-pmenu wr-filter');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Filter');
    pop.dataset.level = '0';
    const sec = (t) => pop.appendChild(el('div', 'wr-filterh', t));
    const paint = () => {
      for (const b of pop.querySelectorAll('[data-kind]')) {
        const on = b.dataset.kind === 'closedfloor' ? draft.closedFloor : draft.kinds.has(b.dataset.kind);
        b.setAttribute('aria-checked', String(on));
        b.querySelector('.ms').textContent = on ? 'check_box' : 'check_box_outline_blank';
      }
      for (const b of pop.querySelectorAll('[data-from]')) {
        const on = draft.from === b.dataset.from;
        b.setAttribute('aria-checked', String(on));
        b.querySelector('.ms').textContent = on ? 'radio_button_checked' : 'radio_button_unchecked';
      }
    };
    sec('Show');
    for (const [k, label] of KINDS) {
      const b = el('button', 'wr-menui');
      b.type = 'button';
      b.dataset.kind = k;
      b.setAttribute('role', 'menuitemcheckbox');
      b.innerHTML = icon('check_box');
      b.appendChild(el('span', 'wr-menut', label));
      b.addEventListener('click', () => {
        if (draft.kinds.has(k)) {
          draft.kinds.delete(k);
        } else {
          draft.kinds.add(k);
        }
        paint();
      });
      pop.appendChild(b);
      if (k === 'floor') {
        // C11: "Closed floor lines" (off by default) shows the floor lines of finished turns again
        const c = el('button', 'wr-menui');
        c.type = 'button';
        c.dataset.kind = 'closedfloor';
        c.setAttribute('role', 'menuitemcheckbox');
        c.innerHTML = icon('check_box');
        c.appendChild(el('span', 'wr-menut', 'Closed floor lines'));
        c.addEventListener('click', () => {
          draft.closedFloor = !draft.closedFloor;
          paint();
        });
        pop.appendChild(c);
      }
    }
    pop.appendChild(el('div', 'wr-menud'));
    sec('From');
    const fromRow = (key, label) => {
      const b = el('button', 'wr-menui');
      b.type = 'button';
      b.dataset.from = key;
      b.setAttribute('role', 'menuitemradio');
      b.innerHTML = icon('radio_button_unchecked');
      b.appendChild(el('span', 'wr-menut', label));
      b.addEventListener('click', () => {
        draft.from = key;
        paint();
      });
      pop.appendChild(b);
    };
    fromRow('all', 'Everyone');
    fromRow('me', 'To me');
    for (const s of seatsOf(v)) {
      fromRow(s.id, '@' + s.handle);
    }
    const acts = el('div', 'wr-filtera');
    const reset = el('button', 'wr-dlgbtn text', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      draft.kinds = new Set(KINDS.map((k) => k[0]));
      draft.from = 'all';
      draft.closedFloor = false;
      paint();
    });
    const done = el('button', 'wr-dlgbtn filled', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => {
      filters.set(id, { kinds: draft.kinds, from: draft.from, closedFloor: draft.closedFloor });
      closePageMenus();
      applyFilter(id);
    });
    acts.append(reset, done);
    pop.appendChild(acts);
    root.appendChild(pop);
    paint();
    const r = root.getBoundingClientRect();
    const b = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = Math.round(Math.max(4, Math.min(b.right - r.left - w, r.width - w - 4))) + 'px';
    pop.style.top = Math.round(Math.max(4, Math.min(b.bottom - r.top + 4, r.height - pop.offsetHeight - 4))) + 'px';
    const first = pop.querySelector('.wr-menui');
    if (first) {
      first.focus();
    }
    const away = (e) => {
      if (!pop.contains(e.target)) {
        pop.remove();
        document.removeEventListener('pointerdown', away, true);
      }
    };
    const stopOutside = watchOutside(pop, away);
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        pop.remove(); stopOutside();
        anchor.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = [...pop.querySelectorAll('button')];
        const i = all.indexOf(document.activeElement);
        all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus();
      }
    });
    return pop;
  }

  function headerEl(v) {
    // the 48 px header: plate 28, name, crumb, info · search · filter · ⋯
    const h = el('div', 'wr-rh');
    h.appendChild(plateEl(v, 28));
    h.appendChild(el('div', 'wr-rname', v.room.name));
    appendLocation(h, v.room);
    const seats = seatsOf(v);
    const lead = leadOf(v);
    const isGroup = !!v.room.parent_id;
    const alias = v.room.alias ? '@' + v.room.alias : '';
    const n = seats.length + (seats.length === 1 ? ' seat' : ' seats');
    const crumb = st.width < WIDE_FROM ? [alias, n].filter(Boolean).join(' · ') : [alias, isGroup ? 'workgroup' : 'room chat', lead ? 'lead ' + lead : '', n].filter(Boolean).join(' · ');
    // C4: the (i) right after the crumb, on the room side; it opens the brief
    const cw = el('div', 'wr-crumbw');
    cw.appendChild(el('div', 'wr-crumb', crumb));
    const info = el('button', 'wr-ib wr-info');
    info.type = 'button';
    info.title = 'About this room';
    info.setAttribute('aria-label', 'About this room');
    info.innerHTML = icon('info');
    info.addEventListener('click', () => openSide('brief', 'show'));
    cw.appendChild(info);
    h.appendChild(cw);
    // W3: the mode chip only when Autonomous; who has the floor; where you're signed in
    if (v.room.mode === 'autonomous') {
      const mc = el('span', 'wr-hchip mode');
      mc.innerHTML = icon('autoplay');
      mc.appendChild(el('span', null, 'Autonomous'));
      mc.title = 'The lead keeps the room moving between your messages.';
      h.appendChild(mc);
    }
    const floor = !disconnected(v.room.id) && floorOf(v.room.id);
    if (floor) {
      const fc = el('button', 'wr-hchip floor wr-floor-control');
      fc.type = 'button';
      fc.setAttribute('aria-haspopup', 'menu');
      fc.innerHTML = icon('front_hand');
      fc.appendChild(el('span', 'wr-floorw', floor + ' has the floor'));
      fc.title = 'Floor actions';
      fc.setAttribute('aria-label', floor + ' has the floor. Floor actions');
      fc.addEventListener('click', () => {
        const epoch = accountEpoch, roomId = v.room.id;
        const bounds = fc.getBoundingClientRect();
        openMenu(root, { x: bounds.left, y: bounds.bottom }, [
          { id: 'floor-skip', label: 'Skip @' + floor, icon: 'skip_next', disabled: !/^[A-Za-z0-9_-]{1,40}$/.test(floor),
            fn: () => floorCommand(roomId, epoch, '/floor skip @' + floor) },
          { id: 'floor-take', label: 'Take the floor', icon: 'front_hand', tip: 'Release current agent turns in this room',
            fn: () => floorCommand(roomId, epoch, '/floor take') },
        ]);
      });
      h.appendChild(fc);
    }
    h.appendChild(presenceEl());
    // phone (CSS shows it under 600 px): the seats sheet, first in the row of actions
    const stb = el('button', 'wr-ib wr-seatsb');
    stb.type = 'button';
    stb.hidden = !seatsSheet || disconnected(v.room.id);
    stb.title = 'Seats · ' + seats.length;
    stb.setAttribute('aria-label', (st.width < 400 ? 'Seats, ' : 'Seats · ') + seats.length); // under 400 px the button is the icon and its number: its name says so
    stb.setAttribute('aria-haspopup', 'dialog');
    stb.innerHTML = icon('group');
    stb.appendChild(el('span', 'wr-seatsn', String(seats.length)));
    stb.addEventListener('click', () => seatsSheet?.open(stb));
    h.appendChild(stb);
    if (chatsSheet) h.appendChild(chatsSheet.button()); // phone: the room's chats (the design s11)
    // C3: search (the magnifier, Ctrl+F) and filter (the funnel, filled while on)
    const sb = el('button', 'wr-ib wr-searchb' + (findOf().open ? ' on' : ''));
    sb.type = 'button';
    sb.hidden = disconnected(v.room.id);
    sb.title = 'Search (Ctrl+F)';
    sb.setAttribute('aria-label', 'Search');
    sb.innerHTML = icon('search');
    sb.addEventListener('click', () => openFind());
    h.appendChild(sb);
    const fon = filterOn(v.room.id);
    const fb = el('button', 'wr-ib wr-filterb' + (fon ? ' on' : ''));
    fb.type = 'button';
    fb.hidden = disconnected(v.room.id);
    fb.title = 'Filter';
    fb.setAttribute('aria-label', 'Filter');
    fb.setAttribute('aria-haspopup', 'dialog');
    fb.setAttribute('aria-pressed', String(fon));
    fb.innerHTML = icon('filter_alt', fon ? 'fill' : '');
    fb.addEventListener('click', (e) => {
      e.stopPropagation();
      openFilter(fb, v);
    });
    h.appendChild(fb);
    // the room's tools: a count of the tool cards and added tools; a bottom sheet on a phone, a small menu under the button on a wider screen (the design s10)
    const tb = el('button', 'wr-ib wr-toolsb');
    tb.type = 'button';
    tb.setAttribute('aria-haspopup', 'menu');
    tb.innerHTML = icon('widgets');
    const toolsCount = el('span', 'wr-toolsn', '0');
    tb.appendChild(toolsCount);
    const nTools = toolItems().length;
    tb.hidden = nTools === 0;
    tb.title = 'Tools';
    tb.setAttribute('aria-label', 'Tools, ' + nTools);
    toolsCount.textContent = String(nTools);
    tb.addEventListener('click', (e) => {
      e.stopPropagation();
      const items = toolItems();
      if (!items.length) return;
      if (st.width < 600 && toolsSheet) { toolsSheet.open(tb); return; }
      const bnd = tb.getBoundingClientRect();
      openMenu(root, { x: Math.max(8, bnd.right - 240), y: bnd.bottom + 4 }, items.map((it) => ({ id: 'tool-' + it.key, label: it.title, icon: it.icon || 'extension', tip: toolNote2(it), fn: () => it.open() })));
    });
    h.appendChild(tb);
    // module buttons the module host puts in the room's toolbar (web: Widgets, the design )
    if (deps.roomTools && !disconnected(v.room.id)) for (const b of deps.roomTools(v.room.id)) if (b instanceof HTMLElement) h.appendChild(b);
    // ⋯: "Scratchpad and Notes open from the room's ⋯"
    const more = el('button', 'wr-ib wr-more');
    more.type = 'button';
    more.title = 'More';
    more.setAttribute('aria-label', 'More');
    more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = icon('more_vert');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = more.getBoundingClientRect();
      people.roomMenu(v.room.id, { x: b.right - 220, y: b.bottom + 4 });
    });
    h.appendChild(more);
    return h;
  }

  // Floor commands are ordinary scoped room posts; engine facts alone update authority.
  async function floorCommand(roomId, epoch, text) {
    const current = () => !destroyed && epoch === accountEpoch && roomId === currentRoomId() && st.status.signedIn;
    if (!current()) return false;
    let response;
    try { response = await window.wb.rooms.post(roomId, { text }); }
    catch { if (current()) deps.snackbar && deps.snackbar("Couldn't change the floor."); return false; }
    if (!current()) return false;
    const value = response && response.ok && response.value;
    if (!value || value.status !== 'applied') {
      const reason = value && value.refused && value.refused.error;
      deps.snackbar && deps.snackbar(typeof reason === 'string' && reason ? 'Floor change refused: ' + reason.slice(0, 200) : "Couldn't change the floor.");
      return false;
    }
    return true; // wait for returned/broadcast room facts, no optimistic ownership change
  }

  // W3: who has the floor: the newest turn fact of the shown line, while that turn is still open
  function floorOf(roomId) {
    if (line.state().roomId !== roomId) {
      return null;
    }
    const reply = cmp.state().reply;
    const entry = reply && line.entries().find(e => e.id === reply.id);
    const thread = reply && (reply.thread ?? entry?.meta?.turn?.thread ?? entry?.meta?.thread ?? entry?.thread ?? reply.id);
    const turns = line.turns().filter(e => !reply || Number(e.meta?.turn?.thread) === Number(thread));
    const last = turns[turns.length - 1];
    if (!last || last.meta.turn.kind !== 'floor') {
      return null;
    }
    const seat = seatsOf(viewOf(roomId)).find((x) => x.id === last.meta.turn.seat);
    return seat ? seat.handle : (/^@?(\S+) has the floor/.exec(last.body || '') || [])[1] || null;
  }
  // W3: where you're signed in (display only): your avatar and "+N"; it opens "You're signed in on"
  function presenceEl() {
    const devices = (st.presence && st.presence.devices) || [];
    const b = el('button', 'wr-presence');
    b.type = 'button';
    b.title = "Where you're signed in";
    b.setAttribute('aria-label', "Where you're signed in");
    const myAv = personAvatar(28);
    b.appendChild(myAv);
    if (devices.length > 1) {
      b.appendChild(el('span', 'wr-presn', '+' + (devices.length - 1)));
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      presenceMenu(b);
    });
    if (!st.presence || Date.now() - st.presence.at > 30000) {
      loadPresence();
    }
    return b;
  }
  async function loadPresence() {
    const epoch = accountEpoch;
    if (destroyed || !st.shown || st.presenceLoading) {
      return;
    }
    st.presenceLoading = true;
    const r = await window.wb.rooms.presence();
    if (destroyed || epoch !== accountEpoch) return;
    st.presenceLoading = false;
    const list = r && r.ok && r.value && Array.isArray(r.value.devices) ? r.value.devices : [];
    const fresh = list.filter((d) => !d.lastSeen || Date.now() - d.lastSeen < 5 * 60000); // gone 5 min after they go quiet
    const had = st.presence ? st.presence.devices.length : -1;
    st.presence = { at: Date.now(), devices: fresh };
    if (had !== fresh.length && st.active !== 'all') {
      paintRoom();
    }
  }
  function deviceWords(d, i) {
    const here = i === 0;
    const ago = d.lastSeen ? Math.round((Date.now() - d.lastSeen) / 60000) : 0;
    const app = d.client === 'workbench' ? 'Workbench' : d.client ? String(d.client) : '';
    return (here ? 'This PC' : d.name || 'Another device') + (app ? ' · ' + app : '') + (!here && ago > 0 ? ' · ' + ago + ' min ago' : '');
  }
  function presenceMenu(anchor) {
    closePageMenus();
    const devices = ((st.presence && st.presence.devices) || []).slice().sort((a, b) => (b.client === 'workbench') - (a.client === 'workbench')); // "This PC" first
    const m = el('div', 'wr-menu wr-pmenu wr-presmenu');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-label', "You're signed in on");
    m.appendChild(el('div', 'wr-menuh', "You're signed in on"));
    devices.forEach((d, i) => {
      const row = el('div', 'wr-presrow');
      row.innerHTML = icon(i === 0 ? 'computer' : 'devices');
      row.appendChild(el('span', null, deviceWords(d, i)));
      m.appendChild(row);
    });
    if (!devices.length) {
      m.appendChild(el('div', 'wr-presrow', 'Only here.'));
    }
    root.appendChild(m);
    const a = anchor.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    m.style.top = Math.round(a.bottom - r.top + 4) + 'px';
    m.style.left = Math.round(Math.max(4, Math.min(a.right - r.left - m.offsetWidth, r.width - m.offsetWidth - 4))) + 'px';
    const away = (e) => {
      if (!m.contains(e.target)) {
        m.remove();
        document.removeEventListener('pointerdown', away, true);
      }
    };
    watchOutside(m, away);
  }

  // the connection strip under the room header, one at a time, the worst wins
  function stripEl() {
    const s = el('div', 'wr-strip');
    const c = st.status.conn;
    if (c === 'down') {
      s.classList.add('err');
      s.innerHTML = icon('error');
      const text = el('span', 'grow');
      s.appendChild(text);
      const b = el('button', 'wr-txtb', 'Try now');
      b.type = 'button';
      b.addEventListener('click', () => window.wb.rooms.retry());
      s.appendChild(b);
      const tick = () => {
        text.textContent = WORDS.down(serverName(), Math.max(0, Math.ceil((st.status.retryAt - Date.now()) / 1000)));
      };
      tick();
      clearInterval(st.retryTick);
      st.retryTick = st.shown ? setInterval(tick, 1000) : null;
    } else if (c === 'offline') {
      s.classList.add('warn');
      s.innerHTML = icon('cloud_off');
      s.appendChild(el('span', 'grow', WORDS.offlineStrip));
    } else if (c === 'polling') {
      s.classList.add('info');
      s.innerHTML = icon('sync_problem');
      s.appendChild(el('span', 'grow', WORDS.polling));
    } else {
      s.hidden = true;
    }
    return s;
  }

  // ---- the room's rail: persistent search/controls, independently repainted results.
  let railComposing = false;
  function paintRailResults() {
    const t = activeTab(), fam = t && viewOf(t.familyId), v = t && (viewOf(t.roomId) || fam);
    if (st.status.signedIn && fam && v) paintRail(fam, v);
  }
  function clearRailSearch(focus = false) {
    st.railQuery = ''; railInput.value = ''; railComposing = false; railClear.hidden = true;
    paintRailResults();
    if (focus) railInput.focus(); // an explicit Clear click, never a polling side effect
  }
  railClear.addEventListener('click', () => clearRailSearch(true));
  railInput.addEventListener('compositionstart', () => { railComposing = true; });
  railInput.addEventListener('compositionend', () => {
    railComposing = false; st.railQuery = railInput.value; paintRailResults();
  });
  railInput.addEventListener('input', e => {
    st.railQuery = railInput.value; railClear.hidden = !railInput.value;
    if (!railComposing && !e.isComposing) paintRailResults();
  });
  railInput.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !railComposing && !e.isComposing && railInput.value) {
      e.preventDefault(); e.stopPropagation(); clearRailSearch();
    }
  });
  function paintRail(fam, v) {
    const isPinned = pinned();
    rail.classList.add('sr');
    rail.classList.toggle('pinned', isPinned);
    rail.classList.toggle('slim', st.width < SLIM_UNDER);
    rail.classList.toggle('open', !isPinned && st.railOpen);
    rail.hidden = !(isPinned || st.railOpen);
    railPin.classList.toggle('on', isPinned);
    railPin.dataset.pin = isPinned ? 'on' : 'off';
    railPin.title = isPinned ? 'Unpin' : canPin() ? 'Pin' : 'Not enough room to pin';
    railPin.setAttribute('aria-label', railPin.title);
    railPin.setAttribute('aria-pressed', String(isPinned));
    railPin.disabled = !isPinned && !canPin();
    railPin.innerHTML = icon('keep', isPinned ? 'fill' : '');
    railClose.hidden = isPinned;
    railClear.hidden = !railInput.value;
    const rq = (st.railQuery || '').trim().toLowerCase();
    const hit = (...words) => !rq || words.some((w) => String(w || '').toLowerCase().includes(rq));
    const body = railBody;
    const activities = [];
    const activityDescriptions = [];
    body.replaceChildren();
    const famColor = roomSeed(fam) || 'var(--md-sys-color-primary)';
    const label = (key, text, ic, color, add, extra) => {
      const collapsed = isCollapsed('workrooms', key);
      const roomBand=key==='room'||key==='seats';
      const group=groupLabel({
          key,
          icon: ic,
          label: text,
          color:roomBand||key==='scratchpad'?'var(--md-sys-color-primary)':color,
          collapsed,
          add,
          extra,
          onToggle: () => {
            toggleCollapsed('workrooms', key);
            paint();
            const again = rail.querySelector('.sr-g[data-grp="' + key + '"] .sr-caret');
            if (again) {
              again.focus();
            }
          },
        });
      if(roomBand&&deps.roomColors)deps.roomColors.apply(group,color);
      if(key==='scratchpad'&&deps.appTone){
        deps.appTone(group,{app_slug:'assets'},st.status.me?.tones);
        for(const button of group.querySelectorAll('button'))systemPalette(button);
      }
      body.appendChild(group);
      return !collapsed;
    };
    const groups = (fam.family && fam.family.workgroups) || [];
    const count = (n) => (n == null ? '' : n + (n === 1 ? ' seat' : ' seats'));
    const row = (view, name, alias, small, o = {}) => {
      const id = view.room.id;
      const on = v.room.id === id;
      const off = disconnected(id);
      const r = el('div', 'wr-rrow sr-r' + (o.sub ? ' sub nested' : '') + (o.last ? ' last' : '') + (o.first ? ' first' : '') + (o.noParent ? ' no-parent' : '') + (o.hasChildren ? ' has-children' : '') + (on ? ' on' : ''));
      r.classList.toggle('disconnected', off);
      r.tabIndex = 0;
      r.dataset.room = id;
      r.setAttribute('role', 'option');
      r.setAttribute('aria-selected', String(on));
      roomPalette(r,view);
      r.style.setProperty('--c','var(--md-sys-color-primary)');
      const roomPlate = off ? roomGlyph([], o.sub ? 20 : 28, true) : plate('var(--md-sys-color-primary)');
      const rollup = Object.hasOwn(o,'rollup') ? o.rollup : view.rollup;
      if (rollup != null) {
        const activity = decorateRoomActivity(roomPlate,rollup,name,{connected:!off,size:o.sub?TEAM_ACTIVITY_SIZE:ROOM_ACTIVITY_SIZE});
        if (activity) {
          activities.push({...activity,id});
          if(activity.description){
            const description=el('span','',activity.description);
            description.id=activityDescriptionPrefix+'-'+(++activityDescriptionSequence);description.hidden=true;
            r.setAttribute('aria-describedby',description.id);activityDescriptions.push(description);
          }
        }
      }
      r.appendChild(roomPlate);
      const tx = el('span', 'tx wr-rtx');
      const n1 = el('span', 'n1 wr-rn', name);
      if (alias) {
        n1.appendChild(el('span', 'sr-al', '@' + alias));
      }
      tx.append(n1, el('span', 'n2 wr-rs', off ? 'Disconnected · ' + count(seatsOf(view).length) : small));
      appendLocation(tx, view.room);
      r.appendChild(tx);
      const n = Number(view.unread) || 0;
      if (n > 0 && !on && !off) {
        r.appendChild(el('span', 'sr-badge wr-badge', String(n)));
      }
      const acts = el('span', 'acts');
      const more = el('button', 'wr-ib wr-roommore');
      more.type = 'button';
      more.tabIndex = -1;
      more.title = 'More for ' + name;
      more.setAttribute('aria-label', 'More for ' + name);
      more.setAttribute('aria-haspopup', 'menu');
      more.innerHTML = icon('more_vert');
      const menuAt = (x, y) => people.roomMenu(id, { x, y });
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const b = more.getBoundingClientRect();
        menuAt(b.left, b.bottom + 2);
      });
      acts.appendChild(more);
      r.appendChild(acts);
      r.addEventListener('click', () => pick(id));
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menuAt(e.clientX, e.clientY);
      });
      r.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick(id);
        } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
          e.preventDefault();
          const b = r.getBoundingClientRect();
          menuAt(b.left + 40, b.bottom);
        }
      });
      return r;
    };
    // while searching, a group with nothing that matches is left out, label and all
    const mainHit = hit('Room chat', fam.room.name, fam.room.alias);
    const shownGroups = groups.filter((g) => hit(g.name, g.alias));
    const roomContext = el('div','ra-room-context');
    if ((!rq || mainHit || shownGroups.length) && label('room', 'Room', 'view_agenda', famColor, fam.room.parent_id ? null : { title: 'New workgroup', fn: () => people.newWorkgroup(fam.room.id) })) {
      body.appendChild(roomContext);
      const mainUnread = Number(fam.unread) || 0;
      if (mainHit) {
        roomContext.appendChild(row(fam, 'Room chat', '', 'main room' + (mainUnread ? ' · ' + mainUnread + ' new' : ''), { hasChildren: shownGroups.length > 0 }));
      }
      shownGroups.forEach((g, i) => {
        const gv = viewOf(g.id) || { room: { id: g.id, name: g.name, color: g.color, alias: g.alias }, unread: g.unread, seats: [] };
        const n = typeof g.seats === 'number' ? g.seats : Array.isArray(g.seats) ? g.seats.length : viewOf(g.id) ? seatsOf(viewOf(g.id)).length : null;
        const small = [g.lead ? 'lead ' + g.lead : '', count(n)].filter(Boolean).join(' · ');
        roomContext.appendChild(row(gv, g.name, g.alias, small, { rollup:g.rollup !== undefined ? g.rollup : gv.rollup, sub: true, first: i === 0, last: i === shownGroups.length - 1, noParent: !mainHit }));
      });
    }
    roomContext.append(...activityDescriptions);
    if (activities.length) applyRoomActivityContext(roomContext,activities);
    const activityUpdate=activityAnnouncements.observe({scope:accountEpoch+':'+fam.room.id,shown:st.shown&&!rail.hidden,entries:activities.map(activity=>({id:activity.id,activity}))});
    if(activityUpdate.text!==null)activityLive.textContent=activityUpdate.text;
    else if(activityUpdate.clear&&activityLive.textContent)activityLive.textContent='';
    if (disconnected(v.room.id)) return; // no seats, thinking indicators or Scratchpad actions
    const seats = seatsOf(v);
    const seatHits = seats.filter((s) => hit(s.handle));
    if ((!rq || seatHits.length) && label('seats', 'Seats · ' + seats.length, 'group', roomSeed(v) || famColor, { title: 'Add a seat', fn: () => people.addSeat(v.room.id) })) {
      const order = seatOrder(fam.room.id);
      seatHits.forEach((s) => {
        const index=Math.max(0,order.indexOf(s.handle));
        const row=people.seatRow(v.room.id,v,s,index);
        const seed=recipeColorOf(s)||deps.roomColors?.seedForHandle?.(s.handle);
        if(seed){const glyph=row.querySelector('.wr-seatglyph')||row.querySelector('.wr-av');if(glyph)deps.roomColors?.apply(glyph,seed);row.dataset.identityPalette='true';row.dataset.identitySeed=seed;row.style.setProperty('--c','var(--md-sys-color-primary)');}
        body.appendChild(row);
      });
    }
    // The room's notes and assets are always reachable from its rail, including
    // an empty room. Folder settings belong to the app and apply to every room.
    const scratchRows = [['notes', 'Notes', 'sticky_note_2'], ['assets', 'Assets', 'folder_open'], ...(deps.openServerScratchpad ? [['files', 'Files', 'description']] : [])]
      .filter(([, name]) => hit('Scratchpad', name));
    if (scratchRows.length) {
      let settings;
      if (deps.openScratchpadSettings) {
        settings = el('button', 'sr-gb wr-scratchsettings'); settings.type = 'button';
        settings.title = 'Scratchpad folder settings'; settings.setAttribute('aria-label', settings.title);
        settings.innerHTML = icon('settings');
        settings.addEventListener('click', e => { e.stopPropagation(); deps.openScratchpadSettings(); });
      }
      if (label('scratchpad', 'Scratchpad', 'folder_open', v.room.color || famColor, null, settings)) {
        for (const [key, name, glyph] of scratchRows) {
          const b = el('button', 'sr-r wr-scratchrow'); b.type = 'button'; b.dataset.scratchpad = key;
          b.title = name + ' in ' + v.room.name;
          const ic = el('span', 'sr-ic'); ic.innerHTML = icon(glyph);
          const tx = el('span', 'tx'); tx.append(el('span', 'n1', name), el('span', 'n2', 'This room'));
          b.append(ic, tx);
          b.addEventListener('click', () => { closeRail(); if (deps.openServerScratchpad) deps.openServerScratchpad(key); else openSide(key); });
          body.appendChild(b);
        }
      }
    }
    // Tasks seam S1: host-drawn tool cards (the design notes). The descriptors were checked by
    // tool-cards.js checkCard before they reached this list; every module string goes in as text.
    const cards = deps.toolCards ? deps.toolCards().filter((c) => hit('Tools', c.card.title)) : [];
    if (cards.length && label('tools', 'Tools', 'extension', v.room.color || famColor)) {
      for (const c of cards) {
        body.appendChild(toolCard(c));
      }
    }
    // plugin side pages (desktop plugin slice 6b): an allowed plugin's page opens in the side column only; the list and
    // the URL come from the module host's catalog (modules.js pluginSidePages), every string goes in as text
    const plugins = deps.pluginPages ? deps.pluginPages().filter((p) => p && typeof p.id === 'string' && typeof p.url === 'string' && isModuleFrameSrc(p.url) && hit('Tools', p.name)) : [];
    if (plugins.length && (cards.length || label('tools', 'Tools', 'extension', v.room.color || famColor))) {
      for (const p of plugins) {
        const b = el('button', 'sr-r wr-pluginrow'); b.type = 'button'; b.dataset.plugin = p.id;
        b.title = 'Open ' + p.name;
        const ic = el('span', 'sr-ic'); ic.innerHTML = icon('extension');
        const tx = el('span', 'tx'); tx.append(el('span', 'n1', p.name), el('span', 'n2', 'Added by you'));
        b.append(ic, tx);
        // the module host opens it bound to this room (its data calls admitted like a bundled tool's); a host without
        // that (the desktop) opens the page as before
        b.addEventListener('click', () => { closeRail(); if (!(deps.openPluginPage && deps.openPluginPage(p.id))) openToolSide('plugin:' + p.id, p.url, { title: p.name }); });
        body.appendChild(b);
      }
    }
    if (rq && !body.querySelector('.sr-r')) {
      body.appendChild(el('div', 'wr-railnone', 'Nothing matches "' + st.railQuery.trim() + '"'));
    }
    if (refocusCard) {
      const b = body.querySelector('[data-toolcard="' + CSS.escape(refocusCard) + '"]');
      refocusCard = null;
      if (b) b.focus({ preventScroll: true }); // a repaint never moves focus off the card the person was on
    }
    emitShown(fam, v);
  }
  let refocusCard = null;
  let lastShown;
  function emitShown(fam, v) {
    if (!deps.onRoomShown) return;
    // hidden or destroyed: no room is shown, whatever repaints the rail in the background
    const p = fam && v && st.shown && !destroyed ? { roomId: v.room.id, familyId: fam.room.id, group: v.room.id === fam.room.id ? null : (v.room.alias || null) } : null;
    if (p && deps.openServerScratchpad) p.roomName = v.room.name;
    const key = JSON.stringify(p);
    if (key === lastShown) return;
    lastShown = key;
    deps.onRoomShown(p);
  }
  function toolCard({ moduleId, cardId = 'main', card }) {
    // revision 10: up to two cards per module, each keyed "<module>:<card>" (a repaint refocuses by that key)
    const b = el('button', 'sr-r wr-toolcard'); b.type = 'button'; b.dataset.toolcard = moduleId + ':' + cardId;
    b.setAttribute('aria-label', card.line ? card.title + ', ' + card.line : card.title);
    const head = el('span', 'tc-h');
    // the tool's tone is on its icon tile, the title stays plain (the design's amendment to the app tones, 2026-10-26)
    const ic = el('span', 'sr-ic tc-ic'); ic.innerHTML = icon(card.icon);
    deps.appTone?.(ic,{app_slug:moduleId},st.status.me?.tones);
    head.append(ic, el('span', 'tc-t', card.title));
    if (card.linked !== null) {
      const ln = el('span', 'tc-link'); ln.innerHTML = icon(card.linked ? 'link' : 'link_off');
      ln.title = card.linked ? 'On the room plan' : 'On its own plan';
      head.appendChild(ln);
    }
    if (card.badge) {
      const bd = el('span', 'tc-badge', String(card.badge.count)); bd.title = card.badge.count + ' need you';
      head.appendChild(bd);
    }
    // a card with no time axis has no activity to draw, and an invented strip would lie: its line sits where the
    // strip sits, so the card keeps its 68 px (the design , the Room Tasks card)
    let strip;
    if (!card.axis && !card.spans.length && card.line) {
      strip = el('span', 'tc-line', card.line);
    } else {
      strip = el('span', 'tc-strip');
      for (const s of card.spans) {
        const i = el('i', s.n === 'needs' ? 'tc-s needs' : 'tc-s n' + s.n);
        i.style.left = (s.a * 100).toFixed(2) + '%'; i.style.width = ((s.b - s.a) * 100).toFixed(2) + '%';
        strip.appendChild(i);
      }
    }
    const prog = el('span', 'tc-p');
    const track = el('span', 'tc-track'); const fill = el('i');
    fill.style.width = (card.pct ?? 0) + '%'; track.appendChild(fill);
    prog.append(track, el('b', null, card.pct === null ? '—' : card.pct + '%'));
    if (card.note) prog.appendChild(el('span', 'tc-note', '· ' + card.note)); // muted, display only (no badge, no alarm)
    b.append(head, strip, prog);
    b.addEventListener('click', () => deps.activateToolCard && deps.activateToolCard(moduleId, cardId));
    return b;
  }
  function pick(roomId) {
    closeInlineTerminal(false);
    const t = activeTab();
    if (!t) {
      return;
    }
    t.roomId = roomId;
    st.railOpen = false; // "Picking a room closes it"
    saveTabs();
    paint();
    openLine();
  }
  function openRail() {
    if (st.active === 'all' || pinned()) {
      return false;
    }
    st.railOpen = true;
    paint();
    const first = rail.querySelector('.wr-rrow');
    if (first) {
      first.focus();
    }
    return true;
  }
  function closeRail() {
    if (!st.railOpen) {
      return;
    }
    st.railOpen = false;
    paint();
  }
  const railOutside = (e) => {
      if (st.railOpen && !pinned() && !rail.contains(e.target) && !(deps.flagEl && deps.flagEl.contains(e.target))) {
        closeRail();
      }
    };
  document.addEventListener('pointerdown', railOutside, true);
  root.addEventListener('keydown', (e) => {
    if (e.isComposing || (railComposing && e.target === railInput)) return;
    // C3: Ctrl+F searches the shown room
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F') && currentRoomId()) {
      e.preventDefault();
      openFind();
      return;
    }
    if (e.key === 'Escape' && st.railOpen && !pinned()) {
      closeRail();
      e.preventDefault();
    }
  });

  // ---- the line of the shown room
  let lineToken = 0;
  async function loadLatest() {
    const id = currentRoomId(), epoch = accountEpoch, token = lineToken;
    if (destroyed || !st.shown || !id || disconnected(id)) return null;
    const r = await window.wb.rooms.line(id, { limit: 300 });
    if (destroyed || !st.shown || epoch !== accountEpoch || token !== lineToken || id !== currentRoomId()) return null;
    return r && r.ok ? r.value : null;
  }
  // A first load that loses the race to the local engine ({ok:false}) must not leave the chat blank until the room
  // is reopened: retry by itself 1, 2 and 4 s later, again when the connection comes up, then say so plainly.
  const LINE_RETRY_MS = [1000, 2000, 4000];
  let lineRetryTimer = null, lineFailBox = null, lineTries = 0, lineFailRoom = null;
  function clearLineRetry() { if (lineRetryTimer != null) { clearTimeout(lineRetryTimer); lineRetryTimer = null; } }
  function hideLineFail() { if (lineFailBox) { lineFailBox.remove(); lineFailBox = null; } }
  function showLineFail() {
    hideLineFail();
    const retry = el('button', 'wr-older', "Couldn't load this room. Try again.");
    retry.type = 'button';
    retry.addEventListener('click', () => { lineTries = 0; openLine(); });
    lineFailBox = el('div', 'wr-linefail');
    lineFailBox.append(retry);
    line.el.appendChild(lineFailBox);
  }
  function lineLoadFailed(id, token) {
    lineFailRoom = id;
    const n = lineTries++;
    if (n >= LINE_RETRY_MS.length) { showLineFail(); return; }
    lineRetryTimer = setTimeout(() => {
      lineRetryTimer = null;
      if (!destroyed && st.shown && token === lineToken && id === currentRoomId()) openLine();
    }, LINE_RETRY_MS[n]);
  }
  // The room on screen has no chat loaded: never opened, discarded while paint() reset the line for a runtime that was
  // still starting, or answered empty before the connection was up. Not 'loaded' means: not this room, or no entries.
  function needsLine() {
    const id = currentRoomId();
    if (destroyed || !st.shown || !id || disconnected(id)) return false;
    const local = localState();
    if (local && local.localRooms.status !== 'running' && placeOf(id) === 'local') return false; // paint() shows the runtime state
    return line.state().roomId !== id || !(line.entries?.().length);
  }
  function ensureLineLoaded() { if (needsLine()) { lineTries = 0; openLine(); } }
  async function openLine() {
    if (destroyed) return;
    // a full page is shown over the room it came from: leave that room's line, message box and preview as they are, so
    // its way back finds them unchanged (the design's s10)
    if (toolPageOf(st.active)) return;
    const id = currentRoomId();
    if (lineFailRoom !== id) { lineTries = 0; lineFailRoom = null; }
    clearLineRetry(); hideLineFail();
    tellVisible();
    if (!id) {
      void starter?.shown(null);
      lineToken++;
      line.clear();
      cmp.close();
      if (side.isOpen()) {
        side.close();
      }
      return;
    }
    const token = ++lineToken, epoch = accountEpoch;
    if (disconnected(id)) { void starter?.shown(null); line.setVisible?.(false); line.clear(); cmp.close({ save: false }); return; }
    if (!st.shown) { void starter?.shown(null); line.setVisible?.(false); return; }
    void starter?.shown(canUseStarter()&&st.status.signedIn&&viewOf(id)&&placeOf(id)==='local'?id:null);
    line.setVisible?.(true);
    if (line.state().roomId !== id) line.clear();
    cmp.open(id); // at once: what you type right after switching is never reset by the line arriving
    side.roomChanged();
    const v = viewOf(id);
    const r = await window.wb.rooms.line(id, { limit: 300 });
    if (destroyed || !st.shown || epoch !== accountEpoch || id !== currentRoomId() || token !== lineToken) {
      return;
    }
    if (r && r.ok) {
      lineTries = 0; lineFailRoom = null;
      line.open(id, v ? v.room.name : '', r.value, v ? Number(v.unread) || 0 : 0);
    } else {
      line.clear();
      lineLoadFailed(id, token);
    }
    cmp.pendingAgain(); // after the line: its unsent rows go at the end
    markHeld();
    if (line.turns().length) {
      paintRoom(); // the floor chip reads the turns the line just loaded
    }
  }

  // ---- signed out
  function paintSignin() {
    signin.hidden = st.status.signedIn;
    strip.hidden = !st.status.signedIn;
    bodyRow.hidden = !st.status.signedIn;
    roomHead.hidden = !st.status.signedIn || st.active === 'all';
    if (roomHead.hidden) roomHead.replaceChildren();
    if (st.status.signedIn) {
      signin.textContent = ''; // nothing typed outlives a sign-in (the repaint below keeps it only while signed out)
      return;
    }
    // the web app's own signed-out card owns this state (it covers the page and its Sign in goes to the server's own login page):
    // the rooms page never builds a second sign-in form under it, and with it none of the realm words in WORDS.auto
    if (window.wb && window.wb.web) { signin.hidden = true; signin.textContent = ''; return; }
    const request = window.wb.rooms.bind();
    // a repaint (a status broadcast, A1's reason line) keeps what was typed and where the caret was
    const was = signin.querySelector('input[name=username]')
      ? { u: signin.querySelector('input[name=username]').value, p: signin.querySelector('input[name=password]').value, at: signin.contains(document.activeElement) ? document.activeElement.name : null }
      : null;
    signin.textContent = '';
    const card = el('form', 'wr-sicard');
    card.innerHTML = icon('forum', 'big');
    card.appendChild(el('div', 'wr-sit', WORDS.signedOut(serverName())));
    // A1: one quiet line under the title when the automatic sign-in was refused: gray, an info
    // icon, a text link where it names a place; it stays until you sign in
    const why = WORDS.auto[st.status.note];
    if (why) {
      const n = el('div', 'wr-sinote');
      n.dataset.why = st.status.note;
      n.innerHTML = icon('info');
      const t = el('span', null, why[0]);
      if (why[1]) {
        const a = el('button', 'wr-silink', why[1]);
        a.type = 'button';
        a.addEventListener('click', () => (why[3] === 'engine' ? st.status.accountPage && deps.openExternal(st.status.accountPage) : deps.openAccounts && deps.openAccounts()));
        t.append(a, why[2]);
      }
      n.appendChild(t);
      card.appendChild(n);
    }
    // M3 outlined text fields with floating labels
    const field = (name, type, label, auto) => {
      const f = el('div', 'wr-field');
      const i = el('input');
      i.type = type;
      i.name = name;
      i.id = 'wr-si-' + name;
      i.autocomplete = auto;
      i.placeholder = ' ';
      const l = el('label', null, label);
      l.htmlFor = i.id;
      f.append(i, l);
      return { f, i };
    };
    const { f: fu, i: u } = field('username', 'text', 'Username', 'username');
    const { f: fp, i: p } = field('password', 'password', 'Password', 'current-password');
    const err = el('div', 'wr-sierr');
    err.setAttribute('role', 'alert');
    if (st.signinError) {
      err.textContent = st.signinError === 'wrong' ? WORDS.wrong : st.signinError === 'offline' ? WORDS.offline : st.signinError === 'password' ? WORDS.password(serverName()) : WORDS.unreachable(serverName());
    } else {
      err.hidden = true;
    }
    const b = el('button', 'wr-filled', st.signinBusy ? 'Signing in…' : 'Sign in');
    b.type = 'submit';
    b.disabled = st.signinBusy;
    card.append(fu, fp, err, b);
    card.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (st.signinBusy || !request.current()) {
        return;
      }
      st.signinBusy = true;
      st.signinError = null;
      b.disabled = true;
      b.textContent = 'Signing in…';
      const r = await request.signIn(u.value.trim(), p.value);
      if (!request.current()) return;
      st.signinBusy = false;
      if (!r || !r.ok) {
        st.signinError = (r && r.why) || 'unreachable';
        p.value = ''; // a refused password isn't kept (the repaint keeps the username)
        paintSignin();
        const again = signin.querySelector('input[name=username]');
        if (again) {
          again.value = u.value;
          again.focus();
        }
      }
      // on success rooms:status arrives and paints the cards
    });
    signin.appendChild(card);
    if (was) {
      u.value = was.u;
      p.value = was.p;
    }
    requestAnimationFrame(() => { if (!destroyed && signin.isConnected && !signin.hidden) (was && was.at === 'password' ? p : u).focus(); });
  }

  // ---- paint everything from state
  function paint() {
    if (destroyed) return;
    syncToolLayer(); // the design s10: the phone tool layer follows the page's state
    needs?.update(st.status.signedIn ? st.rooms : [], { skip: (id) => disconnected(id) });
    syncTemplates();
    notificationBanner?.update();
    if(!st.shown||st.active==='all'||!st.status.signedIn)clearActivity();
    systemPalette(root);
    paintAgentWizard();
    const local = localState();
    if (local && local.localRooms.status !== 'running' && ((st.active === 'all' && !local.servers.length) || (st.active !== 'all' && placeOf(currentRoomId()) === 'local'))) {
      clearActivity();
      lineToken++; line.setVisible?.(false); line.clear(); cmp.close({ save: false });
      roomHead.hidden = true; rail.hidden = true; strip.replaceChildren(); main.className = 'wr-main';
      emitShown(null, null);
      deps.renderLocalStatus?.(main, local); return;
    }
    paintSignin();
    if (!st.status.signedIn) {
      emitShown(null, null);
      return;
    }
    paintStrip();
    const page = toolPageOf(st.active);
    bodyRow.classList.toggle('has-toolpage', !!page);
    toolHost.hidden = !page;
    for (const t of toolPages) t.wrap.hidden = t !== page;
    if (page) {
      // the room it was opened from stays the room shown (the design's s10): its preview stays open under the page, so one
      // step back lands on it, and the phone's bottom bar stays hidden as it is in the room
      const origin = st.tabs.find((x) => x.familyId === page.from);
      const ov = origin ? viewOf(origin.roomId) : null;
      emitShown(ov ? viewOf(familyOf(ov.room.id)) || ov : null, ov);
      roomHead.hidden = true;
      rail.hidden = true;
      clearInterval(st.retryTick);
      paintFlag();
      paintPill();
      return;
    }
    if (st.active === 'all') {
      emitShown(null, null);
      if(!agentGrid || agentGrid.parentElement!==main)main.textContent = '';
      main.dataset.room = '';
      rail.hidden = true;
      railBody.replaceChildren();
      clearInterval(st.retryTick);
      paintGrid();
    } else {
      clearInterval(st.retryTick);
      paintRoom();
    }
    main.classList.toggle('withside', st.active !== 'all' && side.isOpen() && wide());
    side.relayout();
    paintFlag();
    paintPill();
  }
  function paintFlag() {
    if (!deps.flag) {
      return;
    }
    const inRoom = st.active !== 'all' && !toolPageOf(st.active);
    const n = st.rooms.filter((v) => v.room && !v.room.parent_id && !hiddenIds().has(v.room.id)).reduce((a, v) => a + familyUnread(v), 0);
    deps.flag({ hidden: !st.status.signedIn || !inRoom || pinned(), count: n, dot: st.newForMe.size > 0 });
  }
  function paintPill() {
    if (!deps.pill) {
      return;
    }
    const names = [...st.newForMe.values()];
    deps.pill({ dot: names.length > 0, title: names.length ? 'New in ' + names.join(', ') : '' });
  }

  // ---- what main broadcasts
  subscribe('rooms:account', ({ accountId: next }) => {
    closeInlineTerminal(false);
    closeAllToolPages(); // a full page belongs to the account it was opened under
    accountEpoch++;
    for (const f of finds.values()) clearTimeout(f.timer);
    finds.clear(); filters.clear();
    clearInterval(st.retryTick); st.retryTick = null;
    accountId = next || null;
    resetStarterControls();
    lineToken++;
    recipeRead++;recipeAsk=0;
    recipeColors.clear();
    cmp.resetAccount(); // no draft write: the old account's room id may exist in the new realm
    side.resetAccount(); people.resetAccount(); seatsSheet?.close(); toolsSheet?.close(false); chatsSheet?.close(false); needs?.reset(); line.clear(); viewer.hide(); closePageMenus();
    for (const dlg of terminalDialogs) dlg.close();
    terminalDialogs.clear();
    st.status = { signedIn: false, conn: 'signed-out', server: '', me: null, retryAt: 0 };
    st.rooms = []; st.tabs = []; st.active = 'all'; st.presence = null; st.newForMe.clear();
    st.signinBusy = false; st.signinError = null; st.presenceLoading = false;
    clearRailSearch();
    signin.textContent = ''; // typed credentials belong to the account whose card held them
    paint();
  });
  subscribe('rooms:status', (s) => {
    accountId = s.accountId || null;
    const epoch = accountEpoch;
    const wasIn = st.status.signedIn;
    if(wasIn!==s.signedIn)starterVisibilityVersion++;
    const wasConn = st.status.conn;
    const priorDisconnectedRooms = st.status.disconnectedRooms || [];
    const wasDisconnected = disconnected(currentRoomId());
    const priorProfile = st.status.me;
    st.status = { ...st.status, ...s };
    if (['pictureKey', 'name', 'handle', 'color'].some(key => priorProfile?.[key] !== st.status.me?.[key])) line.refreshUserPicture();
    const connectionChanged = wasDisconnected !== disconnected(currentRoomId());
    if (connectionChanged) openLine();
    else if ((lineRetryTimer != null || lineFailBox || needsLine()) && st.shown && st.status.signedIn && st.status.conn !== 'signed-out' &&
      (!wasIn || wasConn !== st.status.conn)) { lineTries = 0; openLine(); } // the connection came up: do not wait for the timer
    paintMyColor();
    if (!s.signedIn) {
      void starter?.shown(null);
      closeInlineTerminal(false);
      recipeRead++;recipeColors.clear();
      st.active = 'all';
      st.rooms = [];
      st.presence = null; // whoever signs in next sees only their own devices
      st.newForMe.clear();
      clearRailSearch();
      line.clear();
      cmp.resetAccount();
    }
    if (st.status.conn !== wasConn || priorDisconnectedRooms.some(id => !disconnected(id))) {
      cmp.connChanged(); // back online: the waiting lines go out by themselves
    }
    if (s.signedIn && !wasIn) {
      loadRecipeColors(true); // C2: the seats' colors
      st.signinError = null;
      window.wb.rooms.list().then((r) => {
        if (!destroyed && epoch === accountEpoch && r && r.ok) {
          st.rooms = r.value || [];
          paint();
          openLine();
        }
      });
    }
    paint();
    tellVisible();
  });
  subscribe('recipes:changed',()=>loadRecipeColors(true));
  subscribe('rooms:rooms', ({ rooms }) => {
    st.rooms = Array.isArray(rooms) ? rooms : [];
    paint();
    if (st.active !== 'all' && !disconnected(currentRoomId())) {
      side.briefChanged();
      markHeld();
    }
  });
  subscribe('rooms:room', ({ roomId, view }) => {
    if (disconnected(roomId)) return;
    const i = st.rooms.findIndex((v) => v.room && v.room.id === roomId);
    if (i >= 0) {
      st.rooms[i] = { ...st.rooms[i], ...view };
    }
    needs?.update(st.status.signedIn ? st.rooms : [], { skip: (id) => disconnected(id) }); // P01: the shown room's seats, every 2.5 s
    if (st.active !== 'all') {
      const t = activeTab();
      if (t && (t.roomId === roomId || t.familyId === roomId)) {
        const fam = viewOf(t.familyId);
        const v = viewOf(t.roomId) || fam;
        if (fam && v) {
          paintRoom(); // the same room: header, strip and rail in place; the line and the composer stay (W3: names, lead, mode)
          side.briefChanged();
          markHeld();
          paintThinking();
        }
      }
    }
  });
  subscribe('rooms:line', ({ roomId, entries, why }) => {
    if (disconnected(roomId)) return;
    const cur = currentRoomId();
    if (roomId === cur && st.shown) {
      line.add(entries, { why });
      if (entries.some((e) => e.kind === 'fact' && e.meta && e.meta.turn)) {
        paintRoom(); // the floor chip follows the turn
      }
      markHeld();
      paintThinking();
    }
    const v = viewOf(roomId);
    const famId = v && v.room ? v.room.parent_id || v.room.id : roomId;
    const forMe = entries.some((e) => UNREAD_KINDS.has(e.kind) && e.author !== 'user' && e.meta && e.meta.to_user);
    const seen = st.shown && st.active === famId;
    if (forMe && !seen && !hiddenIds().has(famId) && st.tabs.some((t) => t.familyId === famId)) {
      const fam = viewOf(famId);
      st.newForMe.set(famId, fam ? fam.room.name : 'a room');
    }
    paintStrip();
    paintFlag();
    paintPill();
  });
  subscribe('rooms:scratchpad', ({ roomId }) => side.changed(roomId));
  subscribe('rooms:read', ({ roomId, entryId, handle, state }) => {
    if (roomId === currentRoomId()) {
      line.updateReads(entryId, handle, state);
      paintThinking();
    }
  });

  // ---- size: pinned from 1000 px, overlay below
  const ro = new ResizeObserver(() => {
    if (destroyed) return;
    const w = Math.round(root.getBoundingClientRect().width);
    if (w && w !== st.width) {
      const wasPinned = pinned();
      const wasWide = wide();
      const wasCan = canPin();
      const wasSlim = st.width < SLIM_UNDER;
      st.width = w;
      if ((wasPinned !== pinned() || wasWide !== wide() || wasCan !== canPin() || wasSlim !== st.width < SLIM_UNDER) && st.status.signedIn) {
        st.railOpen = false;
        paint();
      } else {
        paintStrip();
        paintFlag();
      }
      syncToolLayer();
    }
  });
  ro.observe(root);

  loadTabs();
  const initialEpoch = accountEpoch;
  window.wb.rooms.status().then((s) => {
    if (destroyed || initialEpoch !== accountEpoch) return;
    accountId = s.accountId || null;
    st.status = { ...st.status, ...s };
    paint();
    if (s.signedIn) {
      window.wb.rooms.list().then((r) => {
        if (!destroyed && initialEpoch === accountEpoch && r && r.ok) {
          st.rooms = r.value || [];
          paint();
          // Like the sign-in path: a room restored from the saved tabs whose first load came before this answer
          // (and so showed nothing) loads now, without a click.
          if (st.shown && currentRoomId() && (lineRetryTimer != null || lineFailBox || line.state().roomId !== currentRoomId())) openLine();
        }
      });
    }
  });

  return {
    el: root,
    personColor,
    enterPref,
    canChangeFiles: () => side.canChangeFiles(),
    starterHidden:()=>starter?.hidden()===true,
    starterVisibilityVersion:()=>starterVisibilityVersion,
    starterVisibilityReady:()=>!destroyed&&!!starter&&canUseStarter(),
    starterSettingsOperation:()=>{
      const generation=starterSettingsGeneration;
      return ()=>!destroyed&&st.shown&&st.active==='all'&&canUseStarter()&&starter?.hidden()===true&&generation===starterSettingsGeneration;
    },
    setStarterHidden:value=>!destroyed&&canUseStarter()?starter?.setHidden(value)===true:false,
    openToolSide: (key, src, o) => openToolSide(key, src, o),
    /** A module's full page as a tab in the strip (the web; on a phone the full-screen layer). */
    openToolPage: (o) => openToolPage(o),
    closeToolPage: (key) => closeToolPage(key),
    showToolPage: (key) => { if (destroyed || !toolPageOf(key)) return false; activate(key); return true; },
    /** S4 step 6: the app's theme changed; every tool page gets the checked roles again. */
    themeChanged() {
      if (destroyed) return;
      paint();
      line.recolor?.();cmp.recolor?.();
      for (const e of toolLinks.values()) e.link.post({ event: 'theme', payload: themePayload() });
    },
    /** S4 step 6: a rooms.tasks event for one tool page (the module host checked its family), at most 4 a second. */
    toolEvent(key, event, payload) {
      if (destroyed || event !== 'rooms.tasks') return;
      const e = toolLinks.get(key);
      if (!e) return;
      e.pending = payload;
      if (e.timer) return; // a trailing send is already due; it carries the latest payload
      const since = nowMs() - e.lastAt;
      if (since >= 250) sendToolEvent(e);
      else e.timer = setTimeout(() => sendToolEvent(e), 250 - since);
    },
    closeToolSide: (key) => closeToolSide(key),
    toolCardsChanged() {
      if (destroyed) return;
      const a = document.activeElement;
      refocusCard = a && a.dataset && a.dataset.toolcard ? a.dataset.toolcard : null;
      paintRailResults();
      syncToolsButton();
    },
    refreshLocalState() { if (!destroyed) { paint(); cmp.refreshFilesAvailability?.(); side.refreshNoteAttachments?.(); ensureLineLoaded(); } },
    setShown(on) {
      if (destroyed) return;
      if(!!on!==st.shown)invalidateStarterSettings();
      const becameVisible = !!on && !st.shown;
      if (becameVisible) lastShown = undefined; // the next rail paint tells the room again
      if (!on) {
        clearActivity();
        void starter?.shown(null);
        lineToken++; closeInlineTerminal(); viewer.hide(); closePageMenus();
        clearInterval(st.retryTick); st.retryTick = null;
        for (const f of finds.values()) clearTimeout(f.timer);
        for (const cleanup of [...outsideCleanups]) cleanup();
      }
      line.setVisible?.(!!on);
      st.shown = !!on;
      notificationBanner?.update();
      syncTemplates();
      if (!on) emitShown(null, null); // no room is shown: a card bound to it goes stale (a builder, finding 5)
      paintAgentWizard();
      if (on && st.active !== 'all') {
        st.newForMe.delete(st.active);
        paintPill();
        if (becameVisible || !line.state().roomId) {
          paintRoom();
          openLine();
        } else {
          tellVisible();
        }
      } else {
        tellVisible();
      }
      paintFlag();
    },
    destroy() {
      try { enterChan && enterChan.close(); } catch { /* none */ }
      if (destroyed) return;
      closeAllToolPages();
      toolLayer = 'gone'; if (document.documentElement?.dataset) delete document.documentElement.dataset.wbToollayer; for (const n of [roomHead, rail, main, strip]) n.inert = false;
      guardIn.remove(); guardOut.remove(); if (typeof document.querySelector === 'function' && document.querySelector('.wb-skip')) document.querySelector('.wb-skip').inert = false;
      invalidateStarterSettings();
      agentWizard?.destroy();
      notificationBanner?.destroy();
      needs?.dispose();
      templateMount?.destroy();
      clearActivity();
      emitShown(null, null);
      destroyed = true; starter?.destroy(); st.shown = false; accountEpoch++; lineToken++; recipeAsk++;
      for (const off of subscriptions.splice(0)) off();
      ro.disconnect(); composerObserver.disconnect();
      document.removeEventListener('pointerdown', railOutside, true);
      for (const cleanup of [...outsideCleanups]) cleanup();
      clearInterval(st.retryTick); st.retryTick = null;
      for (const f of finds.values()) clearTimeout(f.timer);
      finds.clear(); filters.clear(); recipeColors.clear();
      closeInlineTerminal(false);
      for (const dlg of terminalDialogs) dlg.close();
      terminalDialogs.clear();
      viewer.hide(); closePageMenus(); people.resetAccount(); seatsSheet?.close(); toolsSheet?.close(false); chatsSheet?.close(false); needs?.reset(); side.resetAccount();
      cmp.destroy?.(); line.destroy?.();
      st.rooms = []; st.tabs = []; st.newForMe.clear();
      root.remove();
    },
    openRail,
    closeRail,
    /** The self-test's: the reply prefill's one-time hint as on a first run. */
    resetHint: () => cmp.resetHint(),
    /** W3b: back from a seat's terminal: the room's tab, at that room (a workgroup opens in its family). */
    showRoom: (roomId) => openRoom(familyOf(roomId), roomId),
    showAll: () => activate('all'), // the web navigation's back arrow and the Workrooms destination: the rooms list
    toggleRail: () => (st.railOpen ? closeRail() : openRail()),
    openRoom,
    activate,
    // the self-test's hand
    state: () => ({ ...st, terminal: inlineView ? { roomId: inlineView.roomId, seatId: inlineView.seatId } : null, newForMe: [...st.newForMe.keys()], line: line.state(), viewer: viewer.state(), composer: cmp.state(), side: side.state(), pinned: pinned(), railVisible: !rail.hidden }),
    composer: cmp,
  };
}
