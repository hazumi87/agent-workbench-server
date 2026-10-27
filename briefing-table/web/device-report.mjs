/* USER DEVICE PRESENCE, the page half [Owner room [ref]: "a way to tell where the user is coming from ... phone or
 * laptop ... presence info that agents can query"].
 *
 * Each page that a person looks at reports a COARSE device descriptor to POST /api/presence/device: on load, when it
 * becomes visible, and about every 60 s while visible. The fields (src/engine/user-presence.ts validates the same list):
 *   device    random id this browser keeps in localStorage `hwb.device.id` (per-tab id if storage is blocked)
 *   instance  random id of THIS page load (a shell with three tabs is one device, three instances)
 *   class     phone | tablet | desktop        (phone: screen's short side < 700 or viewport <= 600; tablet: touch, wider)
 *             'laptop' is NEVER sent: a laptop and a desktop cannot be told apart from a web page. Mouse = 'desktop'.
 *   surface   browser | shell-tab | native-window
 *   page      room | workbench | manager | solo
 *   browser   Safari | Chrome | Edge | Firefox | Other     os   iOS | Android | macOS | Windows | Linux | Other
 *   viewport  {w,h}   standalone (installed PWA)   visible   label (the solo CLIENT_LABEL, e.g. "iPhone window")
 * NOT sent: IP address, the user-agent string, fonts/canvas/anything fingerprint-shaped.
 *
 * ONE timer rule: a page that already polls calls `tickDeviceReport(page)` from that poll (it throttles itself to 60 s);
 * a page with no poll calls `startDeviceReport(page)`, which owns the only timer. */
import { touchInput } from '/soft-keyboard.mjs';
import { isHidden, onVisibility } from '/page-visibility.mjs';

const EVERY_MS = 60000;
const MIN_GAP_MS = 4000; // a burst of visibility events sends once

function rid() {
  try {
    const a = new Uint8Array(9);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
  } catch {
    return Math.random().toString(36).slice(2, 16).padEnd(10, '0');
  }
}
const INSTANCE = rid();
let tabDevice = null;

export function deviceId() {
  try {
    let id = localStorage.getItem('hwb.device.id');
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = rid();
      localStorage.setItem('hwb.device.id', id);
    }
    return id;
  } catch {
    tabDevice = tabDevice || rid(); // storage blocked: this tab is its own device
    return tabDevice;
  }
}

/** The label solo.js has always sent with a takeControl: "iPhone window" / "Windows browser". */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const dev = /iPad/.test(ua) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
      : /Macintosh/.test(ua) ? 'Mac'
        : /Android/.test(ua) ? 'Android'
          : /Windows/.test(ua) ? 'Windows' : 'browser';
  /* A desktop window-host window embeds this page in the shell; a plain remote
     browser tab does not. That split is what usefully separates "the machine at
     my desk" from "the laptop I'm holding" — both are Windows. */
  return `${dev} ${window.parent !== window ? 'window' : 'browser'}`;
}

export function browserFamily(ua) {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}
export function osFamily(ua, maxTouch) {
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Macintosh/.test(ua)) return maxTouch > 1 ? 'iOS' : 'macOS'; // an iPad in desktop-class mode says Macintosh
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux|X11|CrOS/.test(ua)) return 'Linux';
  return 'Other';
}

function nativeHost() {
  try {
    return !!(window.chrome?.webview || window.top?.chrome?.webview);
  } catch {
    return !!window.chrome?.webview;
  }
}
function surface() {
  if (nativeHost()) return 'native-window';
  return window.parent !== window ? 'shell-tab' : 'browser';
}

/** phone: the physical screen's short side is under 700 (touch-ui.phoneSized) or the viewport is <= 600 wide.
 *  tablet: a finger is the input, wider than a phone. Everything else: desktop (laptop cannot be told apart). */
export function deviceClass() {
  let short = 0;
  try { short = Math.min(Number(screen.width) || 0, Number(screen.height) || 0); } catch { /* no screen */ }
  const touch = touchInput();
  if (touch && ((short > 0 && short < 700) || window.innerWidth <= 600)) return 'phone';
  if (touch) return 'tablet';
  return window.innerWidth <= 600 ? 'phone' : 'desktop';
}

export function descriptor(page) {
  const ua = navigator.userAgent || '';
  let standalone = false;
  try { standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { /* old */ }
  return {
    device: deviceId(),
    instance: INSTANCE,
    class: deviceClass(),
    surface: surface(),
    page,
    browser: browserFamily(ua),
    os: osFamily(ua, navigator.maxTouchPoints ?? 0),
    viewport: { w: Math.round(window.innerWidth), h: Math.round(window.innerHeight) },
    standalone,
    visible: !isHidden(),
    label: deviceLabel(),
  };
}

let lastSent = 0;
export async function reportDevice(page, force = false) {
  const now = Date.now();
  if (!force && now - lastSent < MIN_GAP_MS) return;
  lastSent = now;
  try {
    await fetch('/api/presence/device', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(descriptor(page)),
      keepalive: true,
    });
  } catch {
    /* presence must never be able to fail the page that sends it */
  }
}

let wired = null;
function wire(page) {
  if (wired) return;
  wired = page;
  onVisibility(() => { void reportDevice(wired, true); }); // visible -> active; hidden -> tells the engine this instance left (never throttled)
  addEventListener('pagehide', () => { void reportDevice(wired, true); });
  void reportDevice(page, true); // on load
}

/** For a page that already polls: call from that poll. Sends on load, on visibility change, and at most every 60 s. */
export function tickDeviceReport(page) {
  wire(page);
  if (!isHidden() && Date.now() - lastSent >= EVERY_MS) void reportDevice(page, true);
}

/** For a page with no poll of its own: owns the single 60 s timer. */
export function startDeviceReport(page) {
  wire(page);
  setInterval(() => { if (!isHidden()) void reportDevice(page, true); }, EVERY_MS);
}
