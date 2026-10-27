globalThis.__WB_WEB__ = {"version":"0.24.0","argv":[],"modules":[{"id":"cli-manager","name":"CLI Manager","version":"0.7.0","description":"The Terminals tab: a grid of terminal panes; a hidden one keeps running.","class":"cli-manager","parent":null,"icon":"dashboard","entry":null,"main":"index.js","settingsSchema":null,"permissions":["ui.tab","sessions.read"],"requires":[],"core":true,"defaultEnabled":true,"source":"bundled","url":"modules/cli-manager/","error":null,"tool":null},{"id":"workrooms","name":"Workrooms","version":"0.1.0","description":"The Workrooms tab: your rooms, their people and agents, the conversation, notes and files.","class":"workrooms","parent":null,"icon":"apps","entry":"ui/index.html","main":"index.js","settingsSchema":{"label":{"type":"string","title":"Tab label","default":"Workrooms","maxLength":24,"hint":"What the tab in the top bar says."},"terminals":{"type":"boolean","title":"Open seats in Terminals","chip":"Preview","default":false,"hint":"Watch a seat's CLI as a pane. You only type after you choose Take control."},"server":{"type":"string","title":"Workrooms server URL","default":"","maxLength":200,"hint":"Leave empty to use your account's, or the built-in, address. https://host or https://host:port only."}},"permissions":["ui.tab","settings"],"requires":[],"core":false,"defaultEnabled":true,"source":"bundled","url":"modules/workrooms/","error":null,"tool":null},{"id":"tasks","name":"Tasks","version":"0.1.0","description":"The room's tasks: a card in each room's rail with its % done and activity, and a side view with the list and the timeline.","class":"tool","parent":null,"icon":"task_alt","entry":null,"main":"index.js","settingsSchema":null,"permissions":["ui.railCard","ui.side","ui.window","rooms.tasks.read","rooms.tasks.write"],"requires":[],"core":false,"defaultEnabled":true,"source":"bundled","url":"modules/tasks/","error":null,"tool":{"provides":["room.tasks"],"role":"tasks","accepts":[],"contexts":["workroom"],"actions":[{"name":"add-task","title":"Add a task","provides":"room.tasks","input":{"title":{"type":"string","title":"Task","maxLength":200}},"output":{"kind":"text"},"contexts":["workroom"],"timeoutMs":10000}],"style":null,"extends":null,"exposes":[]}},{"id":"image-viewer","name":"Pictures","version":"0.1.0","description":"Opens a message's pictures in the side column: zoom, pins and boxes with letters, and marks are saved next to the picture. View-only once the message is sent.","class":"tool","parent":null,"icon":"draw","entry":null,"main":null,"settingsSchema":null,"permissions":["ui.side"],"requires":[],"core":false,"defaultEnabled":true,"source":"bundled","url":"modules/image-viewer/","error":null,"tool":{"provides":["image.view"],"role":"viewer","accepts":[],"contexts":["message-attachment"],"actions":[{"name":"open","title":"Open the pictures","provides":"image.view","input":{},"output":{"kind":"text"},"contexts":["message-attachment"],"timeoutMs":10000}],"style":null,"extends":null,"exposes":[],"claims":[{"kind":"type","accepts":["image/*"]}]}}]};
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name2 in all)
      __defProp(target, name2, { get: all[name2], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // web/shims/buffer.js
  var require_buffer = __commonJS({
    "web/shims/buffer.js"(exports, module) {
      "use strict";
      init_globals();
      var Buffer3 = class _Buffer extends Uint8Array {
        static from(value, encoding) {
          if (typeof value === "string") {
            if (encoding === "base64") {
              const bin = atob(value);
              const out2 = new _Buffer(bin.length);
              for (let i = 0; i < bin.length; i += 1) out2[i] = bin.charCodeAt(i);
              return out2;
            }
            const bytes = new TextEncoder().encode(value);
            const out = new _Buffer(bytes.length);
            out.set(bytes);
            return out;
          }
          if (value instanceof ArrayBuffer) return new _Buffer(value);
          if (ArrayBuffer.isView(value) || Array.isArray(value)) {
            const out = new _Buffer(value.length);
            out.set(value);
            return out;
          }
          throw new TypeError("Buffer.from: unsupported value");
        }
        static alloc(n) {
          return new _Buffer(n);
        }
        static isBuffer(v) {
          return v instanceof _Buffer;
        }
        static byteLength(value) {
          if (typeof value === "string") return new TextEncoder().encode(value).length;
          return value.byteLength;
        }
        static concat(list) {
          const total = list.reduce((n, b) => n + b.length, 0);
          const out = new _Buffer(total);
          let at = 0;
          for (const b of list) {
            out.set(b, at);
            at += b.length;
          }
          return out;
        }
        toString(encoding) {
          if (encoding === "base64") {
            let bin = "";
            for (let i = 0; i < this.length; i += 32768) bin += String.fromCharCode.apply(null, this.subarray(i, i + 32768));
            return btoa(bin);
          }
          return new TextDecoder("utf-8").decode(this);
        }
      };
      module.exports = { Buffer: Buffer3 };
    }
  });

  // web/shims/process.js
  var require_process = __commonJS({
    "web/shims/process.js"(exports, module) {
      "use strict";
      init_globals();
      var meta = typeof globalThis !== "undefined" && globalThis.__WB_WEB__ || {};
      module.exports = { env: {}, platform: "linux", argv: Array.isArray(meta.argv) ? meta.argv.slice() : [], versions: {} };
    }
  });

  // web/shims/globals.js
  var import_buffer, import_process;
  var init_globals = __esm({
    "web/shims/globals.js"() {
      import_buffer = __toESM(require_buffer());
      import_process = __toESM(require_process());
    }
  });

  // web/session-marker.js
  var require_session_marker = __commonJS({
    "web/session-marker.js"(exports, module) {
      "use strict";
      init_globals();
      module.exports = { SESSION_MARKER: Object.freeze({ homelab_session: "browser-session" }), SECRETS_FILE: "/wb-web/rooms.secrets" };
    }
  });

  // web/session-probe.js
  var require_session_probe = __commonJS({
    "web/session-probe.js"(exports, module) {
      "use strict";
      init_globals();
      var { SESSION_MARKER, SECRETS_FILE } = require_session_marker();
      var ME = "/api/rooms/me";
      function askEngine({ XHR = globalThis.XMLHttpRequest, origin = globalThis.location && globalThis.location.origin } = {}) {
        if (typeof XHR !== "function") return { state: "unknown" };
        try {
          const x = new XHR();
          x.open("GET", ME, false);
          x.setRequestHeader("accept", "application/json");
          x.send(null);
          if (!x.status || x.status >= 500) return { state: "unknown" };
          let from = ME;
          try {
            from = new URL(x.responseURL || ME, origin || "http://localhost").pathname;
          } catch (e) {
            from = "";
          }
          if (from !== ME || x.status !== 200) return { state: "out" };
          let body = null;
          try {
            body = JSON.parse(x.responseText);
          } catch (e) {
            body = null;
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) return { state: "out" };
          return { state: "in", handle: String(body.handle || body.name || "").trim() || "person" };
        } catch (e) {
          return { state: "unknown" };
        }
      }
      function syncMarker({ answer: answer2, fs }) {
        if (answer2.state === "in") {
          fs.writeFileSync(SECRETS_FILE, JSON.stringify({ cookies: SESSION_MARKER }));
          return { signedIn: true, handle: answer2.handle };
        }
        if (answer2.state === "out") {
          try {
            fs.rmSync(SECRETS_FILE, { force: true });
          } catch (e) {
          }
          return { signedIn: false };
        }
        return { signedIn: fs.existsSync(SECRETS_FILE), unknown: true };
      }
      module.exports = { askEngine, syncMarker, ME };
    }
  });

  // web/person-storage.js
  var require_person_storage = __commonJS({
    "web/person-storage.js"(exports, module) {
      "use strict";
      init_globals();
      var PREFIX = "wbp.";
      var LAST = PREFIX + "#last";
      var LEGACY = /^wb[-.]/;
      var enc = (s) => encodeURIComponent(String(s)).replace(/\./g, "%2E");
      function createPersonStorage({ backing }) {
        let ns = null;
        const keysOf = () => {
          const out = [];
          for (let i = 0; i < backing.length; i++) out.push(backing.key(i));
          return out;
        };
        const wipe = () => {
          for (const k of keysOf()) if (k.startsWith(PREFIX)) backing.removeItem(k);
        };
        const wipeLegacy = () => {
          for (const k of keysOf()) if (!k.startsWith(PREFIX) && LEGACY.test(k)) backing.removeItem(k);
        };
        const mine = () => ns ? keysOf().filter((k) => k.startsWith(ns)) : [];
        const getItem = (k) => ns ? backing.getItem(ns + String(k)) : null;
        const setItem = (k, v) => {
          if (ns) backing.setItem(ns + String(k), String(v));
        };
        const removeItem = (k) => {
          if (ns) backing.removeItem(ns + String(k));
        };
        const clearMine = () => {
          for (const k of mine()) backing.removeItem(k);
        };
        const key = (n) => {
          const k = mine()[n];
          return k === void 0 ? null : k.slice(ns.length);
        };
        const methods = { getItem, setItem, removeItem, clear: clearMine, key };
        const facade = new Proxy({}, {
          get(_, prop) {
            if (prop === "length") return mine().length;
            if (Object.prototype.hasOwnProperty.call(methods, prop)) return methods[prop];
            if (typeof prop === "symbol") return void 0;
            const v = getItem(prop);
            return v === null ? void 0 : v;
          },
          set(_, prop, value) {
            if (typeof prop === "string") setItem(prop, value);
            return true;
          },
          deleteProperty(_, prop) {
            if (typeof prop === "string") removeItem(prop);
            return true;
          },
          has(_, prop) {
            return prop === "length" || Object.prototype.hasOwnProperty.call(methods, prop) || typeof prop === "string" && getItem(prop) !== null;
          },
          ownKeys() {
            return mine().map((k) => k.slice(ns.length));
          },
          getOwnPropertyDescriptor(_, prop) {
            const v = typeof prop === "string" ? getItem(prop) : null;
            return v === null ? void 0 : { value: v, enumerable: true, configurable: true, writable: true };
          }
        });
        function activate(person) {
          if (person === void 0) {
            const last = backing.getItem(LAST);
            ns = last ? PREFIX + last + "." : null;
            return;
          }
          if (person === null) {
            wipe();
            wipeLegacy();
            ns = null;
            return;
          }
          const id = enc(person);
          wipeLegacy();
          if (backing.getItem(LAST) !== id) wipe();
          backing.setItem(LAST, id);
          ns = PREFIX + id + ".";
        }
        function clear() {
          wipe();
          wipeLegacy();
          ns = null;
        }
        return { facade, activate, clear };
      }
      var WORDS2 = /(authorization|bearer\s|password|passwd|api[_-]?key|secret|"token"\s*:|token\s*[=:])/i;
      var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
      function looksSecret(value) {
        const s = String(value);
        if (WORDS2.test(s)) return true;
        return /[A-Za-z0-9+/_=-]{40,}/.test(s.replace(UUID, ""));
      }
      function install({ win = globalThis, answer: answer2 }) {
        const real = win.localStorage;
        const ps = createPersonStorage({ backing: real });
        ps.activate(answer2.state === "in" ? answer2.handle : answer2.state === "out" ? null : void 0);
        Object.defineProperty(win, "localStorage", { configurable: true, enumerable: true, get: () => ps.facade });
        const clear = () => {
          ps.clear();
          try {
            const s = win.sessionStorage;
            for (let i = s.length - 1; i >= 0; i--) {
              const k = s.key(i);
              if (k && /^wb[-.]/.test(k)) s.removeItem(k);
            }
          } catch (e) {
          }
        };
        return { clear, facade: ps.facade };
      }
      module.exports = { createPersonStorage, looksSecret, install, PREFIX };
    }
  });

  // web/shims/fs.js
  var require_fs = __commonJS({
    "web/shims/fs.js"(exports, module) {
      "use strict";
      init_globals();
      var { Buffer: Buffer3 } = require_buffer();
      var KEY = "wb-web-fs";
      var files = null;
      function load() {
        if (files) return files;
        files = /* @__PURE__ */ new Map();
        try {
          const saved = JSON.parse(globalThis.localStorage.getItem(KEY) || "{}");
          for (const [p, text3] of Object.entries(saved)) if (typeof text3 === "string") files.set(p, text3);
        } catch (e) {
        }
        return files;
      }
      function save() {
        try {
          globalThis.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(load())));
        } catch (e) {
        }
      }
      var enoent = (p) => Object.assign(new Error("ENOENT: no such file, " + p), { code: "ENOENT" });
      function readFileSync(p, options) {
        const text3 = load().get(String(p));
        if (text3 === void 0) throw enoent(p);
        const encoding = typeof options === "string" ? options : options && options.encoding;
        return encoding ? text3 : Buffer3.from(text3);
      }
      function writeFileSync(p, data) {
        load().set(String(p), typeof data === "string" ? data : Buffer3.from(data).toString("utf8"));
        save();
      }
      function mkdirSync() {
      }
      function rmSync(p, options) {
        const had = load().delete(String(p));
        if (!had && !(options && options.force)) throw enoent(p);
        save();
      }
      function existsSync(p) {
        return load().has(String(p));
      }
      function statSync(p) {
        const text3 = load().get(String(p));
        if (text3 === void 0) throw enoent(p);
        return { size: new TextEncoder().encode(text3).length, isFile: () => true, isDirectory: () => false };
      }
      function _reset() {
        files = /* @__PURE__ */ new Map();
        try {
          globalThis.localStorage.removeItem(KEY);
        } catch (e) {
        }
      }
      module.exports = { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, _reset };
    }
  });

  // web/channel-map.json
  var require_channel_map = __commonJS({
    "web/channel-map.json"(exports, module) {
      module.exports = {
        version: 1,
        outbound: {
          "about:licenses": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "the updater, restart and licences window do not exist in the web build: a click is a loud PlatformOnly, not a silent hang (security review L1)"
          },
          "accounts:begin": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:cancel": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:manage": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:name": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:reopen": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:request": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:request-act": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:requestable": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:rescope": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:select": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:servers": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:signout": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:state": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "accounts:test-server": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "agent-setup:call": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop first-run agent setup: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "app:restart": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "the updater, restart and licences window do not exist in the web build: a click is a loud PlatformOnly, not a silent hang (security review L1)"
          },
          "arrange:tabs": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "broker:end": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "POST /api/sessions/:paneid/end"
          },
          "broker:groups": {
            class: "forward",
            owner: "web",
            status: "done",
            note: `GET /api/sessions (the engine's live panes, hosted profile) as the one group "This server"; polled every 15 s, emitted only when it changed. Until the engine owner deploys that route: no group`
          },
          "broker:modules": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "the realm and a pinned broker are desktop things; module management has no web meaning"
          },
          "clipboard:write": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "browser API with the same contract"
          },
          "codex:*": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "the Codex connector runs as an engine seat, not in the page"
          },
          "concierge:create": {
            class: "forward",
            owner: "web",
            status: "todo",
            note: "Concierge dock (lowest priority)"
          },
          "concierge:reload-": {
            class: "forward",
            owner: "web",
            status: "todo",
            note: "Concierge dock (lowest priority)"
          },
          "concierge:reload-*": {
            class: "forward",
            owner: "web",
            status: "todo",
            note: "Concierge dock (lowest priority)"
          },
          "console:bounds": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:handoff-again": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:hide": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:info": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:open": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:reload": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:test-authenticator": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:test-credentials": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:test-eval": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:test-focus": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:test-navigate": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:test-shot": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "console:test-wait-load": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "debug:log": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op (modules:theme feeds module windows, which the web build does not have)"
          },
          "debug:set": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op (modules:theme feeds module windows, which the web build does not have)"
          },
          "drag:end": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "drag:move": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "drag:start": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "flyout:focus": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "keys:check-added": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:connect": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:forget": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:make": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:older": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:refresh": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:refresh-cancel": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:remind": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:remove-everywhere": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:retire-again": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:snooze": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "keys:state": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "local-setup:call": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop local-rooms setup: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "local-setup:changed": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop local-rooms setup events: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "local-setup:notes-answer": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop local-rooms setup notes: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "local-setup:notes-check": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop local-rooms setup notes: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "machine:info": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "browser API with the same contract"
          },
          "modules:card-admit": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: src/module-cards.js on the cached catalog (cards carry no data; the engine admits every call)"
          },
          "modules:card-release": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: src/module-cards.js release"
          },
          "modules:frame-expect": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: the page guard (same origin, enabled entry under its own prefix, ui/ page, wbl nonce); the engine M1 route enforces"
          },
          "modules:rescan": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: POST /api/modules/rescan (M2)"
          },
          "modules:set": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: PUT /api/modules/:id (M2), answers the list; refused -> re-read so the page snaps back"
          },
          "modules:storage": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: POST /api/modules/:id/storage (M3), keyed per (person, module) in the engine"
          },
          "modules:theme": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op (modules:theme feeds module windows, which the web build does not have)"
          },
          "modules:window-open": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: refused in words (501) until pop-outs exist in the web app"
          },
          "pane:active": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op (modules:theme feeds module windows, which the web build does not have)"
          },
          "prefs:get": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "this browser's preferences in localStorage (no secret ever); the Concierge fields keep their defaults until slice 4 moves them to the engine"
          },
          "prefs:set": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "this browser's preferences in localStorage; the desktop shell setting is meaningless here and ignored"
          },
          "programs:detect": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "detection spawns a probe on the person's machine; the engine host has no such route (dropped for the pilot)"
          },
          "programs:list": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "the catalog bundled from vendors/*/vendor.json; enabled flags and default settings in this browser; detection is unknown (detected: null)"
          },
          "programs:set": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "enabled flags and default settings in this browser (Shell cannot be turned off)"
          },
          "recipes:check-folder": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "GET /api/fs/dirs: the folder is checked on the engine host, inside its file root"
          },
          "recipes:delete": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "GET/POST/DELETE /api/recipes: the engine is the recipe store (web/handlers/recipes.js, web/lib/recipe-map.js); a recipe a seat still uses is refused with the engine's reason"
          },
          "recipes:duplicate": {
            class: "forward",
            owner: "web",
            status: "done",
            note: 'GET/POST/DELETE /api/recipes: the engine is the recipe store (web/handlers/recipes.js, web/lib/recipe-map.js); a copy is a new recipe named "<name> copy"'
          },
          "recipes:folder-form": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "the desktop token contract; the dialog is slice 3's server-side picker (window.wb.web.files.chooseFolder)"
          },
          "recipes:import-cancel": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "import and folder choice in the browser"
          },
          "recipes:import-commit": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "import and folder choice in the browser"
          },
          "recipes:import-folder": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "import and folder choice in the browser"
          },
          "recipes:import-open": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "import and folder choice in the browser"
          },
          "recipes:list": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "GET/POST/DELETE /api/recipes: the engine is the recipe store (web/handlers/recipes.js, web/lib/recipe-map.js)"
          },
          "recipes:pick-folder": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: 'the desktop token contract; needs window.wb.web.files.chooseFolder (slice 3, a builder); says "unavailable" until it is mounted, never a guessed path'
          },
          "recipes:save": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "GET/POST/DELETE /api/recipes: the engine is the recipe store (web/handlers/recipes.js, web/lib/recipe-map.js); a chosen folder is claimed by its token"
          },
          "recipes:setup": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "runs a program's prepare step in a folder over a pinned broker; no engine route (dropped for the pilot)"
          },
          "recipes:sync": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "nothing to sync: the engine table is the one copy; answers {ok:true}"
          },
          "room-templates:call": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop room templates: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "room-templates:discard-request": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop room-template discard confirmation: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "rooms:assets": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:commands": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:connection": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:create": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:deliver-held": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:download": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "the browser's download of the file's bytes (an <a download> on a blob typed application/octet-stream, so it is never rendered)"
          },
          "rooms:draft": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:draft-set": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:family-check": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:history-cancel": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:history-export": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:history-get": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:history-set": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:history-start": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:image": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:line": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:list": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:me": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:note": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:note-attach": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:note-close": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:note-create": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:note-set": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:notes": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:open-window": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "a tab on the engine's own raw route (sandboxed by the engine's CSP), never a blob: URL, which would run an uploaded SVG or HTML as this page"
          },
          "rooms:patch": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:pick-files": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "the browser's file input (a person's click opens the chooser); up to 10 files, bytes only up to 25 MB, as on the desktop"
          },
          "rooms:picture": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:post": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:presence": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:recipes": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:retry": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:room": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:scratch": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:scratch-order": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:scratch-remove": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:scratch-upload": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:search": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-add": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-close-window": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-disconnect": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-end": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "the real handler refuses unless a local shell seat, which a hosted engine never has"
          },
          "rooms:seat-history": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-move": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-patch": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-profile": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-reload": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-reload-preview": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-remove": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seat-start": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:seen": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:settings": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:signin": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:signout": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:state": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:status": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:tasks": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: POST /api/modules/:id/rooms/:roomId/tasks, admitted IN THE ENGINE (M4); replaces the rooms core desktop admission"
          },
          "rooms:tasks-approve": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: POST .../tasks/approve, the engine one-use purge token (M4)"
          },
          "rooms:thumb": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:visible": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:wake-deliver": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "rooms:workgroup": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "real src/rooms core behind shims"
          },
          "scratchpad:*": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "Desktop personal Scratchpad storage/location is absent; browser per-room view uses wb.web.files and /api/rooms/:id/files."
          },
          "scratchpad:location": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "Desktop personal Scratchpad storage/location is absent; browser per-room view uses wb.web.files and /api/rooms/:id/files."
          },
          "server:forget-host-key": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "server:host-key": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:action": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:approve": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:decline": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:get": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:grant": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:install": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:list": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:people": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:policy": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:refresh-me": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:reopen": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:revoke": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "servers:role": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop accounts, servers tab, key fallback, realm console: one person per server, no realm"
          },
          "session:attached": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "releases the bytes held for a page that has just mapped the id; sends the size"
          },
          "session:close": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "POST /api/sessions/:paneid/end for a pane the person started; a seat viewer only lets go"
          },
          "session:create": {
            class: "forward",
            owner: "web",
            status: "done",
            note: `recipe: POST /api/recipes/:id/launch then attach spawn; plain shell: the engine recipe "Shell"; attachOnly and a seat's terminal attach to an existing pane and never spawn. web/handlers/session.js on the engine's WS /pty with the sign-in cookie (web/lib/pty-link.js)`
          },
          "session:hide": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "multi-window flyout and tab moves"
          },
          "session:hideRemote": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "multi-window flyout and tab moves"
          },
          "session:input": {
            class: "forward",
            owner: "web",
            status: "done",
            note: 'input frame while this tab holds the keyboard lease; otherwise "typing paused", never queued'
          },
          "session:meta": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "the tab name and hue, kept in the page's session list (not written back to the recipe)"
          },
          "session:moveHere": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "multi-window flyout and tab moves"
          },
          "session:open": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "no hidden sessions in a page: every session is open in it"
          },
          "session:permit": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "a one-use token: a CLI starts only from an explicit launch (60 s, spent once)"
          },
          "session:resize": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "resize frame, honoured only for the lease holder"
          },
          "session:retry": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "a permit relaunches (Run again, Restore, Start fresh, spawn); without one it only reattaches"
          },
          "session:seen": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "attention.ack frame"
          },
          "session:term-control": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "takeControl on /pty; there is no release frame on /pty, so releasing answers false"
          },
          "session:title": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "the tab title, kept in the page's session list"
          },
          "sessions:dismiss": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "POST /api/interrupted/dismiss, then the empty offer view"
          },
          "sessions:offer": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "honestly empty: the interrupted-sessions offer and Recently closed are a desktop disk store with no engine equivalent (dropped for the pilot)"
          },
          "sessions:remove": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "honestly empty (see sessions:offer); answers the empty offer view"
          },
          "sessions:restore-spec": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "nothing to restore: answers null, the desktop's own answer for a row that is not restorable"
          },
          "shell:open-external": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "browser API with the same contract"
          },
          "snapshot:reply": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "starter-rooms:call": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop starter workrooms: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "starter:terminal-intent": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "desktop starter-terminal intents: the feature flag is off in the web build (web/features.json argv is empty), so the page never receives its API; the web has its own first-login setup (the router gate), Add an agent and Recipes"
          },
          "startup:done": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op (modules:theme feeds module windows, which the web build does not have)"
          },
          "state:report": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op (modules:theme feeds module windows, which the web build does not have)"
          },
          "update:auto": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "the updater, restart and licences window do not exist in the web build: a click is a loud PlatformOnly, not a silent hang (security review L1)"
          },
          "update:check": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "the updater, restart and licences window do not exist in the web build: a click is a loud PlatformOnly, not a silent hang (security review L1)"
          },
          "update:restart": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "the updater, restart and licences window do not exist in the web build: a click is a loud PlatformOnly, not a silent hang (security review L1)"
          },
          "update:state": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "there is no updater in the web build: the state says so (nothing ready, nothing available)"
          },
          "win:close": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "win:closeEmpty": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op"
          },
          "win:maximize": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "win:minimize": {
            class: "platform-only",
            owner: "web",
            status: "done",
            note: "window chrome, multi-window tabs and drag"
          },
          "win:mode": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op (modules:theme feeds module windows, which the web build does not have)"
          },
          "window:theme": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "main-process bookkeeping with no web meaning: a harmless no-op (modules:theme feeds module windows, which the web build does not have)"
          }
        },
        inbound: {
          "accounts:access-news": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "accounts:changed": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "accounts:link": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "accounts:servers": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "accounts:signed-in": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "accounts:switched": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "app:show-servers": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "broker:groups": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "polled every 15 s while the page is visible; emitted when it changed"
          },
          "concierge:reload": {
            class: "forward",
            owner: "web",
            status: "todo",
            note: "Concierge dock"
          },
          "concierge:taken": {
            class: "forward",
            owner: "web",
            status: "todo",
            note: "Concierge dock"
          },
          "console:state": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "console:terminal": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "console:terminal-refused": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          debug: {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "debug stream: not sent in the web build"
          },
          "drop:clear": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "drop:preview": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          init: {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "sent by the web runtime after load"
          },
          "keys:progress": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "keys:resume": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "keys:state": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "modules:changed": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "web/handlers/modules.js: emitted from GET /api/modules at boot and from the engine modules.changed event"
          },
          "modules:frame-revoke": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build: no main denies navigations; the frame link ends itself on a second load (module-frame.js)"
          },
          "prefs:changed": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted after prefs:set"
          },
          "programs:changed": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted after programs:set"
          },
          "recipes:changed": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted after a recipe save, delete, duplicate or import with the fresh list"
          },
          "recipes:local-sync-error": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "the desktop's realm sync and offline server banner do not exist here: the engine table is the one copy"
          },
          "recipes:local-sync-status": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "the desktop's realm sync and offline server banner do not exist here: the engine table is the one copy"
          },
          "recipes:offline": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "the desktop's realm sync and offline server banner do not exist here: the engine table is the one copy"
          },
          "room-templates:view": {
            class: "forward",
            owner: "web",
            status: "todo",
            note: "first-run setup"
          },
          "rooms:account": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "rooms:line": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "rooms:read": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "rooms:room": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "rooms:rooms": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "rooms:scratchpad": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "rooms:seat": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "rooms:status": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "rooms:tasks": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted by the real rooms core"
          },
          "scratchpad:changed": {
            class: "forward",
            owner: "web",
            status: "todo",
            note: "server-side Scratchpad changes"
          },
          "session:adopt": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "emitted for each other running plain recipe pane after the page-load terminal, so a reload re-adopts what runs on the server (held until session:attached)"
          },
          "session:data": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "pane.data after the page has the id"
          },
          "session:exit": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "pane.exit of a plain shell: its tab closes"
          },
          "session:gap": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "the engine's replay after a reattach (reset, then write)"
          },
          "session:hide-req": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "session:moved-away": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "session:route": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "connecting, up, reconnecting, finished, spawn-failed, viewing, controlling, term-closed from the socket and pane frames"
          },
          "session:typing-paused": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "no keyboard lease or a down socket"
          },
          "sessions:offer": {
            class: "substitute",
            owner: "web",
            status: "done",
            note: "honestly empty (see sessions:offer outbound): never pushed"
          },
          "sessions:update": {
            class: "forward",
            owner: "web",
            status: "done",
            note: "the page's session list (rail and tabs)"
          },
          "snapshot:req": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "tab:activate": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "update:progress": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "update:ready": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          },
          "win:max": {
            class: "absent",
            owner: "web",
            status: "done",
            note: "never fires in the web build"
          }
        }
      };
    }
  });

  // web/runtime.js
  var require_runtime = __commonJS({
    "web/runtime.js"(exports, module) {
      "use strict";
      init_globals();
      var channelMap = require_channel_map();
      var handlers = /* @__PURE__ */ new Map();
      var listeners = /* @__PURE__ */ new Map();
      var inbound = /* @__PURE__ */ new Map();
      var eventHandlers = /* @__PURE__ */ new Map();
      var exposed = { events: {
        on(name2, fn) {
          if (!eventHandlers.has(name2)) eventHandlers.set(name2, /* @__PURE__ */ new Set());
          eventHandlers.get(name2).add(fn);
          return () => eventHandlers.get(name2).delete(fn);
        },
        off(name2, fn) {
          const set = eventHandlers.get(name2);
          if (set) set.delete(fn);
        },
        fire(name2, payload) {
          for (const fn of [...eventHandlers.get(name2) || []]) {
            try {
              fn(payload);
            } catch (e) {
              defect("ListenerError", "web.events:" + name2);
            }
          }
        }
      } };
      var defects = [];
      globalThis.__wbWebDefects = defects;
      var bannerEl = null;
      var meta = () => globalThis.__WB_WEB__ || {};
      var version = () => String(meta().version || "");
      function rowFor(channel, table) {
        if (table[channel]) return table[channel];
        const star = Object.keys(table).find((k) => k.endsWith("*") && channel.startsWith(k.slice(0, -1)));
        return star ? table[star] : null;
      }
      function banner() {
        if (bannerEl || !globalThis.document) return;
        bannerEl = document.createElement("div");
        bannerEl.id = "wb-web-banner";
        bannerEl.setAttribute("role", "alert");
        bannerEl.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#b00020;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:6px 10px;white-space:pre-wrap;max-height:30vh;overflow:auto";
        const attach = () => document.body.appendChild(bannerEl);
        if (document.body) attach();
        else document.addEventListener("DOMContentLoaded", attach);
      }
      function defect(kind, channel) {
        const seen = defects.find((d) => d.kind === kind && d.channel === channel);
        if (seen) seen.count += 1;
        else defects.push({ kind, channel, count: 1 });
        globalThis.__wbWebDefects = defects;
        banner();
        if (bannerEl) bannerEl.textContent = "Web build: " + defects.length + " call(s) that do not work here\n" + defects.map((d) => d.kind + "(" + d.channel + ")" + (d.count > 1 ? " x" + d.count : "")).join("\n");
      }
      function fail2(kind, channel, code) {
        defect(kind, channel);
        return Object.assign(new Error(kind + ": " + channel), { name: kind, code, channel });
      }
      var platformOnly = (what) => fail2("PlatformOnly", what, "platform-only");
      var event = () => ({ sender: { id: 1, isDestroyed: () => false, getURL: () => globalThis.location ? globalThis.location.href : "" }, senderFrame: {} });
      async function invoke(channel, args) {
        const row = rowFor(channel, channelMap.outbound);
        if (!row) throw fail2("UnclassifiedChannel", channel, "unclassified");
        if (row.class === "platform-only") throw platformOnly(channel);
        if (row.class === "absent") throw Object.assign(new Error("absent: " + channel), { code: "absent", channel });
        const fn = handlers.get(channel);
        if (!fn) throw fail2("NotImplemented", channel, "not-implemented");
        return fn(event(), ...args);
      }
      function send(channel, args) {
        const row = rowFor(channel, channelMap.outbound);
        if (!row) {
          fail2("UnclassifiedChannel", channel, "unclassified");
          return;
        }
        if (row.class === "platform-only") {
          platformOnly(channel);
          return;
        }
        if (row.class === "absent") return;
        const fn = listeners.get(channel);
        if (!fn) {
          defect("NotImplemented", channel);
          return;
        }
        try {
          fn(event(), ...args);
        } catch (e) {
          defect("HandlerError", channel);
        }
      }
      function onInbound(channel, fn) {
        if (!rowFor(channel, channelMap.inbound)) {
          defect("UnclassifiedChannel", channel);
          return () => {
          };
        }
        if (!inbound.has(channel)) inbound.set(channel, /* @__PURE__ */ new Set());
        inbound.get(channel).add(fn);
        return () => offInbound(channel, fn);
      }
      function offInbound(channel, fn) {
        const set = inbound.get(channel);
        if (set) set.delete(fn);
      }
      function emit(channel, payload) {
        for (const fn of [...inbound.get(channel) || []]) {
          try {
            fn(event(), payload);
          } catch (e) {
            defect("ListenerError", channel);
          }
        }
      }
      var duplicates = [];
      function registerHandler(channel, fn) {
        if (handlers.has(channel)) duplicates.push(channel);
        handlers.set(channel, fn);
      }
      function registerListener(channel, fn) {
        if (listeners.has(channel)) duplicates.push(channel);
        listeners.set(channel, fn);
      }
      function removeHandler2(channel) {
        handlers.delete(channel);
      }
      var api = {
        handle: (channel, fn) => registerHandler(channel, (e, ...args) => fn(args, { event: e })),
        on: (channel, fn) => registerListener(channel, (e, ...args) => fn(args, { event: e })),
        emit,
        expose: (name2, value) => {
          if (name2 === "events") throw new Error("web.events is reserved");
          exposed[name2] = value;
        },
        engine: {
          // same-origin only (security review L4): a path that starts with one "/", never an absolute or protocol-relative URL
          fetch: (path, init) => {
            const origin = globalThis.location.origin;
            if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error('engine.fetch takes a same-origin path starting with "/"');
            const url = new URL(path, origin);
            if (url.origin !== origin) throw new Error("engine.fetch is same-origin only");
            return globalThis.fetch(url, { credentials: "same-origin", cache: "no-store", ...init || {} });
          }
        },
        platformOnly
      };
      function modulesForInit() {
        const base = new URL("./", globalThis.location ? globalThis.location.href : "http://localhost/");
        return (meta().modules || []).map((m) => ({ ...m, url: new URL(m.url, base).href, enabled: m.core ? true : m.defaultEnabled, settings: {} }));
      }
      function initPayload() {
        return {
          debug: { on: false, path: "" },
          startupLog: "",
          modules: modulesForInit(),
          userModulesDir: "",
          version: version(),
          wid: 1,
          platform: "linux",
          skippedLocalRecipes: [],
          sessions: [],
          accounts: false,
          firstRunHint: false
        };
      }
      function boot(register4) {
        for (const fn of register4) fn(api);
        globalThis.wb = globalThis.wb || {};
        globalThis.wb.web = exposed;
        globalThis.__wbWebChannels = () => ({ handlers: [...handlers.keys()].sort(), listeners: [...listeners.keys()].sort(), exposed: Object.keys(exposed).sort(), duplicates: [...duplicates] });
        const sendInit = () => {
          emit("init", initPayload());
          if (globalThis.document && document.documentElement) document.documentElement.setAttribute("data-wb-web", "ready");
          globalThis.__wbWeb = { ready: true, version: version() };
        };
        if (globalThis.document && document.readyState !== "complete") globalThis.addEventListener("load", () => setTimeout(sendInit, 0));
        else setTimeout(sendInit, 0);
      }
      module.exports = {
        invoke,
        send,
        onInbound,
        offInbound,
        emit,
        registerHandler,
        registerListener,
        removeHandler: removeHandler2,
        platformOnly,
        version,
        boot,
        api,
        _state: { handlers, listeners, defects, duplicates, exposed }
      };
    }
  });

  // web/shims/electron.js
  var require_electron = __commonJS({
    "web/shims/electron.js"(exports, module) {
      "use strict";
      init_globals();
      var rt3 = require_runtime();
      var ipcMain = {
        handle: (channel, fn) => rt3.registerHandler(channel, fn),
        on: (channel, fn) => rt3.registerListener(channel, fn),
        removeHandler: (channel) => rt3.removeHandler(channel)
      };
      var ipcRenderer = {
        invoke: (channel, ...args) => rt3.invoke(channel, args),
        send: (channel, ...args) => {
          rt3.send(channel, args);
        },
        on: (channel, fn) => rt3.onInbound(channel, fn),
        removeListener: (channel, fn) => rt3.offInbound(channel, fn)
      };
      var contextBridge = {
        // the browser has one world: the API is the page's own window.wb
        exposeInMainWorld: (name2, api) => {
          globalThis[name2] = api;
        }
      };
      var net = { isOnline: () => globalThis.navigator ? globalThis.navigator.onLine !== false : true };
      var safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "web-session-marker",
        setUsePlainTextEncryption() {
        },
        encryptString: (s) => require_buffer().Buffer.from(String(s)),
        decryptString: (b) => require_buffer().Buffer.from(b).toString("utf8")
      };
      var platformOnly = (what) => () => {
        throw rt3.platformOnly(what);
      };
      var dialog = { showOpenDialog: platformOnly("dialog.showOpenDialog"), showSaveDialog: platformOnly("dialog.showSaveDialog") };
      function BrowserWindow() {
        throw rt3.platformOnly("BrowserWindow");
      }
      var app = { getPath: () => "/", getVersion: () => rt3.version() };
      module.exports = { ipcMain, ipcRenderer, contextBridge, net, safeStorage, dialog, BrowserWindow, app };
    }
  });

  // src/preload.js
  var require_preload = __commonJS({
    "src/preload.js"() {
      "use strict";
      init_globals();
      var { contextBridge, ipcRenderer } = require_electron();
      var INBOUND = /* @__PURE__ */ new Set([
        "init",
        "recipes:changed",
        // step 3c: the recipes list after a change here, on another computer, or a pull
        "recipes:offline",
        "recipes:local-sync-status",
        // skipped local recipe names, never credentials
        "recipes:local-sync-error",
        // main-only local sync failures, no credentials
        "broker:groups",
        // step 3d: the rail's groups (the brokers' own lists) and the one-time kept-running line
        "sessions:offer",
        // step 4: the offer after an interruption and Recently closed
        "programs:changed",
        // 0.12.4: a program's detection changed (an Install pane ended, a check ran)
        "console:state",
        // 0.12.2: the Console tab's frame (ok, can't load) and its terminal link
        "console:terminal",
        "console:terminal-refused",
        "session:data",
        "session:exit",
        "session:adopt",
        "sessions:update",
        "win:max",
        "tab:activate",
        "snapshot:req",
        "debug",
        "drop:preview",
        "drop:clear",
        "concierge:taken",
        "concierge:reload",
        // D3: Reload when stuck's strips (typing, reloading, restarting, reloaded, failed, paused)
        "modules:changed",
        "modules:frame-revoke",
        // Tasks seam S4: main stopped a module frame's navigation; close its port
        "session:route",
        "session:gap",
        "session:typing-paused",
        "session:hide-req",
        "session:moved-away",
        "prefs:changed",
        "scratchpad:changed",
        "update:ready",
        "update:progress",
        "accounts:changed",
        "accounts:switched",
        "rooms:account",
        "room-templates:view",
        "accounts:signed-in",
        "accounts:servers",
        "accounts:access-news",
        "app:show-servers",
        "accounts:link",
        "rooms:status",
        // W1: the Workrooms tab's room-service client (src/rooms): the strip state, the cards, the line
        "rooms:rooms",
        "rooms:line",
        "rooms:read",
        "rooms:room",
        "rooms:seat",
        "rooms:scratchpad",
        // W2: notes and assets changed in a room
        "rooms:tasks",
        // Tasks seam S5: a room's tasks changed, ids only (src/rooms/task-events.js)
        "keys:state",
        // 5a: the station key's card, the ledger, the reminder
        "keys:progress",
        // 5a: a refresh's four steps
        "keys:resume"
        // 5a: a refresh finished at start (rule 8)
      ]);
      var selectionScope = { accountId: null, selectionVersion: -1 };
      function selectedScope() {
        return { ...selectionScope };
      }
      function acceptSelection(st) {
        if (!st || !Number.isSafeInteger(st.selectionVersion) || st.selectionVersion < 0) return;
        if (st.selectionVersion >= selectionScope.selectionVersion) {
          selectionScope = { accountId: st.activeAccount || null, selectionVersion: st.selectionVersion };
        }
      }
      ipcRenderer.on("accounts:changed", (_e, st) => acceptSelection(st));
      ipcRenderer.on("rooms:account", (_e, st) => acceptSelection({ activeAccount: st?.accountId, selectionVersion: st?.selectionVersion }));
      var selectedScopeReady = ipcRenderer.invoke("accounts:state").then(acceptSelection).catch(() => {
        if (selectionScope.selectionVersion < 0) selectionScope = { accountId: null, selectionVersion: 0 };
      });
      function sameScope(a, b) {
        return !!a && !!b && a.selectionVersion >= 0 && a.accountId === b.accountId && a.selectionVersion === b.selectionVersion;
      }
      async function conciergeCall(invoke) {
        let scope = selectedScope();
        await selectedScopeReady;
        if (scope.selectionVersion < 0) scope = selectedScope();
        if (!sameScope(scope, selectedScope())) return { error: "account-changed" };
        const result = await invoke(scope);
        return sameScope(scope, selectedScope()) ? result : { error: "account-changed" };
      }
      var scratchpadFolderGeneration = null;
      function acceptScratchpadGeneration(value) {
        if (Number.isSafeInteger(value) && value >= 0 && (scratchpadFolderGeneration === null || value >= scratchpadFolderGeneration)) scratchpadFolderGeneration = value;
      }
      ipcRenderer.on("scratchpad:changed", (_e, change) => acceptScratchpadGeneration(change?.folderGeneration));
      function scratchpadApi(bound) {
        const scope = () => bound ? bound.selection : selectedScope();
        const current = () => (!bound || bound.folderGeneration === null || bound.folderGeneration === scratchpadFolderGeneration) && sameScope(scope(), selectedScope());
        const invoke = async (verb, request) => {
          await selectedScopeReady;
          if (!current()) return { ok: false, reason: "scope-changed" };
          const selection = scope();
          const accountCurrent = () => sameScope(selection, selectedScope());
          if (verb === "location" || (bound ? bound.folderGeneration === null : scratchpadFolderGeneration === null)) {
            const location = await ipcRenderer.invoke("scratchpad:location", { scope: selection });
            if (!accountCurrent()) return { ok: false, reason: "scope-changed" };
            acceptScratchpadGeneration(location?.folderGeneration);
            if (bound && bound.folderGeneration === null && Number.isSafeInteger(location?.folderGeneration) && location.folderGeneration >= 0) bound.folderGeneration = location.folderGeneration;
            if (!current()) return { ok: false, reason: "scope-changed" };
            if (verb === "location") return location;
            if (!Number.isSafeInteger(bound ? bound.folderGeneration : scratchpadFolderGeneration)) return { ok: false, reason: "storage-unavailable" };
          }
          const generation = bound ? bound.folderGeneration : scratchpadFolderGeneration;
          const result = await ipcRenderer.invoke("scratchpad:" + verb, { scope: selection, folderGeneration: generation, request });
          if (!accountCurrent()) return { ok: false, reason: "scope-changed" };
          const changesFolder = verb === "chooseFolder" || verb === "useDefault" || verb === "useFoundFolder";
          if (changesFolder) acceptScratchpadGeneration(result?.folderGeneration);
          if (!changesFolder && (!current() || generation !== scratchpadFolderGeneration)) return { ok: false, reason: "scope-changed" };
          return result;
        };
        return {
          bind: () => scratchpadApi({ selection: scope(), folderGeneration: bound ? bound.folderGeneration : scratchpadFolderGeneration }),
          current,
          location: () => invoke("location"),
          chooseFolder: () => invoke("chooseFolder"),
          useDefault: () => invoke("useDefault"),
          useFoundFolder: (...args) => args.length ? Promise.resolve({ ok: false, reason: "invalid-request" }) : invoke("useFoundFolder"),
          list: () => invoke("list"),
          createNote: (text3) => invoke("createNote", { text: text3 }),
          saveNote: (id, text3, revision2) => invoke("saveNote", { id, text: text3, revision: revision2 }),
          closeNote: (id) => invoke("closeNote", { id }),
          importAssets: () => invoke("importAssets"),
          importAsset: (input) => {
            if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["name", "type", "bytes"].includes(key)) || typeof input.name !== "string" || input.name.length > 4096 || input.type !== void 0 && (typeof input.type !== "string" || input.type.length > 128) || !(input.bytes instanceof Uint8Array)) return Promise.resolve({ ok: false, reason: "invalid-request" });
            if (input.bytes.byteLength > 25 * 1024 * 1024) return Promise.resolve({ ok: false, reason: "too-large" });
            return invoke("importAsset", { name: input.name, type: input.type, bytes: new Uint8Array(input.bytes) });
          },
          removeMissingAsset: (id) => typeof id === "string" && id.length <= 80 ? invoke("removeMissingAsset", { id }) : Promise.resolve({ ok: false, reason: "invalid-id" }),
          openAsset: (id) => invoke("openAsset", { id }),
          showFolder: () => invoke("showFolder")
        };
      }
      function codexApi(bound) {
        const scope = () => bound === void 0 ? selectedScope() : bound;
        const invoke = async (verb, request) => {
          await selectedScopeReady;
          return ipcRenderer.invoke("codex:" + verb, { scope: scope(), request });
        };
        return {
          bind: () => codexApi(scope()),
          current: () => sameScope(scope(), selectedScope()),
          list: () => invoke("list"),
          open: (id, mode) => invoke("open", { id, ...mode ? { mode } : {} }),
          state: (id) => invoke("state", { id }),
          submit: (id, submissionId, text3) => invoke("submit", { id, submissionId, text: text3 }),
          pending: (id) => invoke("pending", { id }),
          check: (id, submissionId, recovered) => invoke("check", { id, [recovered === true ? "receiptId" : "submissionId"]: submissionId }),
          sendPending: (id, submissionId, recovered) => invoke("sendPending", { id, [recovered === true ? "receiptId" : "submissionId"]: submissionId }),
          respond: (id, requestId, decision) => invoke("respond", { id, requestId, decision }),
          close: (id) => invoke("close", { id })
        };
      }
      function roomApi(bound) {
        const getScope = () => bound === void 0 ? selectedScope() : bound;
        const invoke = (channel, ...args) => ipcRenderer.invoke(channel, { scope: getScope(), args });
        const send = (channel, ...args) => ipcRenderer.send(channel, { scope: getScope(), args });
        return {
          bind: () => roomApi(getScope()),
          scope: () => ({ ...getScope() }),
          current: () => sameScope(getScope(), selectedScope()),
          status: async () => {
            await selectedScopeReady;
            return invoke("rooms:status");
          },
          signIn: (username, password) => invoke("rooms:signin", { username, password }),
          signOut: () => invoke("rooms:signout"),
          list: (force) => invoke("rooms:list", { force: !!force }),
          room: (id) => invoke("rooms:room", { id }),
          connection: (id, connected) => invoke("rooms:connection", { id, connected }),
          line: (id, opts) => invoke("rooms:line", { id, ...opts || {} }),
          search: (id, q, limit) => invoke("rooms:search", { id, q, limit }),
          seen: (id, lastId) => invoke("rooms:seen", { id, lastId }),
          retry: () => invoke("rooms:retry"),
          visible: (tab, roomId) => send("rooms:visible", { tab: !!tab, roomId: roomId || null }),
          thumb: (roomId, name2, w) => invoke("rooms:thumb", { roomId, name: name2, w }),
          image: (roomId, name2) => invoke("rooms:image", { roomId, name: name2 }),
          download: (roomId, name2) => invoke("rooms:download", { roomId, name: name2 }),
          openWindow: (roomId, name2) => invoke("rooms:open-window", { roomId, name: name2 }),
          me: (patch) => invoke("rooms:me", patch || {}),
          picture: () => invoke("rooms:picture"),
          // W2: the write side
          post: (id, a) => invoke("rooms:post", { id, ...a || {} }),
          tasks: (a) => invoke("rooms:tasks", a),
          // Tasks seam S4 step 5: a module page's call, admitted in main
          tasksApprove: (a) => invoke("rooms:tasks-approve", a),
          draft: (id) => invoke("rooms:draft", { id }),
          setDraft: (id, text3, reply_to) => invoke("rooms:draft-set", reply_to === void 0 ? { id, text: text3 } : { id, text: text3, reply_to }),
          scratch: (id) => invoke("rooms:scratch", { id }),
          scratchUpload: (id, name2, type, bytes, key, pos) => invoke("rooms:scratch-upload", { id, name: name2, type, bytes, key, pos }),
          scratchRemove: (id, fileId) => invoke("rooms:scratch-remove", { id, fileId }),
          scratchOrder: (id, ids) => invoke("rooms:scratch-order", { id, ids }),
          assets: (id) => invoke("rooms:assets", { id }),
          notes: (id, q) => invoke("rooms:notes", { id, q }),
          note: (id, nid) => invoke("rooms:note", { id, nid }),
          noteCreate: (id, text3) => invoke("rooms:note-create", { id, text: text3 }),
          noteSet: (id, nid, text3) => invoke("rooms:note-set", { id, nid, text: text3 }),
          noteAttach: (id, nid) => invoke("rooms:note-attach", { id, nid }),
          noteClose: (id, nid) => invoke("rooms:note-close", { id, nid }),
          commands: () => invoke("rooms:commands"),
          pickFiles: () => invoke("rooms:pick-files"),
          // W3: people (rooms, workgroups, the room's lead, mode, brief and state, the seats)
          create: (a) => invoke("rooms:create", a || {}),
          patch: (id, a) => invoke("rooms:patch", { id, ...a || {} }),
          state: (id, verb) => invoke("rooms:state", { id, verb }),
          workgroup: (id, a) => invoke("rooms:workgroup", { id, ...a || {} }),
          familyCheck: (id, a) => invoke("rooms:family-check", { id, ...a || {} }),
          seatAdd: (id, a) => invoke("rooms:seat-add", { id, ...a || {} }),
          seatPatch: (id, sid, a) => invoke("rooms:seat-patch", { id, sid, ...a || {} }),
          seatRemove: (id, sid) => invoke("rooms:seat-remove", { id, sid }),
          seatHistory: (id, sid) => invoke("rooms:seat-history", { id, sid }),
          seatMove: (id, sid, to) => invoke("rooms:seat-move", { id, sid, to }),
          seatStart: (id, sid, a) => invoke("rooms:seat-start", { id, sid, ...a || {} }),
          wakeDeliver: (id, sid, lineId) => invoke("rooms:wake-deliver", { id, sid, lineId }),
          seatEnd: (id, sid, paneid) => invoke("rooms:seat-end", { id, sid, paneid }),
          seatDisconnect: (id, sid) => invoke("rooms:seat-disconnect", { id, sid }),
          seatProfile: (id, sid, p) => invoke("rooms:seat-profile", { id, sid, ...p && "model" in p ? { model: p.model } : {}, ...p && "effort" in p ? { effort: p.effort } : {} }),
          seatCloseWindow: (id, sid) => invoke("rooms:seat-close-window", { id, sid }),
          seatReloadPreview: (id, sid) => invoke("rooms:seat-reload-preview", { id, sid }),
          seatReload: (id, sid, a) => invoke("rooms:seat-reload", { id, sid, ...a || {} }),
          settings: (id, a) => invoke("rooms:settings", { id, ...a || {} }),
          presence: () => invoke("rooms:presence"),
          recipes: () => invoke("rooms:recipes"),
          deliverHeld: (id, paneid) => invoke("rooms:deliver-held", { id, paneid }),
          // History export: fixed scoped calls; the renderer never receives an engine address or token.
          historyGet: () => invoke("rooms:history-get"),
          historySet: (enabled) => invoke("rooms:history-set", { enabled }),
          historyExport: (roomId) => invoke("rooms:history-export", { roomId }),
          historyStart: () => invoke("rooms:history-start"),
          historyCancel: () => invoke("rooms:history-cancel")
        };
      }
      function roomTemplatesApi(bound) {
        if (!bound) {
          let cached = null;
          const listeners = /* @__PURE__ */ new Set();
          const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
          ipcRenderer.on("room-templates:view", (_event, message) => {
            if (!exact(message, ["scope", "ticket"]) || !exact(message.scope, ["accountId", "selectionVersion"]) || message.scope.accountId !== null || !sameScope(message.scope, selectedScope())) return;
            const t = message.ticket;
            if (t !== null && (!exact(t, ["viewId", "viewEpoch"]) || typeof t.viewId !== "string" || t.viewId.length > 160 || !Number.isSafeInteger(t.viewEpoch) || t.viewEpoch < 1)) return;
            cached = Object.freeze({ scope: Object.freeze({ ...message.scope }), ticket: t === null ? null : Object.freeze({ viewId: t.viewId, viewEpoch: t.viewEpoch }) });
            for (const fn of listeners) {
              try {
                fn(cached);
              } catch {
              }
            }
          });
          return Object.freeze({
            bind: (ticket) => roomTemplatesApi({ ticket: Object.freeze({ viewId: ticket?.viewId, viewEpoch: ticket?.viewEpoch }), scope: selectedScope() }),
            onView: (fn) => {
              if (typeof fn !== "function") return () => {
              };
              listeners.add(fn);
              if (cached && sameScope(cached.scope, selectedScope())) fn(cached);
              return () => listeners.delete(fn);
            }
          });
        }
        let closed = false;
        const call = async (verb, input = {}) => {
          if (closed) return { ok: false, code: "stale" };
          const closing = verb === "closeView";
          if (closing) closed = true;
          await selectedScopeReady;
          if (bound.scope.selectionVersion < 0) bound.scope = selectedScope();
          if (closed && !closing || !sameScope(bound.scope, selectedScope()) || bound.scope.accountId !== null) return { ok: false, code: "stale" };
          try {
            const result = await ipcRenderer.invoke(
              verb === "requestDiscard" ? "room-templates:discard-request" : "room-templates:call",
              verb === "requestDiscard" ? { scope: { ...bound.scope }, ticket: bound.ticket } : { scope: { ...bound.scope }, ticket: bound.ticket, verb, input }
            );
            if (closed && !closing || !sameScope(bound.scope, selectedScope())) return { ok: false, code: "stale" };
            return result;
          } catch {
            return { ok: false, code: "unavailable" };
          }
        };
        return Object.freeze({
          getState: () => call("getState"),
          getSaveView: (input) => call("getSaveView", input),
          create: (input) => call("create", input),
          save: (input) => call("save", input),
          rename: (input) => call("rename", input),
          remove: (input) => call("remove", input),
          folderForm: (input) => call("folderForm", input),
          pickFolder: (input) => call("pickFolder", input),
          applyFolder: (input) => call("applyFolder", input),
          closeView: () => call("closeView"),
          requestDiscard: () => call("requestDiscard")
        });
      }
      function agentSetupApi() {
        const call = async (verb, input) => {
          const result = await ipcRenderer.invoke("agent-setup:call", verb, input);
          if (!result?.ok) {
            if (["chooseCodeFolder", "saveCodeFolder"].includes(verb)) {
              const codes = ["code-folder-synced", "code-folder-system", "code-folder-network", "code-folder-root", "code-folder-absolute", "code-folder-protected", "code-folder-unwritable"];
              return { ok: false, code: codes.includes(result?.code) ? result.code : "agent-setup-unavailable" };
            }
            throw Error("Agent setup unavailable");
          }
          return result.value;
        };
        return {
          getState: () => call("state"),
          check: () => call("check"),
          cancel: () => call("cancel"),
          select: (value) => call("select", value),
          finish: () => call("finish"),
          chooseCodeFolder: () => call("chooseCodeFolder"),
          saveCodeFolder: (value) => call("saveCodeFolder", value),
          install: (id) => call("install", id),
          cancelInstall: () => call("cancelInstall"),
          terminalRead: (value) => call("terminalRead", value),
          terminalWrite: (value) => call("terminalWrite", value),
          terminalResize: (value) => call("terminalResize", value)
        };
      }
      function localSetupApi() {
        const call = async (method, value) => {
          const result = await ipcRenderer.invoke("local-setup:call", method, value);
          if (!result?.ok && method === "completeSetup" && ["scratchpad-choice-required", "setup-state-changed"].includes(result?.code)) {
            return { ok: false, code: result.code, refresh: true };
          }
          if (!result?.ok) throw Object.assign(Error(result?.message || "Local setup unavailable"), { code: result?.code });
          return result.value;
        };
        const api = { ownsLocalHistory: true };
        for (const method of [
          "getState",
          "chooseFolder",
          "checkFolder",
          "completeSetup",
          "cancelSetup",
          "setupProgress",
          "changeFiles",
          "openFolder",
          "setHistoryEnabled",
          "exportHistory",
          "startHistoryExport",
          "cancelExport",
          "restartLocalRooms",
          "selectRoomPlace",
          "restoreStarterFiles"
        ]) api[method] = (value) => call(method, value);
        api.subscribe = (fn) => {
          const listener = () => {
            void call("getState").then(fn).catch(() => {
            });
          };
          ipcRenderer.on("local-setup:changed", listener);
          return () => ipcRenderer.removeListener("local-setup:changed", listener);
        };
        api.registerNotesGuard = (check, lock) => {
          const held = /* @__PURE__ */ new Set();
          const listener = (_event, request) => {
            if (typeof request?.nonce !== "string") return;
            if (!request.lock) {
              held.delete(request.nonce);
              lock(held.size > 0);
              return;
            }
            let clean = false;
            try {
              clean = check() === true;
              if (clean) {
                held.add(request.nonce);
                lock(true);
              }
            } catch {
            }
            ipcRenderer.send("local-setup:notes-answer", { nonce: request.nonce, clean });
          };
          ipcRenderer.on("local-setup:notes-check", listener);
          return () => {
            ipcRenderer.removeListener("local-setup:notes-check", listener);
            held.clear();
            lock(false);
          };
        };
        return api;
      }
      function starterRoomsApi(bound) {
        let captured = bound;
        const scope = () => captured == null ? selectedScope() : captured;
        const call = async (verb, input) => {
          await selectedScopeReady;
          if (captured === null) captured = selectedScope();
          const wanted = scope();
          if (!sameScope(wanted, selectedScope()) || wanted.accountId !== null) throw Error("Starter rooms changed. Open the room again.");
          const result = await ipcRenderer.invoke("starter-rooms:call", { scope: wanted, verb, input });
          if (!sameScope(wanted, selectedScope())) throw Error("Starter rooms changed. Open the room again.");
          if (!result?.ok) throw Object.assign(Error(result?.error || "Starter rooms unavailable."), { code: result?.code, field: result?.field });
          return result.value;
        };
        return Object.freeze({
          bind: () => starterRoomsApi(selectedScope().selectionVersion < 0 ? null : scope()),
          open: (input) => call("open", input),
          openRoom: (input) => call("openRoom", input),
          status: (input) => call("status", input),
          startSeat: (input) => call("startSeat", input),
          startTeam: (input) => call("startTeam", input),
          preferences: () => call("preferences"),
          setAutoStart: (enabled) => call("setAutoStart", { enabled }),
          terminalIntent: (first, second) => ipcRenderer.invoke("starter:terminal-intent", { seatId: String(second === void 0 ? first : second) })
          /* (seatId), or the earlier (roomId, seatId): main derives the room either way */
        });
      }
      contextBridge.exposeInMainWorld("wb", {
        ...typeof import_process.default !== "undefined" && import_process.default.argv?.includes("--wb-room-templates") ? { roomTemplates: roomTemplatesApi() } : {},
        ...typeof import_process.default !== "undefined" && import_process.default.argv?.includes("--wb-starter-workrooms") ? { starterRooms: starterRoomsApi() } : {},
        ...typeof import_process.default !== "undefined" && import_process.default.argv?.includes("--wb-agent-setup") ? { agentSetup: agentSetupApi() } : {},
        ...typeof import_process.default !== "undefined" && import_process.default.argv?.includes("--wb-local-setup") ? { localSetup: localSetupApi() } : {},
        scratchpad: scratchpadApi(),
        codex: codexApi(),
        on: (channel, fn) => {
          if (!INBOUND.has(channel) || typeof fn !== "function") return () => {
          };
          let active = true;
          const listener = (_e, payload) => {
            if (active) fn(payload);
          };
          ipcRenderer.on(channel, listener);
          return () => {
            if (!active) return;
            active = false;
            ipcRenderer.removeListener(channel, listener);
          };
        },
        createSession: async (cols, rows, spec, launch) => {
          await selectedScopeReady;
          return ipcRenderer.invoke("session:create", { cols, rows, spec, ...launch || {}, scope: launch?.scope || selectedScope() });
        },
        permit: () => ipcRenderer.invoke("session:permit"),
        startupDone: () => ipcRenderer.send("startup:done"),
        seen: (sid, how) => ipcRenderer.send("session:seen", { sid, how }),
        paneActive: (sid) => ipcRenderer.send("pane:active", sid),
        retrySession: (sid, opts) => ipcRenderer.send("session:retry", { sid, ...opts || {}, scope: selectedScope() }),
        createConcierge: (cols, rows) => conciergeCall((scope) => ipcRenderer.invoke("concierge:create", { cols, rows, scope })),
        conciergeReload: (act) => ipcRenderer.send("concierge:reload-" + (act === "retry" || act === "dismiss" ? act : "cancel"), selectedScope()),
        // D3
        reportState: (st) => ipcRenderer.send("state:report", st),
        moduleSet: (p) => ipcRenderer.invoke("modules:set", p),
        modulesRescan: () => ipcRenderer.invoke("modules:rescan"),
        moduleStorage: (p) => ipcRenderer.invoke("modules:storage", p),
        moduleFrameExpect: (p) => ipcRenderer.invoke("modules:frame-expect", p),
        moduleWindowOpen: (p) => ipcRenderer.invoke("modules:window-open", p),
        // S3: the pop-out, checked again in main
        moduleTheme: (roles) => ipcRenderer.send("modules:theme", roles),
        // S3: the theme roles for module windows
        moduleCardAdmit: (p) => ipcRenderer.invoke("modules:card-admit", p),
        // revision 10: main admits each rail card
        moduleCardRelease: (p) => ipcRenderer.invoke("modules:card-release", p),
        input: (sid, data) => ipcRenderer.send("session:input", { sid, data, scope: selectedScope() }),
        resize: (sid, cols, rows) => ipcRenderer.send("session:resize", { sid, cols, rows, scope: selectedScope() }),
        closeSession: (sid) => ipcRenderer.send("session:close", sid, selectedScope()),
        setTitle: (sid, title) => ipcRenderer.send("session:title", { sid, title }),
        attached: (sid, cols, rows) => ipcRenderer.send("session:attached", { sid, cols, rows, scope: selectedScope() }),
        snapshotReply: (reqId, snapshot) => ipcRenderer.send("snapshot:reply", { reqId, snapshot }),
        dragStart: (sid, snapshot) => ipcRenderer.invoke("drag:start", { sid, snapshot }),
        dragMove: () => ipcRenderer.send("drag:move"),
        dragEnd: () => ipcRenderer.send("drag:end"),
        focusSession: (sid) => ipcRenderer.send("flyout:focus", sid),
        hideSession: (sid, snapshot) => ipcRenderer.send("session:hide", { sid, snapshot }),
        hideRemote: (sid) => ipcRenderer.send("session:hideRemote", sid),
        moveHere: (sid, x, y) => ipcRenderer.send("session:moveHere", { sid, x, y }),
        programsList: () => ipcRenderer.invoke("programs:list"),
        programsSet: (p) => ipcRenderer.invoke("programs:set", p),
        programsDetect: (id) => ipcRenderer.invoke("programs:detect", id),
        recipeImport: Object.freeze({
          open: () => ipcRenderer.invoke("recipes:import-open"),
          folder: (operationId) => ipcRenderer.invoke("recipes:import-folder", { operationId }),
          cancel: (operationId) => ipcRenderer.invoke("recipes:import-cancel", { operationId }),
          commit: (input) => ipcRenderer.invoke("recipes:import-commit", input)
        }),
        recipesList: () => ipcRenderer.invoke("recipes:list"),
        recipesSave: (p) => ipcRenderer.invoke("recipes:save", p),
        recipesDelete: (id) => ipcRenderer.invoke("recipes:delete", id),
        recipesDuplicate: (id) => ipcRenderer.invoke("recipes:duplicate", id),
        recipesFolderForm: (formId, context, recipeId) => ipcRenderer.invoke("recipes:folder-form", { formId: String(formId), context: String(context), recipeId: recipeId == null ? null : String(recipeId) }),
        recipesPickFolder: (mode, formId) => ipcRenderer.invoke("recipes:pick-folder", { mode: String(mode), formId: String(formId) }),
        recipesCheckFolder: (serverId, folder) => ipcRenderer.invoke("recipes:check-folder", { serverId, folder }),
        recipesSync: () => ipcRenderer.invoke("recipes:sync"),
        recipesSetup: (serverId, folder, programId) => ipcRenderer.invoke("recipes:setup", { serverId, folder, programId }),
        // step 3d: the brokers' lists now, and End on a CLI no pane here holds
        termControl: (sid, take) => ipcRenderer.invoke("session:term-control", { sid, take: !!take }),
        // W3b
        brokerGroups: () => ipcRenderer.invoke("broker:groups"),
        brokerModules: (request) => ipcRenderer.invoke("broker:modules", request),
        brokerEnd: (serverId, bsid) => ipcRenderer.invoke("broker:end", { serverId, bsid }),
        // 0.12.2: the Console tab (the realm's console in a view of its own, bounded to the renderer's slot)
        consoleOpen: (bounds, theme) => ipcRenderer.invoke("console:open", bounds, theme),
        // 0.12.5: theme rides on the address
        consoleBounds: (bounds) => ipcRenderer.send("console:bounds", bounds),
        consoleHide: () => ipcRenderer.send("console:hide"),
        consoleReload: (theme) => ipcRenderer.invoke("console:reload", theme),
        consoleHandoffAgain: () => ipcRenderer.invoke("console:handoff-again"),
        // 3d: "Open it again" on the hand-off strip
        consoleInfo: () => ipcRenderer.invoke("console:info"),
        consoleTestNavigate: (url) => ipcRenderer.invoke("console:test-navigate", url),
        consoleTestEval: (js) => ipcRenderer.invoke("console:test-eval", js),
        consoleTestWaitLoad: (ms) => ipcRenderer.invoke("console:test-wait-load", ms),
        consoleTestAuthenticator: () => ipcRenderer.invoke("console:test-authenticator"),
        consoleTestShot: (file) => ipcRenderer.invoke("console:test-shot", file),
        consoleTestCredentials: (id) => ipcRenderer.invoke("console:test-credentials", id),
        consoleTestFocus: () => ipcRenderer.invoke("console:test-focus"),
        // W1 (Workrooms read): the narrow door to the rooms client in main
        // 5a: the keys fallback (main's keyflow)
        keys: {
          state: () => ipcRenderer.invoke("keys:state"),
          connect: (id) => ipcRenderer.invoke("keys:connect", id),
          checkAdded: (id) => ipcRenderer.invoke("keys:check-added", id),
          refresh: (id) => ipcRenderer.invoke("keys:refresh", id),
          cancelRefresh: (id) => ipcRenderer.invoke("keys:refresh-cancel", id),
          retireAgain: (id, fp) => ipcRenderer.invoke("keys:retire-again", id, fp),
          removeEverywhere: () => ipcRenderer.invoke("keys:remove-everywhere"),
          older: (id) => ipcRenderer.invoke("keys:older", id),
          forget: (id, line) => ipcRenderer.invoke("keys:forget", id, line),
          make: () => ipcRenderer.invoke("keys:make"),
          remind: (days) => ipcRenderer.invoke("keys:remind", days),
          snooze: () => ipcRenderer.invoke("keys:snooze")
        },
        rooms: roomApi(),
        machineInfo: () => ipcRenderer.invoke("machine:info"),
        prefsGet: () => conciergeCall((scope) => ipcRenderer.invoke("prefs:get", scope)),
        prefsSet: (p) => conciergeCall((scope) => ipcRenderer.invoke("prefs:set", p, scope)),
        windowTheme: (theme) => ipcRenderer.invoke("window:theme", theme),
        updateState: () => ipcRenderer.invoke("update:state"),
        updateRestart: () => ipcRenderer.invoke("update:restart"),
        appRestart: () => ipcRenderer.invoke("app:restart"),
        // 0.12.4: Restart Workbench after an install
        openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
        copyText: (text3) => ipcRenderer.invoke("clipboard:write", text3),
        // step 4 (resume): the offer after an interruption, Recently closed, and a stopped row's restore spec
        sessions: {
          offer: () => ipcRenderer.invoke("sessions:offer"),
          dismiss: () => ipcRenderer.invoke("sessions:dismiss", selectedScope()),
          remove: (key) => ipcRenderer.invoke("sessions:remove", key, selectedScope()),
          restoreSpec: (key) => ipcRenderer.invoke("sessions:restore-spec", key, selectedScope())
        },
        updateCheck: () => ipcRenderer.invoke("update:check"),
        updateAuto: (on) => ipcRenderer.invoke("update:auto", on),
        openLicenses: () => ipcRenderer.invoke("about:licenses"),
        openSession: (sid) => ipcRenderer.send("session:open", sid),
        // Accounts (step 3a): these reject when the module is absent; the renderer then shows mode A only.
        // 3e: the Servers tab (the realm's per-server API, signed in main; passkey writes open the browser)
        servers: {
          list: () => ipcRenderer.invoke("servers:list", void 0, selectedScope()),
          get: (id) => ipcRenderer.invoke("servers:get", id, selectedScope()),
          policy: (id, policy2, allow) => ipcRenderer.invoke("servers:policy", { id, policy: policy2, allow }, selectedScope()),
          role: (id, person, role) => ipcRenderer.invoke("servers:role", { id, person, role }, selectedScope()),
          approve: (id, request) => ipcRenderer.invoke("servers:approve", { id, request }, selectedScope()),
          decline: (id, request, note) => ipcRenderer.invoke("servers:decline", { id, request, note }, selectedScope()),
          revoke: (id, grant, letRun) => ipcRenderer.invoke("servers:revoke", { id, grant, letRun }, selectedScope()),
          install: (id) => ipcRenderer.invoke("servers:install", id, selectedScope()),
          people: () => ipcRenderer.invoke("servers:people", void 0, selectedScope()),
          grant: (id, person, login) => ipcRenderer.invoke("servers:grant", { id, person, login }, selectedScope()),
          action: (id) => ipcRenderer.invoke("servers:action", id, selectedScope()),
          reopen: (id) => ipcRenderer.invoke("servers:reopen", id, selectedScope()),
          refreshMe: () => ipcRenderer.invoke("servers:refresh-me", void 0, selectedScope())
        },
        accounts: {
          state: () => ipcRenderer.invoke("accounts:state"),
          begin: (address) => ipcRenderer.invoke("accounts:begin", address),
          rescope: () => ipcRenderer.invoke("accounts:rescope"),
          reopen: () => ipcRenderer.invoke("accounts:reopen"),
          cancel: () => ipcRenderer.invoke("accounts:cancel"),
          name: (name2) => ipcRenderer.invoke("accounts:name", name2),
          select: (id) => ipcRenderer.invoke("accounts:select", id),
          signout: (id) => ipcRenderer.invoke("accounts:signout", id),
          manage: (id) => ipcRenderer.invoke("accounts:manage", id),
          // 3b: the granted servers as the rail shows them, and piece 2's Test for one of them
          servers: () => ipcRenderer.invoke("accounts:servers"),
          testServer: (id) => ipcRenderer.invoke("accounts:test-server", id),
          // F7: Request access
          requestable: () => ipcRenderer.invoke("accounts:requestable"),
          request: (serverId, loginIds, note) => ipcRenderer.invoke("accounts:request", { serverId, loginIds, note }),
          requestAct: (id, act) => ipcRenderer.invoke("accounts:request-act", { id, act })
        },
        // a server page's Details (3b)
        hostKey: (id) => ipcRenderer.invoke("server:host-key", id),
        forgetHostKey: (id) => ipcRenderer.invoke("server:forget-host-key", id),
        closeIfEmpty: () => ipcRenderer.send("win:closeEmpty"),
        reportMode: (mode) => ipcRenderer.send("win:mode", mode),
        arrangeTabs: () => ipcRenderer.send("arrange:tabs"),
        setMeta: (sid, name2, hue) => ipcRenderer.send("session:meta", { sid, name: name2, hue }),
        minimize: () => ipcRenderer.send("win:minimize"),
        maximize: () => ipcRenderer.send("win:maximize"),
        close: () => ipcRenderer.send("win:close"),
        dlog: (event, fields) => ipcRenderer.send("debug:log", { event, fields }),
        setDebug: (on) => ipcRenderer.send("debug:set", on)
      });
    }
  });

  // web/handlers/platform.js
  var require_platform = __commonJS({
    "web/handlers/platform.js"(exports, module) {
      "use strict";
      init_globals();
      var KNOWN = /* @__PURE__ */ new Set(["system", "light", "dark"]);
      function register4(api) {
        for (const channel of ["pane:active", "win:mode", "win:closeEmpty", "startup:done", "state:report", "debug:log", "debug:set", "modules:theme"]) {
          api.on(channel, () => {
          });
        }
        api.handle("window:theme", async ([theme]) => {
          if (!KNOWN.has(theme)) return false;
          const root = globalThis.document && globalThis.document.documentElement;
          if (root) root.style.colorScheme = theme === "system" ? "" : theme;
          return true;
        });
        api.handle("update:state", async () => ({ ready: null, available: null, auto: false, version: String((globalThis.__WB_WEB__ || {}).version || "") }));
        api.handle("machine:info", async () => ({
          name: String(globalThis.location && globalThis.location.hostname || ""),
          os: "",
          release: "",
          shell: ""
        }));
      }
      module.exports = { register: register4 };
    }
  });

  // web/shims/path.js
  var require_path = __commonJS({
    "web/shims/path.js"(exports, module) {
      "use strict";
      init_globals();
      function normalize(p) {
        const abs = p.startsWith("/");
        const out = [];
        for (const part of p.split("/")) {
          if (!part || part === ".") continue;
          if (part === "..") {
            out.pop();
            continue;
          }
          out.push(part);
        }
        return (abs ? "/" : "") + out.join("/");
      }
      var join = (...parts2) => normalize(parts2.filter(Boolean).join("/")) || ".";
      var basename = (p) => String(p).split("/").filter(Boolean).pop() || "";
      var dirname = (p) => {
        const i = String(p).replace(/\/+$/, "").lastIndexOf("/");
        return i <= 0 ? i === 0 ? "/" : "." : String(p).slice(0, i);
      };
      var resolve = (...parts2) => normalize(parts2.join("/"));
      module.exports = { join, basename, dirname, resolve, sep: "/" };
    }
  });

  // web/shims/empty.js
  var require_empty = __commonJS({
    "web/shims/empty.js"(exports, module) {
      "use strict";
      init_globals();
      var refuse = () => {
        throw new Error("node http is not available in the browser build");
      };
      module.exports = { request: refuse, get: refuse };
    }
  });

  // src/rooms/client.js
  var require_client = __commonJS({
    "src/rooms/client.js"(exports, module) {
      "use strict";
      init_globals();
      var http = require_empty();
      var https = require_empty();
      var NET_MS = 1e4;
      var COOKIE_NAMES = ["homelab_session", "homelab_device"];
      function parseSetCookies(headers) {
        const out = {};
        const raw = headers["set-cookie"];
        for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
          const m = /^\s*([^=;]+)=([^;]*)/.exec(String(line));
          if (m && COOKIE_NAMES.includes(m[1])) {
            out[m[1]] = m[2];
          }
        }
        return out;
      }
      function cookieHeader(cookies) {
        return COOKIE_NAMES.filter((n) => cookies && cookies[n]).map((n) => n + "=" + cookies[n]).join("; ");
      }
      function allowed(method, p, localMode = false) {
        let u;
        try {
          u = new URL(String(p), "http://x");
        } catch (e) {
          return false;
        }
        const path = u.pathname;
        const m = String(method || "GET").toUpperCase();
        if (path.includes("..") || u.host !== "x") {
          return false;
        }
        if ((path === "/login" || path === "/logout") && m === "POST") {
          return true;
        }
        if (path === "/auth/realm/exchange" && m === "POST") {
          return true;
        }
        if (path === "/api/rooms" || path.startsWith("/api/rooms/")) {
          return true;
        }
        if (localMode && m === "GET" && p === "/api/table") return true;
        if (path === "/api/presence/user" && m === "GET") {
          return true;
        }
        if (/^\/api\/panes\/[^/]+\/deliver-held$/.test(path) && m === "POST") {
          return true;
        }
        if (path === "/api/terminal-grants" && m === "POST") {
          return true;
        }
        if (!u.search && !u.hash && path === "/api/history-export") return m === "GET" || m === "PATCH";
        if (!u.search && !u.hash && ["/api/history-export/run", "/api/history-export/cancel"].includes(path)) return m === "POST";
        if (localMode && m === "POST" && path === "/api/local/seed" && !u.search && !u.hash) return true;
        if (localMode && m === "POST" && !u.search && !u.hash && /^\/api\/sessions\/[^/]+\/end$/.test(path)) return true;
        if (localMode && !u.search && !u.hash && (path === "/api/recipes" && m === "POST" || /^\/api\/recipes\/app-local-[A-Za-z0-9_-]+$/.test(path) && m === "DELETE")) return true;
        return path === "/api/recipes" && m === "GET";
      }
      var TERM_ORIGIN = "app://workbench";
      var EXCHANGE_PATH = "/auth/realm/exchange";
      function createClient(opts) {
        let base = null;
        let localSession = null, credentialEpoch = 0;
        const localMode = opts.localMode === true;
        function setBase(url) {
          if (localMode) {
            localSession = null;
            ++credentialEpoch;
          }
          base = null;
          try {
            const u = new URL(String(url || ""));
            if (u.protocol !== "https:" && u.protocol !== "http:") {
              return false;
            }
            if (localMode && (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash)) return false;
            base = u;
            return true;
          } catch (e) {
            return false;
          }
        }
        setBase(opts.base);
        function setLocalSession(value) {
          if (!localMode) throw Error("Local room session unavailable");
          localSession = null;
          ++credentialEpoch;
          base = null;
          if (value === null) return;
          if (!value || typeof value.cookie !== "string" || !/^wb_auth=[A-Za-z0-9_-]{16,4096}$/.test(value.cookie) || !setBase(value.url)) throw Error("Invalid local room session");
          localSession = { url: base.origin, cookie: value.cookie };
        }
        function currentCookie() {
          if (!localMode) return cookieHeader(opts.cookies ? opts.cookies() : null);
          if (!localSession || base?.origin !== localSession.url) throw { code: "signed-out", message: "Local rooms unavailable" };
          return localSession.cookie;
        }
        const stale = (epoch) => localMode && epoch !== credentialEpoch;
        const staleError = () => ({ code: "account-changed", message: "Local engine changed" });
        function extraHeaders(extra) {
          if (!localMode) return extra || {};
          return Object.fromEntries(Object.entries(extra || {}).filter(([key]) => !["authorization", "cookie", "origin", "host"].includes(key.toLowerCase())));
        }
        function request(method, p, { body, etag, headers: extra } = {}) {
          return new Promise((resolve, reject) => {
            const epoch = credentialEpoch;
            if (!allowed(method, p, localMode)) {
              reject({ code: "not-allowed", message: method + " " + String(p).split("?")[0] + " is not a room route" });
              return;
            }
            if (!base) {
              reject({ code: "bad-url", message: "no rooms server address" });
              return;
            }
            const url = new URL(p, base);
            const mod = url.protocol === "https:" ? https : http;
            const headers = { accept: "application/json", ...extraHeaders(extra) };
            const ck = url.pathname === EXCHANGE_PATH ? "" : currentCookie();
            if (ck) {
              headers.cookie = ck;
            }
            if (etag) {
              headers["if-none-match"] = etag;
            }
            let payload = null;
            if (body !== void 0) {
              payload = import_buffer.Buffer.from(JSON.stringify(body));
              headers["content-type"] = "application/json";
              headers["content-length"] = String(payload.length);
            }
            delete headers.authorization;
            delete headers.origin;
            if (url.pathname === "/api/terminal-grants" || url.pathname === EXCHANGE_PATH) {
              headers.origin = TERM_ORIGIN;
            }
            const req = mod.request(url, { method, headers, timeout: NET_MS }, (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                if (stale(epoch)) {
                  reject(staleError());
                  return;
                }
                const text3 = import_buffer.Buffer.concat(chunks).toString("utf8");
                let json2 = null;
                try {
                  json2 = text3 ? JSON.parse(text3) : null;
                } catch (e) {
                  json2 = null;
                }
                resolve({ status: res.statusCode, json: json2, text: text3, etag: res.headers.etag || null, headers: res.headers, cookies: parseSetCookies(res.headers) });
              });
            });
            req.on("timeout", () => {
              req.destroy(Object.assign(new Error("timeout"), { code: "timeout" }));
            });
            req.on("error", (e) => {
              if (stale(epoch)) {
                reject(staleError());
                return;
              }
              reject({ code: e && e.code === "timeout" ? "timeout" : "unreachable", message: e && e.message ? e.message : "unreachable" });
            });
            if (payload) {
              req.write(payload);
            }
            req.end();
          });
        }
        function requestBytes(p, { maxBytes = 12 * 1024 * 1024 } = {}) {
          return new Promise((resolve, reject) => {
            const epoch = credentialEpoch;
            if (!allowed("GET", p, localMode)) {
              reject({ code: "not-allowed", message: "GET " + String(p).split("?")[0] + " is not a room route" });
              return;
            }
            if (!base) {
              reject({ code: "bad-url", message: "no rooms server address" });
              return;
            }
            const url = new URL(p, base);
            const mod = url.protocol === "https:" ? https : http;
            const headers = { accept: "image/*,*/*" };
            const ck = currentCookie();
            if (ck) {
              headers.cookie = ck;
            }
            const req = mod.request(url, { method: "GET", headers, timeout: NET_MS * 3 }, (res) => {
              const declared = Number(res.headers["content-length"]);
              if (Number.isFinite(declared) && declared > maxBytes) {
                resolve({ status: 413, buffer: null, type: "" });
                req.destroy();
                return;
              }
              const chunks = [];
              let size = 0;
              res.on("data", (c) => {
                size += c.length;
                if (size > maxBytes) {
                  resolve({ status: 413, buffer: null, type: "" });
                  req.destroy();
                  return;
                }
                chunks.push(c);
              });
              res.on("end", () => stale(epoch) ? reject(staleError()) : resolve({ status: res.statusCode, buffer: import_buffer.Buffer.concat(chunks), type: String(res.headers["content-type"] || "") }));
            });
            req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
            req.on("error", (e) => reject({ code: e && e.code === "timeout" ? "timeout" : "unreachable", message: e && e.message ? e.message : "unreachable" }));
            req.end();
          });
        }
        function requestRaw(method, p, buffer, extra) {
          return new Promise((resolve, reject) => {
            const epoch = credentialEpoch;
            if (!allowed(method, p, localMode)) {
              reject({ code: "not-allowed", message: method + " " + String(p).split("?")[0] + " is not a room route" });
              return;
            }
            if (!base) {
              reject({ code: "bad-url", message: "no rooms server address" });
              return;
            }
            const url = new URL(p, base);
            const mod = url.protocol === "https:" ? https : http;
            const headers = { accept: "application/json", ...extraHeaders(extra), "content-length": String(buffer.length) };
            const ck = currentCookie();
            if (ck) {
              headers.cookie = ck;
            }
            delete headers.authorization;
            delete headers.origin;
            const req = mod.request(url, { method, headers, timeout: NET_MS * 6 }, (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                if (stale(epoch)) {
                  reject(staleError());
                  return;
                }
                const text3 = import_buffer.Buffer.concat(chunks).toString("utf8");
                let json2 = null;
                try {
                  json2 = text3 ? JSON.parse(text3) : null;
                } catch (e) {
                  json2 = null;
                }
                resolve({ status: res.statusCode, json: json2, text: text3, headers: res.headers });
              });
            });
            req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
            req.on("error", (e) => reject({ code: e && e.code === "timeout" ? "timeout" : "unreachable", message: e && e.message ? e.message : "unreachable" }));
            req.write(buffer);
            req.end();
          });
        }
        async function login(username, password) {
          const r = await request("POST", "/login", { body: { username: String(username || ""), password: String(password || ""), remember: true } });
          if (r.status === 200 && r.cookies.homelab_session) {
            return { ok: true, cookies: r.cookies, mustChangePassword: !!(r.json && r.json.mustChangePassword) };
          }
          return { ok: false, status: r.status, error: r.json && (r.json.error || r.json.message) || "" };
        }
        async function exchange(ticket) {
          const r = await request("POST", EXCHANGE_PATH, { body: { ticket: String(ticket || "") } });
          if (r.status === 200 && r.cookies.homelab_session) {
            const exp = r.json && Number(r.json.expiresAt);
            return { ok: true, cookies: r.cookies, expiresAt: Number.isFinite(exp) ? exp : null, mustChangePassword: !!(r.json && r.json.mustChangePassword) };
          }
          return { ok: false, status: r.status, field: r.json && typeof r.json.field === "string" && r.json.field || null };
        }
        async function logout() {
          try {
            await request("POST", "/logout", { body: {} });
          } catch (e) {
          }
        }
        return {
          request,
          requestBytes,
          requestRaw,
          login,
          exchange,
          logout,
          setBase,
          setLocalSession,
          currentCookie,
          base: () => base ? base.origin : null,
          wsUrl: () => base ? base.origin.replace(/^http/, "ws") + "/pty" : null
        };
      }
      module.exports = { createClient, parseSetCookies, cookieHeader, allowed, COOKIE_NAMES, TERM_ORIGIN };
    }
  });

  // web/client-web.js
  var require_client_web = __commonJS({
    "web/client-web.js"(exports, module) {
      "use strict";
      init_globals();
      var real = require_client();
      var { Buffer: Buffer3 } = require_buffer();
      var NET_MS = 1e4;
      var { SESSION_MARKER } = require_session_marker();
      function headersObject(h) {
        const out = {};
        h.forEach((value, key) => {
          out[key.toLowerCase()] = value;
        });
        return out;
      }
      function createClient(opts) {
        let base = null;
        const localMode = opts.localMode === true;
        function setBase(url) {
          base = null;
          try {
            const u = new URL(String(url || ""), globalThis.location ? globalThis.location.href : void 0);
            if (u.protocol !== "https:" && u.protocol !== "http:") return false;
            if (globalThis.location && u.origin !== globalThis.location.origin) return false;
            base = u;
            return true;
          } catch (e) {
            return false;
          }
        }
        setBase(opts.base || globalThis.location && globalThis.location.origin);
        function setLocalSession() {
          throw Error("Local room session unavailable in the browser");
        }
        const currentCookie = () => "";
        async function doFetch(method, p, { headers = {}, body, timeoutMs = NET_MS, redirect = "manual" } = {}) {
          if (!real.allowed(method, p, localMode)) throw { code: "not-allowed", message: method + " " + String(p).split("?")[0] + " is not a room route" };
          if (!base) throw { code: "bad-url", message: "no rooms server address" };
          const url = new URL(p, base);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await globalThis.fetch(url, { method, headers, body, credentials: "same-origin", cache: "no-store", redirect, signal: controller.signal });
            return res;
          } catch (e) {
            throw { code: e && e.name === "AbortError" ? "timeout" : "unreachable", message: e && e.message ? e.message : "unreachable" };
          } finally {
            clearTimeout(timer);
          }
        }
        const statusOf = (res) => res.type === "opaqueredirect" ? 302 : res.status;
        async function request(method, p, { body, etag, headers: extra } = {}) {
          const headers = { accept: "application/json", ...extra || {} };
          delete headers.authorization;
          delete headers.cookie;
          delete headers.origin;
          if (etag) headers["if-none-match"] = etag;
          let payload;
          if (body !== void 0) {
            payload = JSON.stringify(body);
            headers["content-type"] = "application/json";
          }
          const res = await doFetch(method, p, { headers, body: payload });
          const text3 = res.type === "opaqueredirect" ? "" : await res.text();
          let json2 = null;
          try {
            json2 = text3 ? JSON.parse(text3) : null;
          } catch (e) {
            json2 = null;
          }
          const status = statusOf(res);
          const isLogin = new URL(p, base).pathname === "/login";
          return {
            status,
            json: json2,
            text: text3,
            etag: res.headers.get("etag") || null,
            headers: headersObject(res.headers),
            cookies: isLogin && status === 200 ? { ...SESSION_MARKER } : {}
          };
        }
        async function requestBytes(p, { maxBytes = 12 * 1024 * 1024 } = {}) {
          const res = await doFetch("GET", p, { headers: { accept: "image/*,*/*" }, timeoutMs: NET_MS * 3 });
          const declared = Number(res.headers.get("content-length"));
          if (Number.isFinite(declared) && declared > maxBytes) return { status: 413, buffer: null, type: "" };
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length > maxBytes) return { status: 413, buffer: null, type: "" };
          return { status: statusOf(res), buffer: Buffer3.from(buf), type: res.headers.get("content-type") || "" };
        }
        async function requestRaw(method, p, buffer, extra) {
          const headers = { accept: "application/json", ...extra || {} };
          delete headers.authorization;
          delete headers.cookie;
          delete headers.origin;
          const res = await doFetch(method, p, { headers, body: buffer, timeoutMs: NET_MS * 6 });
          const text3 = await res.text();
          let json2 = null;
          try {
            json2 = text3 ? JSON.parse(text3) : null;
          } catch (e) {
            json2 = null;
          }
          return { status: statusOf(res), json: json2, text: text3, headers: headersObject(res.headers) };
        }
        async function login(username, password) {
          const r = await request("POST", "/login", { body: { username: String(username || ""), password: String(password || ""), remember: true } });
          if (r.status === 200) return { ok: true, cookies: r.cookies, mustChangePassword: !!(r.json && r.json.mustChangePassword) };
          return { ok: false, status: r.status, error: r.json && (r.json.error || r.json.message) || "" };
        }
        async function exchange() {
          return { ok: false, status: 0, field: null };
        }
        async function logout() {
          try {
            await request("POST", "/logout", { body: {} });
          } catch (e) {
          }
        }
        return {
          request,
          requestBytes,
          requestRaw,
          login,
          exchange,
          logout,
          setBase,
          setLocalSession,
          currentCookie,
          base: () => base ? base.origin : null,
          wsUrl: () => base ? base.origin.replace(/^http/, "ws") + "/pty" : null
        };
      }
      module.exports = {
        createClient,
        parseSetCookies: real.parseSetCookies,
        cookieHeader: real.cookieHeader,
        allowed: real.allowed,
        COOKIE_NAMES: real.COOKIE_NAMES,
        TERM_ORIGIN: real.TERM_ORIGIN,
        SESSION_MARKER
      };
    }
  });

  // web/shims/ws.js
  var require_ws = __commonJS({
    "web/shims/ws.js"(exports, module) {
      "use strict";
      init_globals();
      var WebSocket = class {
        constructor(url) {
          this._handlers = /* @__PURE__ */ new Map();
          this._ws = new globalThis.WebSocket(url);
          this._ws.addEventListener("open", () => this.emit("open"));
          this._ws.addEventListener("message", (ev) => this.emit("message", ev.data));
          this._ws.addEventListener("close", () => this.emit("close"));
          this._ws.addEventListener("error", () => this.emit("error", new Error("websocket error")));
        }
        get readyState() {
          return this._ws.readyState;
        }
        on(type, fn) {
          if (!this._handlers.has(type)) this._handlers.set(type, []);
          this._handlers.get(type).push(fn);
          return this;
        }
        emit(type, ...args) {
          for (const fn of this._handlers.get(type) || []) fn(...args);
          return true;
        }
        send(data) {
          this._ws.send(data);
        }
        close() {
          try {
            this._ws.close();
          } catch (e) {
          }
        }
        terminate() {
          this.close();
        }
      };
      WebSocket.CONNECTING = 0;
      WebSocket.OPEN = 1;
      WebSocket.CLOSING = 2;
      WebSocket.CLOSED = 3;
      module.exports = { WebSocket };
    }
  });

  // src/rooms/task-events.js
  var require_task_events = __commonJS({
    "src/rooms/task-events.js"(exports, module) {
      "use strict";
      init_globals();
      var MAX_STR = 128;
      var MAX_BYTES = 1024;
      var isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
      var idOk = (x) => typeof x === "string" && x.length > 0 && x.length <= MAX_STR;
      var onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
      function frameBytesOk(text3) {
        return typeof text3 === "string" && import_buffer.Buffer.byteLength(text3, "utf8") <= MAX_BYTES;
      }
      function checkTasksFrame(msg) {
        if (!isObj(msg) || msg.type !== "room.tasks" || !onlyKeys(msg, ["type", "roomId", "familyId"])) {
          return null;
        }
        if (!idOk(msg.roomId) || msg.familyId !== void 0 && msg.familyId !== null && !idOk(msg.familyId)) {
          return null;
        }
        return { roomId: msg.roomId, familyId: msg.familyId ?? null };
      }
      function checkShown(p) {
        if (p === null) {
          return null;
        }
        if (!isObj(p) || !onlyKeys(p, ["roomId", "familyId", "group"]) || !idOk(p.roomId) || !idOk(p.familyId)) {
          return void 0;
        }
        if (p.group !== null && !idOk(p.group)) {
          return void 0;
        }
        return { roomId: p.roomId, familyId: p.familyId, group: p.group };
      }
      function familyOf(roomId, cache) {
        for (const v of Array.isArray(cache) ? cache : []) {
          const r = v && v.room;
          if (!r) {
            continue;
          }
          if (r.id === roomId) {
            return r.parent_id ? r.parent_id : r.id;
          }
          if (!r.parent_id && (v.family && v.family.workgroups || []).some((g) => g && g.id === roomId)) {
            return r.id;
          }
        }
        return null;
      }
      function tasksBroadcast(msg, cache) {
        const p = checkTasksFrame(msg);
        if (!p) {
          return null;
        }
        const familyId = familyOf(p.roomId, cache);
        return familyId ? { roomId: p.roomId, familyId } : null;
      }
      module.exports = { checkTasksFrame, checkShown, frameBytesOk, familyOf, tasksBroadcast, MAX_STR, MAX_BYTES };
    }
  });

  // src/rooms/live.js
  var require_live = __commonJS({
    "src/rooms/live.js"(exports, module) {
      "use strict";
      init_globals();
      var { WebSocket } = require_ws();
      var { frameBytesOk, tasksBroadcast } = require_task_events();
      var SEND_ALLOWED = /* @__PURE__ */ new Set(["room.subscribe", "ping"]);
      var RECV_ALLOWED = /* @__PURE__ */ new Set(["room.subscribed", "room.line", "room.state", "room.read", "room.held", "room.waiting", "room.scratchpad", "room.tasks", "pong"]);
      var PING_MS = 1e4;
      var SILENCE_MS = 3e4;
      var SUBSCRIBE_WAIT_MS = 3e3;
      function createLive(deps) {
        let ws = null;
        let pingTimer = null;
        let silenceTimer = null;
        let subTimer = null;
        let lastRooms = [];
        let subscribed = false;
        const counts = { dropped: 0, received: 0, sent: 0 };
        function clearTimers() {
          clearInterval(pingTimer);
          clearTimeout(silenceTimer);
          clearTimeout(subTimer);
          pingTimer = null;
          silenceTimer = null;
          subTimer = null;
        }
        function armSilence() {
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            endSocket("silence");
          }, SILENCE_MS);
        }
        function endSocket(why) {
          const s = ws;
          ws = null;
          subscribed = false;
          clearTimers();
          if (s) {
            try {
              s.terminate();
            } catch (e) {
            }
            if (deps.onClose) {
              deps.onClose(why);
            }
          }
        }
        function send(msg) {
          const type = msg && typeof msg === "object" ? msg.type : null;
          if (!SEND_ALLOWED.has(type)) {
            throw new Error("rooms: a frame of type " + JSON.stringify(type) + " is not allowed out of the room client");
          }
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            return false;
          }
          ws.send(JSON.stringify(msg));
          counts.sent += 1;
          return true;
        }
        function subscribe(ids) {
          lastRooms = Array.isArray(ids) ? ids.map(String) : [];
          return send({ type: "room.subscribe", rooms: lastRooms });
        }
        function connect() {
          if (ws) {
            return;
          }
          const url = deps.url();
          if (!url) {
            return;
          }
          const headers = {};
          const ck = deps.cookie ? deps.cookie() : "";
          if (ck) {
            headers.cookie = ck;
          }
          let s;
          try {
            s = new WebSocket(url, { headers, handshakeTimeout: 1e4 });
          } catch (e) {
            if (deps.onClose) {
              deps.onClose("error");
            }
            return;
          }
          ws = s;
          s.on("open", () => {
            if (ws !== s) {
              return;
            }
            armSilence();
            pingTimer = setInterval(() => {
              try {
                send({ type: "ping" });
              } catch (e) {
              }
            }, PING_MS);
            subscribe(lastRooms);
            subTimer = setTimeout(() => {
              if (ws === s && !subscribed) {
                endSocket("no-subscribed");
              }
            }, SUBSCRIBE_WAIT_MS);
          });
          s.on("message", (data) => {
            if (ws !== s) {
              return;
            }
            armSilence();
            let type = null;
            let msg = null;
            try {
              const text3 = String(data);
              const m = /"type"\s*:\s*"([A-Za-z0-9_.-]{1,40})"/.exec(text3.slice(0, 200));
              type = m ? m[1] : null;
              if (!RECV_ALLOWED.has(type) || type === "room.tasks" && !frameBytesOk(text3)) {
                counts.dropped += 1;
                return;
              }
              msg = JSON.parse(text3);
            } catch (e) {
              counts.dropped += 1;
              return;
            }
            if (!msg || msg.type !== type) {
              counts.dropped += 1;
              return;
            }
            counts.received += 1;
            if (type === "room.subscribed") {
              subscribed = true;
              clearTimeout(subTimer);
              if (deps.onOpen) {
                deps.onOpen(Array.isArray(msg.rooms) ? msg.rooms : []);
              }
              return;
            }
            if (type === "pong") {
              return;
            }
            if (deps.onEvent) {
              deps.onEvent(msg);
            }
          });
          s.on("close", () => {
            if (ws === s) {
              endSocket("closed");
            }
          });
          s.on("error", () => {
            if (ws === s) {
              endSocket("error");
            }
          });
        }
        return {
          connect,
          close: () => endSocket("client"),
          subscribe,
          send,
          counts: () => ({ ...counts }),
          isOpen: () => !!ws && ws.readyState === WebSocket.OPEN && subscribed,
          // self-test only: a frame handed to the parser as if the engine sent it
          _inject: import_process.default.env.WB_SELFTEST ? (text3) => ws && ws.emit("message", text3) : void 0
        };
      }
      module.exports = { createLive, SEND_ALLOWED, RECV_ALLOWED, tasksBroadcast };
    }
  });

  // web/shims/crypto.js
  var require_crypto = __commonJS({
    "web/shims/crypto.js"(exports, module) {
      "use strict";
      init_globals();
      var K = new Uint32Array([
        1116352408,
        1899447441,
        3049323471,
        3921009573,
        961987163,
        1508970993,
        2453635748,
        2870763221,
        3624381080,
        310598401,
        607225278,
        1426881987,
        1925078388,
        2162078206,
        2614888103,
        3248222580,
        3835390401,
        4022224774,
        264347078,
        604807628,
        770255983,
        1249150122,
        1555081692,
        1996064986,
        2554220882,
        2821834349,
        2952996808,
        3210313671,
        3336571891,
        3584528711,
        113926993,
        338241895,
        666307205,
        773529912,
        1294757372,
        1396182291,
        1695183700,
        1986661051,
        2177026350,
        2456956037,
        2730485921,
        2820302411,
        3259730800,
        3345764771,
        3516065817,
        3600352804,
        4094571909,
        275423344,
        430227734,
        506948616,
        659060556,
        883997877,
        958139571,
        1322822218,
        1537002063,
        1747873779,
        1955562222,
        2024104815,
        2227730452,
        2361852424,
        2428436474,
        2756734187,
        3204031479,
        3329325298
      ]);
      var rotr = (x, n) => x >>> n | x << 32 - n;
      function sha256Hex(bytes) {
        const h = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
        const bitLen = bytes.length * 8;
        const padded = new Uint8Array(bytes.length + 9 + 63 >> 6 << 6);
        padded.set(bytes);
        padded[bytes.length] = 128;
        const view = new DataView(padded.buffer);
        view.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
        view.setUint32(padded.length - 4, bitLen >>> 0);
        const w = new Uint32Array(64);
        for (let off = 0; off < padded.length; off += 64) {
          for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
          for (let i = 16; i < 64; i += 1) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
            w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
          }
          let [a, b, c, d, e, f, g, hh] = h;
          for (let i = 0; i < 64; i += 1) {
            const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (e & f ^ ~e & g) + K[i] + w[i] >>> 0;
            const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = d + t1 >>> 0;
            d = c;
            c = b;
            b = a;
            a = t1 + t2 >>> 0;
          }
          h[0] += a;
          h[1] += b;
          h[2] += c;
          h[3] += d;
          h[4] += e;
          h[5] += f;
          h[6] += g;
          h[7] += hh;
        }
        return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
      }
      function createHash(algorithm) {
        if (algorithm !== "sha256") throw new Error("createHash: only sha256 is available in the browser");
        const parts2 = [];
        const api = {
          update(data) {
            parts2.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
            return api;
          },
          digest(encoding) {
            const total = parts2.reduce((n, p) => n + p.length, 0);
            const all = new Uint8Array(total);
            let at = 0;
            for (const p of parts2) {
              all.set(p, at);
              at += p.length;
            }
            if (encoding !== "hex") throw new Error("digest: only hex is available in the browser");
            return sha256Hex(all);
          }
        };
        return api;
      }
      module.exports = { createHash };
    }
  });

  // src/rooms/user-picture.js
  var require_user_picture = __commonJS({
    "src/rooms/user-picture.js"(exports, module) {
      init_globals();
      var { createHash } = require_crypto();
      function profilePicture(value) {
        if (typeof value !== "string" || value.length > 4 * Math.ceil(256 * 1024 / 3) + 32) return null;
        const match = /^data:image\/(?:png|jpeg|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(value);
        if (!match || !match[1]) return null;
        const bytes = match[1].length / 4 * 3 - (match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0);
        return bytes <= 256 * 1024 ? value : null;
      }
      var profilePictureKey = (value) => value ? createHash("sha256").update(value).digest("hex") : null;
      module.exports = { profilePicture, profilePictureKey };
    }
  });

  // src/rooms/seat-pane.js
  var require_seat_pane = __commonJS({
    "src/rooms/seat-pane.js"(exports, module) {
      "use strict";
      init_globals();
      function seatPaneOf(views, roomId, seatId) {
        if (!Array.isArray(views) || typeof roomId !== "string" || typeof seatId !== "string") return null;
        const view = views.find((v) => v && (v.room && v.room.id === roomId || v.id === roomId));
        const seat = view && Array.isArray(view.seats) ? view.seats.find((x) => x && x.id === seatId) : null;
        if (!seat || seat.left_at || !["live", "parked"].includes(seat.status)) return null;
        return seat.occupant && typeof seat.occupant.id === "string" && seat.occupant.id ? seat.occupant.id : null;
      }
      function locateSeat(views, seatId) {
        if (!Array.isArray(views) || typeof seatId !== "string") return null;
        const found = [];
        for (const v of views) {
          const roomId = v && (v.room && v.room.id || v.id);
          const paneId = typeof roomId === "string" ? seatPaneOf(views, roomId, seatId) : null;
          if (paneId && !found.some((f) => f.roomId === roomId)) found.push({ roomId, paneId });
        }
        return found.length === 1 ? found[0] : null;
      }
      module.exports = { seatPaneOf, locateSeat };
    }
  });

  // src/rooms/index.js
  var require_rooms = __commonJS({
    "src/rooms/index.js"(exports, module) {
      "use strict";
      init_globals();
      var { ipcMain, net, safeStorage, dialog, BrowserWindow, app } = require_electron();
      var fs = require_fs();
      var path = require_path();
      var { createClient, cookieHeader } = require_client_web();
      var { createLive, tasksBroadcast } = require_live();
      var { profilePicture, profilePictureKey } = require_user_picture();
      var POLL_ROOM_MS = 2500;
      var POLL_LIST_MS = 15e3;
      var POLL_LINE_MS = 5e3;
      var RETRY_MS = [1e4, 2e4, 4e4, 6e4];
      var OFFLINE_PROBE_MS = 5e3;
      var PAGE = 50;
      var VISIBLE_CACHE_ROWS = 300;
      var HIDDEN_CACHE_ROWS = 120;
      var UNREAD_KINDS = /* @__PURE__ */ new Set(["chat", "attachment", "voice"]);
      var MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", md: "text/markdown", json: "application/json", pdf: "application/pdf", zip: "application/zip", csv: "text/csv", html: "text/html", log: "text/plain" };
      var mimeOf = (name2) => MIME[String(name2).split(".").pop().toLowerCase()] || "application/octet-stream";
      function init(ctx) {
        const ipcMain2 = ctx.ipcMain || require_electron().ipcMain;
        const localMode = ctx.localMode === true;
        let authEpoch = 0;
        let suspended = false;
        const dir = ctx.dir;
        const cause = ctx.cause || (() => {
        });
        const broadcast = ctx.broadcast || (() => {
        });
        const secPath = path.join(dir, "rooms.secrets");
        let memSecrets = null;
        if (import_process.default.env.WB_SELFTEST && import_process.default.platform === "linux" && safeStorage.setUsePlainTextEncryption) {
          safeStorage.setUsePlainTextEncryption(true);
        }
        const keychain = () => {
          try {
            if (!safeStorage.isEncryptionAvailable()) {
              return false;
            }
            const backend = import_process.default.platform === "linux" && safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : "os";
            return backend !== "basic_text" || !!import_process.default.env.WB_SELFTEST;
          } catch (e) {
            return false;
          }
        };
        function readCookies() {
          if (localMode) return null;
          if (!keychain()) {
            return memSecrets;
          }
          try {
            const j = JSON.parse(safeStorage.decryptString(fs.readFileSync(secPath)));
            return j && j.cookies ? j.cookies : null;
          } catch (e) {
            return null;
          }
        }
        function writeCookies(cookies2) {
          if (localMode) return;
          if (!cookies2) {
            memSecrets = null;
            try {
              fs.rmSync(secPath, { force: true });
            } catch (e) {
            }
            return;
          }
          if (!keychain()) {
            memSecrets = cookies2;
            cause("rooms-keychain-missing", {});
            return;
          }
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(secPath, safeStorage.encryptString(JSON.stringify({ cookies: cookies2 })), { mode: 384 });
        }
        let cookies = readCookies();
        let realm = ctx.realm || null;
        const autoPath = path.join(dir, "rooms-auto.json");
        let auto = (() => {
          try {
            const j = JSON.parse(fs.readFileSync(autoPath, "utf8"));
            return j && typeof j === "object" ? j : {};
          } catch (e) {
            return {};
          }
        })();
        function writeAuto(patch) {
          auto = { ...auto, ...patch };
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(autoPath, JSON.stringify(auto), { mode: 384 });
          } catch (e) {
          }
        }
        let autoNote = null;
        let autoBusy = null;
        let lastExchange = 0;
        let renewTimer = null;
        const RENEW_EARLY_MS = 10 * 60 * 1e3;
        let exchangeGapMs = 60 * 1e3;
        const SESSION_MS = 8 * 60 * 60 * 1e3;
        let server = import_process.default.env.WB_ROOMS_URL || ctx.server || "";
        const client = createClient({ base: server, cookies: () => cookies, localMode });
        let conn = "signed-out";
        let retryN = 0;
        let retryTimer = null;
        let retryAt = 0;
        let pictureData = null;
        let me = null;
        const colorOrNull = (c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;
        let rooms = [];
        let listEtag = null;
        const lines = /* @__PURE__ */ new Map();
        let visible = { tab: false, roomId: null };
        let pollTimer = null;
        let lineTimer = null;
        let liveOpen = false;
        let listedOnce = false;
        let serverHost = "";
        try {
          serverHost = new URL(server).host;
        } catch (e) {
          serverHost = "";
        }
        const live = createLive({
          url: () => client.wsUrl(),
          cookie: () => localMode ? client.currentCookie() : cookieHeader(cookies),
          onOpen: async (kept) => {
            liveOpen = true;
            cause("rooms-live", { rooms: kept.length });
            setConn("live");
            stopLinePoll();
            for (const id of kept) {
              await backfill(id).catch(() => {
              });
            }
          },
          onClose: (why) => {
            const was = liveOpen;
            liveOpen = false;
            if (conn === "signed-out") {
              return;
            }
            cause("rooms-live-closed", { why, was });
            scheduleReconnect();
          },
          onEvent: (msg) => onLiveEvent(msg)
        });
        const connectionPath = path.join(dir, "rooms-connections.json");
        let connections = {};
        try {
          const saved = JSON.parse(fs.readFileSync(connectionPath, "utf8"));
          if (saved && typeof saved === "object" && !Array.isArray(saved)) connections = saved;
        } catch {
        }
        const connectionEpochs = /* @__PURE__ */ new Map();
        const disconnectedIds = () => Array.isArray(connections[client.base()]) ? connections[client.base()] : [];
        const disconnected = (id) => disconnectedIds().includes(String(id));
        function roomFence(id) {
          const base = client.base(), epoch = connectionEpochs.get(String(id));
          const check = () => {
            if (disconnected(id) || base !== client.base() || epoch !== connectionEpochs.get(String(id))) {
              throw Object.assign(new Error("Room disconnected. Reconnect from its \u22EF menu."), { code: "room-disconnected" });
            }
          };
          check();
          return check;
        }
        function requestFence(method, p) {
          const match = /^\/api\/rooms\/([^/?]+)(.*)$/.exec(p);
          return match && !(method === "PATCH" && !match[2]) ? roomFence(decodeURIComponent(match[1])) : () => {
          };
        }
        function connection(id, connected) {
          id = String(id);
          if (!rooms.some((v) => String(v.room?.id) === id)) throw new Error("Room is unavailable");
          if (typeof connected !== "boolean") throw new Error("Expected connected state");
          if (disconnected(id) === !connected) return status();
          const ids = new Set(disconnectedIds());
          connected ? ids.delete(id) : ids.add(id);
          const next = { ...connections, [client.base()]: [...ids] };
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(connectionPath, JSON.stringify(next), { mode: 384 });
          connections = next;
          connectionEpochs.set(id, (connectionEpochs.get(id) || 0) + 1);
          lines.delete(id);
          listEtag = null;
          subscribeAll();
          restartPoll();
          broadcast("rooms:status", status());
          if (connected) list({ force: true }).catch(() => {
          });
          return status();
        }
        function status() {
          return {
            present: true,
            localMode,
            server: localMode ? "" : serverHost,
            origin: (() => {
              if (localMode) return "";
              try {
                return new URL(client.base()).origin;
              } catch (e) {
                return "";
              }
            })(),
            serverName: localMode ? "This computer" : String(ctx.serverName || "") || serverHost,
            signedIn: !!cookies,
            // A1: why the quiet sign-in didn't happen (the design 's five lines), and the engine's account page
            note: autoNote,
            accountPage: (() => {
              if (localMode) return "";
              try {
                return new URL("/account.html", client.base()).href;
              } catch (e) {
                return "";
              }
            })(),
            conn,
            retryAt: conn === "down" ? retryAt : 0,
            me,
            dropped: live.counts().dropped,
            disconnectedRooms: [...disconnectedIds()]
          };
        }
        function setConn(next) {
          if (next === conn) {
            return;
          }
          conn = next;
          cause("rooms-conn", { conn });
          broadcast("rooms:status", status());
        }
        let testOffline = false;
        function online() {
          if (testOffline) {
            return false;
          }
          try {
            return net.isOnline();
          } catch (e) {
            return true;
          }
        }
        async function call(method, p, opts) {
          const checkRoom = requestFence(method, p);
          if (!cookies) {
            throw Object.assign(new Error("signed out"), { code: "signed-out" });
          }
          let r;
          try {
            r = await client.request(method, p, opts);
          } catch (e) {
            if (localMode && e.code === "account-changed") throw e;
            if (method === "GET") checkRoom();
            const off = !online();
            if (off) {
              setConn("offline");
              scheduleReconnect();
            } else {
              setConn("down");
              scheduleReconnect();
            }
            throw Object.assign(new Error(e.message || "unreachable"), { code: off ? "offline" : e.code || "unreachable" });
          }
          if (method === "GET") checkRoom();
          if (r.status === 401 || r.status === 302) {
            signedOut("auth");
            quietSignIn("expired").catch(() => {
            });
            throw Object.assign(new Error("signed out"), { code: "signed-out", status: r.status });
          }
          if (r.status === 403 && r.json && r.json.mustChangePassword) {
            signedOut("password");
            throw Object.assign(new Error("set a password first"), { code: "signed-out", status: 403 });
          }
          if (conn === "down" || conn === "offline") {
            setConn(liveOpen ? "live" : "polling");
          }
          return r;
        }
        function signedOut(why) {
          cause("rooms-signed-out", { why });
          cookies = null;
          if (localMode) client.setLocalSession(null);
          writeCookies(null);
          me = null;
          pictureData = null;
          rooms = [];
          listEtag = null;
          lines.clear();
          live.close();
          liveOpen = false;
          clearTimeout(retryTimer);
          retryTimer = null;
          stopLinePoll();
          setConn("signed-out");
          broadcast("rooms:rooms", { rooms: [] });
        }
        function scheduleReconnect() {
          if (suspended) return;
          if (retryTimer || !cookies) {
            return;
          }
          const wait = conn === "down" ? RETRY_MS[Math.min(retryN, RETRY_MS.length - 1)] : conn === "offline" ? OFFLINE_PROBE_MS : 1e3;
          retryAt = Date.now() + wait;
          if (conn === "down") {
            retryN += 1;
            broadcast("rooms:status", status());
          }
          retryTimer = setTimeout(() => {
            retryTimer = null;
            resume().catch(() => {
            });
          }, wait);
        }
        async function resume() {
          if (suspended) return;
          if (!cookies) {
            return;
          }
          try {
            await list({ force: true });
          } catch (e) {
            return;
          }
          if (suspended || !cookies) return;
          retryN = 0;
          if (!liveOpen) {
            setConn("polling");
            startLinePoll();
            subscribeAll();
            live.connect();
          }
        }
        let followed = "";
        function subscribeAll() {
          const ids = rooms.filter((v) => v.room && v.room.state !== "archived" && !disconnected(v.room.id)).map((v) => String(v.room.id)).sort();
          const key = ids.join("\n");
          if (key !== followed || !liveOpen) {
            followed = key;
            live.subscribe(ids);
          }
        }
        async function list({ force } = {}) {
          const r = await call("GET", "/api/rooms?art=ref", { etag: force ? null : listEtag });
          if (r.status === 304) {
            return rooms;
          }
          if (r.status !== 200 || !Array.isArray(r.json)) {
            throw Object.assign(new Error("rooms list " + r.status), { code: "bad-answer", status: r.status });
          }
          listEtag = r.etag;
          rooms = r.json.map((v) => disconnected(v.room?.id) ? rooms.find((old) => old.room?.id === v.room.id) || v : v);
          const accessible = new Set(rooms.filter((v) => v.room).map((v) => String(v.room.id)));
          for (const id of lines.keys()) {
            if (!accessible.has(String(id))) lines.delete(id);
          }
          listedOnce = true;
          subscribeAll();
          if (!me) {
            try {
              const current = roomCopyFence();
              const m = await call("GET", "/api/rooms/me");
              if (!current()) return rooms;
              pictureData = m.status === 200 ? profilePicture(m.json?.picture) : null;
              me = m.status === 200 && m.json ? { handle: m.json.handle || null, name: m.json.name || null, hiddenRooms: Array.isArray(m.json.hiddenRooms) ? m.json.hiddenRooms : [], color: colorOrNull(m.json.color), tones: m.json.tones || {}, enterSubmits: typeof m.json.enterSubmits === "boolean" ? m.json.enterSubmits : void 0, pictureKey: profilePictureKey(pictureData) } : null;
            } catch (e) {
              me = null;
            }
          }
          broadcast("rooms:rooms", { rooms });
          broadcast("rooms:status", status());
          return rooms;
        }
        async function room(id) {
          const r = await call("GET", "/api/rooms/" + encodeURIComponent(id) + "?art=ref");
          if (r.status === 404) {
            return null;
          }
          if (r.status !== 200 || !r.json) {
            throw Object.assign(new Error("room " + r.status), { code: "bad-answer", status: r.status });
          }
          const i = rooms.findIndex((v) => v.room && v.room.id === id);
          if (i >= 0) {
            rooms[i] = { ...rooms[i], ...r.json };
          }
          return r.json;
        }
        function cacheFor(id) {
          let c = lines.get(id);
          if (!c) {
            c = { byId: /* @__PURE__ */ new Map(), ids: [], hasOlder: true, newest: 0 };
            lines.set(id, c);
          }
          return c;
        }
        function trimCache(id, c) {
          const cap = visible.tab && visible.roomId === id ? VISIBLE_CACHE_ROWS : HIDDEN_CACHE_ROWS;
          if (c.ids.length <= cap) return;
          const drop = Math.min(c.ids.length, Math.ceil((c.ids.length - cap) / PAGE) * PAGE);
          for (const entryId of c.ids.splice(0, drop)) c.byId.delete(entryId);
        }
        function normalize(e) {
          const out = { ...e };
          if (typeof out.meta === "string") {
            try {
              out.meta = JSON.parse(out.meta);
            } catch (x) {
              out.meta = null;
            }
          }
          return out;
        }
        function merge(id, entries) {
          if (disconnected(id)) return [];
          const c = cacheFor(id);
          const changed2 = [];
          for (const raw of entries) {
            const e = normalize(raw);
            if (!Number.isFinite(e.id)) {
              continue;
            }
            c.newest = Math.max(c.newest, e.id);
            const had = c.byId.get(e.id);
            c.byId.set(e.id, had ? { ...had, ...e, reads: e.reads || had.reads } : e);
            if (!had) {
              c.ids.push(e.id);
            }
            changed2.push(c.byId.get(e.id));
          }
          if (changed2.length) {
            c.ids.sort((a, b) => a - b);
          }
          trimCache(id, c);
          return changed2;
        }
        function newestId(id) {
          const c = lines.get(id);
          return c ? c.newest : 0;
        }
        async function search(id, q, limit) {
          const text3 = String(q || "").trim().slice(0, 200);
          if (!text3) {
            return { q: "", results: [] };
          }
          const n = Math.max(1, Math.min(200, Number(limit) || 200));
          return answer2(await call("GET", roomPath(id, "search") + "?q=" + encodeURIComponent(text3) + "&limit=" + n), "search");
        }
        async function line(id, { before, since, limit } = {}) {
          const n = Math.max(1, Math.min(1e3, Number(limit) || PAGE));
          const q = ["limit=" + n];
          if (Number.isFinite(before)) {
            q.push("before=" + before);
          } else if (Number.isFinite(since)) {
            q.push("since=" + since);
          }
          const r = await call("GET", "/api/rooms/" + encodeURIComponent(id) + "/line?" + q.join("&"));
          if (r.status !== 200 || !r.json || !Array.isArray(r.json.entries)) {
            throw Object.assign(new Error("line " + r.status), { code: "bad-answer", status: r.status });
          }
          const got = r.json.entries;
          const entries = merge(id, got);
          const c = cacheFor(id);
          if (!Number.isFinite(since) && got.length < n) {
            c.hasOlder = false;
          }
          return { entries, hasOlder: c.hasOlder, newest: newestId(id) };
        }
        async function backfill(id) {
          if (disconnected(id)) return;
          const from = newestId(id);
          if (!from) {
            return;
          }
          let since = from;
          for (let i = 0; i < 50; i++) {
            const r = await line(id, { since, limit: 200 });
            if (r.entries.length) {
              broadcast("rooms:line", { roomId: id, entries: r.entries, why: "backfill" });
            }
            if (r.entries.length < 200) {
              break;
            }
            since = r.newest;
          }
        }
        async function seen(id, lastId) {
          const r = await call("PUT", "/api/rooms/" + encodeURIComponent(id) + "/seen", { body: { last_seen_line_id: Number(lastId) } });
          if (r.status === 200) {
            const v = rooms.find((x) => x.room && x.room.id === id);
            if (v) {
              v.unread = 0;
              broadcast("rooms:rooms", { rooms });
            }
          }
          return r.status === 200;
        }
        function onLiveEvent(msg) {
          const id = msg.roomId;
          if (id && disconnected(id)) return;
          if (msg.type === "room.line" && id && msg.entry) {
            const entries = merge(id, [msg.entry]);
            const e = entries[0];
            const v = rooms.find((x) => x.room && x.room.id === id);
            if (v && e && UNREAD_KINDS.has(e.kind) && e.author !== "user" && !(visible.tab && visible.roomId === id)) {
              v.unread = (Number(v.unread) || 0) + 1;
              broadcast("rooms:rooms", { rooms });
            }
            broadcast("rooms:line", { roomId: id, entries, why: "push" });
          } else if (msg.type === "room.state" && id && msg.room) {
            const i = rooms.findIndex((x) => x.room && x.room.id === id);
            const next = { room: msg.room, inherited: msg.inherited, seats: msg.seats, actions: msg.actions, panels: msg.panels, voice: msg.voice, voiceGlobal: msg.voiceGlobal, family: msg.family };
            if (i >= 0) {
              rooms[i] = { ...rooms[i], ...next };
            } else {
              rooms.push(next);
            }
            broadcast("rooms:rooms", { rooms });
          } else if (msg.type === "room.read" && id) {
            const c = lines.get(id);
            const e = c && c.byId.get(Number(msg.entryId));
            if (e) {
              e.reads = { ...e.reads || {}, [msg.handle]: msg.state };
            }
            broadcast("rooms:read", { roomId: id, entryId: msg.entryId, handle: msg.handle, state: msg.state });
          } else if ((msg.type === "room.held" || msg.type === "room.waiting") && id) {
            broadcast("rooms:seat", { roomId: id, seatId: msg.seatId, handle: msg.handle, held: msg.held, waiting: msg.waiting });
          } else if (msg.type === "room.tasks") {
            const p = tasksBroadcast(msg, rooms);
            if (p) broadcast("rooms:tasks", p);
          } else if (msg.type === "room.scratchpad" && id) {
            broadcast("rooms:scratchpad", { roomId: id, counts: msg.counts || null, changed: !!msg.changed });
          }
        }
        function restartPoll() {
          if (suspended) return;
          clearInterval(pollTimer);
          pollTimer = null;
          if (!visible.tab || !cookies || disconnected(visible.roomId)) {
            return;
          }
          pollTimer = setInterval(() => {
            if (visible.roomId) {
              room(visible.roomId).then((v) => {
                if (v) {
                  broadcast("rooms:room", { roomId: visible.roomId, view: v });
                }
              }).catch(() => {
              });
            } else {
              list().catch(() => {
              });
            }
          }, visible.roomId ? POLL_ROOM_MS : POLL_LIST_MS);
        }
        function startLinePoll() {
          if (suspended) return;
          if (lineTimer) {
            return;
          }
          lineTimer = setInterval(() => {
            if (liveOpen || !cookies) {
              return;
            }
            for (const id of lines.keys()) {
              backfill(id).catch(() => {
              });
            }
          }, POLL_LINE_MS);
        }
        function stopLinePoll() {
          clearInterval(lineTimer);
          lineTimer = null;
        }
        async function signIn(username, password) {
          if (localMode) return { ok: false, why: "local-session-managed" };
          const epoch = ++authEpoch;
          let r;
          try {
            r = await client.login(username, password);
          } catch (e) {
            cause("rooms-signin", { ok: false, why: e.code || "unreachable" });
            return { ok: false, why: online() ? "unreachable" : "offline" };
          }
          if (suspended || epoch !== authEpoch) return { ok: false, why: "account-changed" };
          if (!r.ok) {
            cause("rooms-signin", { ok: false, status: r.status });
            return { ok: false, why: r.status === 401 || r.status === 403 ? "wrong" : "failed", status: r.status };
          }
          cookies = r.cookies;
          writeCookies(cookies);
          writeAuto({ via: "password", endsAt: null });
          clearTimeout(renewTimer);
          autoNote = null;
          cause("rooms-signin", { ok: true, remember: !!cookies.homelab_device });
          if (r.mustChangePassword) {
            signedOut("password");
            return { ok: false, why: "password" };
          }
          conn = "polling";
          broadcast("rooms:status", status());
          await resume();
          return { ok: true };
        }
        async function signOut() {
          if (localMode) return { ok: false, why: "local-session-managed" };
          authEpoch++;
          const logout = cookies ? client.logout().catch(() => {
          }) : Promise.resolve();
          writeAuto({ offAt: realm && realm.signedInAt() ? realm.signedInAt() : null, via: null, endsAt: null });
          clearTimeout(renewTimer);
          autoNote = null;
          signedOut("user");
          await logout;
          return { ok: true };
        }
        function scheduleRenew() {
          if (localMode) return;
          if (suspended) return;
          clearTimeout(renewTimer);
          renewTimer = null;
          if (auto.via !== "realm" || !auto.endsAt) {
            return;
          }
          const wait = Math.min(Math.max(5e3, auto.endsAt - RENEW_EARLY_MS - Date.now()), 2 ** 31 - 1);
          renewTimer = setTimeout(() => {
            renewTimer = null;
            quietSignIn("renew").catch(() => {
            });
          }, wait);
          if (renewTimer.unref) {
            renewTimer.unref();
          }
        }
        function quietSignIn(trigger) {
          if (localMode) return Promise.resolve({ ok: false, why: "local-session-managed" });
          if (!autoBusy) {
            const pending = exchangeOnce(trigger).finally(() => {
              if (autoBusy === pending) autoBusy = null;
            });
            autoBusy = pending;
          }
          return autoBusy;
        }
        async function exchangeOnce(trigger) {
          const epoch = authEpoch;
          const stale = () => suspended || epoch !== authEpoch;
          if (stale()) return { ok: false, why: "account-changed" };
          const refuse = (why, shown) => {
            cause("rooms-auto", { trigger, ok: false, why });
            if (shown && autoNote !== why) {
              autoNote = why;
              broadcast("rooms:status", status());
            }
            return { ok: false, why };
          };
          if (!realm || realm.present && !realm.present()) {
            return refuse("absent", false);
          }
          const at = realm.signedInAt();
          if (!at) {
            return refuse("no-account", true);
          }
          if (auto.offAt && auto.offAt === at) {
            return refuse("signed-out-by-you", false);
          }
          if (trigger === "expired" && Date.now() - lastExchange < exchangeGapMs) {
            return refuse("too-soon", false);
          }
          let t;
          try {
            t = await realm.ticket();
          } catch (e) {
            t = { status: 0, why: "unreachable" };
          }
          if (stale()) return { ok: false, why: "account-changed" };
          if (!t || t.status !== 200 || !t.json || typeof t.json.ticket !== "string" || !t.json.ticket) {
            const st = t ? t.status : 0;
            const why = st === 0 && t && ["no-account", "no-device", "no-token", "signed-out"].includes(t.why) ? "no-account" : st === 404 ? "off" : st === 403 && t.json && t.json.error === "not-allowed" ? "not-allowed" : "unreachable";
            return refuse(why, true);
          }
          let r;
          try {
            r = await client.exchange(t.json.ticket);
          } catch (e) {
            return refuse("engine-unreachable", false);
          }
          if (stale()) return { ok: false, why: "account-changed" };
          if (!r.ok) {
            const why = r.status === 403 && r.field === "link" ? "not-linked" : r.status === 404 || r.status === 403 && r.field === "origin" ? "off" : r.status === 403 && r.field === "account" ? "not-allowed" : "unreachable";
            return refuse(why, true);
          }
          lastExchange = Date.now();
          cookies = r.cookies;
          writeCookies(cookies);
          writeAuto({ via: "realm", endsAt: r.expiresAt || Date.now() + SESSION_MS, offAt: null });
          autoNote = null;
          cause("rooms-auto", { trigger, ok: true });
          if (r.mustChangePassword) {
            signedOut("password");
            return { ok: false, why: "password" };
          }
          scheduleRenew();
          if (conn === "signed-out") {
            conn = "polling";
          }
          broadcast("rooms:status", status());
          await resume();
          return { ok: true };
        }
        function accountChanged() {
          autoNote = null;
          if (!cookies) {
            quietSignIn("account").catch(() => {
            });
          } else {
            broadcast("rooms:status", status());
          }
        }
        function setVisible(v) {
          visible = { tab: !!(v && v.tab), roomId: v && v.roomId ? String(v.roomId) : null };
          for (const [id, c] of lines) trimCache(id, c);
          restartPoll();
        }
        function setBaseOnly(url) {
          if (!client.setBase(url)) {
            return false;
          }
          server = url;
          try {
            serverHost = new URL(url).host;
          } catch (e) {
            serverHost = "";
          }
          return true;
        }
        function setServer(url, opts) {
          if (localMode) return false;
          if (!(opts && opts.switch)) {
            return setBaseOnly(url);
          }
          if (client.base() === url) {
            return true;
          }
          const was = client.base();
          if (!client.setBase(url)) {
            client.setBase(was);
            return false;
          }
          server = url;
          try {
            serverHost = new URL(url).host;
          } catch (e) {
            serverHost = "";
          }
          cause("rooms-server", { host: serverHost });
          if (cookies || conn !== "signed-out") {
            signedOut("server");
          }
          autoNote = null;
          lastExchange = 0;
          writeAuto({ via: null, endsAt: null });
          broadcast("rooms:status", status());
          quietSignIn("server").catch(() => {
          });
          return true;
        }
        function setLocalSession(value) {
          if (!localMode) throw Error("Local room session unavailable");
          ++authEpoch;
          signedOut("local-engine-changed");
          if (value === null) return;
          client.setLocalSession(value);
          cookies = { local: true };
          conn = "polling";
          autoNote = null;
          broadcast("rooms:status", status());
          void resume().catch(() => {
          });
        }
        const wrap = (fn) => async (e, ...a) => {
          try {
            return { ok: true, value: await fn(...a) };
          } catch (err) {
            return { ok: false, code: err && err.code ? err.code : "error", message: err && err.message ? err.message : String(err), ...err && Number.isInteger(err.status) ? { status: err.status } : {} };
          }
        };
        const tasksRefused = (status2, error2, field) => ({ ok: false, kind: "refused", status: status2, error: error2, field: field || null });
        const tasksTransport = () => ({ ok: false, kind: "transport" });
        const tasksRoomKnown = (id) => rooms.some((v) => v && v.room && v.room.id === id);
        const tasksScope = (e, a, b) => ({
          window: e.sender.id,
          module: String(a.moduleId),
          gen: a.gen,
          accountId: typeof ctx.accountId === "string" ? ctx.accountId : null,
          // this client's own account (scoped.js)
          selectionVersion: 0,
          engineEpoch: authEpoch,
          room: a.roomId,
          verb: "purge",
          taskId: b.taskId
        });
        function roomTasksPanel(roomId) {
          const v = rooms.find((x) => x && x.room && x.room.id === roomId);
          const own = "http://127.0.0.1:";
          const tail = "/rooms/" + roomId + "/view";
          const ids = (v && Array.isArray(v.panels) ? v.panels : []).filter((p) => p && p.icon === "tasks" && typeof p.id === "string" && typeof p.url === "string" && p.url.startsWith(own) && p.url.endsWith(tail) && /^\d+$/.test(p.url.slice(own.length, -tail.length))).map((p) => p.id).sort();
          return ids[0] || null;
        }
        function withServerName(b, r) {
          if (!b.panel || !r || r.ok !== true || !r.body || typeof r.body !== "object" || Array.isArray(r.body)) return r;
          let name2 = "";
          try {
            name2 = String(status().serverName || "").slice(0, 60);
          } catch (e) {
            name2 = "";
          }
          return { ...r, body: { ...r.body, serverName: name2 } };
        }
        function tasksPanel(b, roomId) {
          if (!b.panel) return null;
          const pid = b.panel === "room-tasks" ? roomTasksPanel(roomId) : null;
          if (!pid) return tasksRefused(404, "No Room Tasks panel in this room.", "room");
          b.path = b.path.replace("{panel}", encodeURIComponent(pid));
          return null;
        }
        function tasksAdmit(e, a) {
          const t = ctx.tasks;
          if (!t || !e || !e.sender || !t.fromAppPage(e)) return { reply: tasksTransport() };
          if (!a || typeof a !== "object" || typeof a.moduleId !== "string" || !Number.isSafeInteger(a.gen)) return { reply: tasksRefused(400, "Not a Tasks call.", "input") };
          const b = t.verbs.build(a.verb, a.roomId, a.input);
          if (!b.ok) return { reply: tasksRefused(400, b.error, b.field) };
          if (!t.admit(a.moduleId, b.grant)) return { reply: tasksRefused(403, "That tool isn't allowed to do this.", "verb") };
          if (!cookies || !tasksRoomKnown(a.roomId)) return { reply: tasksRefused(404, "No such room here.", "room") };
          const noPanel = tasksPanel(b, a.roomId);
          if (noPanel) return { reply: noPanel };
          return { b };
        }
        async function tasksCall(e, a) {
          const { reply, b } = tasksAdmit(e, a);
          if (reply) return reply;
          if (b.needsApproval && !ctx.tasks.approvals.take(a.approval, tasksScope(e, a, b))) return tasksRefused(403, "That confirmation has expired. Try again.", "approval");
          return withServerName(b, await tasksRun(b, a.moduleId, e.sender.id + ":" + String(a.owner || ""), a.input));
        }
        async function tasksRun(b, moduleId, frame, input) {
          const ticket = ctx.tasks.budget.take({ module: moduleId, frame, bytes: import_buffer.Buffer.byteLength(JSON.stringify(input || {}), "utf8") });
          if (!ticket.ok) return { ok: false, kind: "slow" };
          try {
            const r = await call(b.method, b.path, b.body ? { body: b.body } : void 0);
            if (r.status >= 200 && r.status < 300) {
              const size = r.text != null ? import_buffer.Buffer.byteLength(String(r.text), "utf8") : import_buffer.Buffer.byteLength(JSON.stringify(r.json === void 0 ? null : r.json), "utf8");
              return ctx.tasks.budget.replyOk(size) ? { ok: true, status: r.status, body: r.json === void 0 ? null : r.json } : tasksTransport();
            }
            if (r.status >= 400 && r.status < 500) {
              const j = r.json && typeof r.json === "object" ? r.json : {};
              const words2 = typeof j.error === "string" && j.error.length > 2 && !/^[a-z_]+$/.test(j.error) ? j.error : typeof j.message === "string" ? j.message : "The room refused that.";
              return tasksRefused(r.status, String(words2).slice(0, 300), typeof j.field === "string" ? j.field.slice(0, 40) : null);
            }
            return tasksTransport();
          } catch (err) {
            return tasksTransport();
          } finally {
            ticket.done();
          }
        }
        async function tasksBound(s, verb, input) {
          const t = ctx.tasks;
          if (!t) return tasksTransport();
          if (!s || typeof s !== "object" || typeof s.moduleId !== "string" || typeof s.frame !== "string" || typeof s.roomId !== "string") return tasksRefused(400, "Not a Tasks call.", "input");
          const mine = typeof ctx.accountId === "string" ? ctx.accountId : null;
          if (suspended || s.accountId !== mine || s.engineEpoch !== authEpoch) return { ok: false, code: "account-changed" };
          const b = t.verbs.build(verb, s.roomId, input);
          if (!b.ok) return tasksRefused(400, b.error, b.field);
          if (b.needsApproval || b.grant === "rooms.tasks.delete") return tasksRefused(403, "Delete from the room's side preview.", "verb");
          if (!t.admit(s.moduleId, b.grant)) return tasksRefused(403, "That tool isn't allowed to do this.", "verb");
          if (!cookies || !tasksRoomKnown(s.roomId)) return tasksRefused(404, "No such room here.", "room");
          const noPanel = tasksPanel(b, s.roomId);
          if (noPanel) return noPanel;
          try {
            return withServerName(b, await tasksRun(b, s.moduleId, s.frame, input));
          } catch (err) {
            return tasksTransport();
          }
        }
        function tasksRoom(roomId) {
          if (typeof roomId !== "string" || !roomId || roomId.length > 128) return null;
          for (const v of rooms) {
            const r = v && v.room;
            if (!r) continue;
            const wgs = v.family && Array.isArray(v.family.workgroups) ? v.family.workgroups : [];
            const g = !r.parent_id ? wgs.find((x) => x && x.id === roomId) : null;
            if (r.id !== roomId && !g) continue;
            const famId = r.id === roomId && r.parent_id ? r.parent_id : r.id;
            const fam = famId === r.id ? v : rooms.find((x) => x && x.room && x.room.id === famId);
            const groups = (fam && fam.family && fam.family.workgroups || []).filter((x) => x && x.state !== "archived" && typeof x.alias === "string" && x.alias).map((x) => x.alias);
            return { familyId: famId, title: String((g ? g.name : r.name) || ""), groups };
          }
          return null;
        }
        ipcMain2.handle("rooms:tasks", async (e, a) => {
          try {
            return await tasksCall(e, a);
          } catch (err) {
            return tasksTransport();
          }
        });
        ipcMain2.handle("rooms:tasks-approve", async (e, a) => {
          try {
            const { reply, b } = tasksAdmit(e, a);
            if (reply) return { ok: false, kind: reply.kind, status: reply.status };
            if (!b.needsApproval) return { ok: false, kind: "refused", status: 400 };
            const token = ctx.tasks.approvals.mint(tasksScope(e, a, b));
            return token ? { ok: true, approval: token } : { ok: false, kind: "refused", status: 400 };
          } catch (err) {
            return { ok: false, kind: "transport" };
          }
        });
        ipcMain2.handle("rooms:status", () => status());
        ipcMain2.handle("rooms:picture", wrap(async () => ({ key: me?.pictureKey || null, picture: cookies ? pictureData : null })));
        ipcMain2.handle("rooms:signin", (e, a) => signIn(a && a.username, a && a.password));
        ipcMain2.handle("rooms:signout", () => signOut());
        ipcMain2.handle("rooms:list", wrap(async (a) => listedOnce && !(a && a.force) ? rooms : list({ force: true })));
        ipcMain2.handle("rooms:connection", wrap((a) => connection(a && a.id, a && a.connected)));
        ipcMain2.handle("rooms:room", wrap((a) => room(String(a && a.id))));
        ipcMain2.handle("rooms:line", wrap(async (a) => {
          const room2 = String(a && a.id || "").slice(0, 8);
          try {
            const r = await line(String(a && a.id), a || {});
            cause("rooms-line", { room: room2, ok: true, count: r.entries.length, older: !!r.hasOlder, conn });
            return r;
          } catch (err) {
            cause("rooms-line", { room: room2, ok: false, code: err && err.code ? err.code : "error", conn });
            throw err;
          }
        }));
        ipcMain2.handle("rooms:search", wrap((a) => search(String(a && a.id), a && a.q, a && a.limit)));
        ipcMain2.handle("rooms:seen", wrap((a) => seen(String(a && a.id), a && a.lastId)));
        ipcMain2.handle("rooms:retry", wrap(async () => {
          clearTimeout(retryTimer);
          retryTimer = null;
          retryN = 0;
          await resume();
          return status();
        }));
        ipcMain2.on("rooms:visible", (e, v) => setVisible(v));
        let noThumbEngine = null, noThumbUntil = 0, last415File = null;
        const assetPath = (roomId, name2, thumb, w) => "/api/rooms/" + encodeURIComponent(String(roomId)) + "/assets/" + (thumb ? "thumb/" : "raw/") + encodeURIComponent(String(name2)) + (thumb ? "?w=" + (Number(w) || 256) : "");
        function roomCopyFence() {
          const epoch = authEpoch, credentials = cookies;
          return () => !suspended && epoch === authEpoch && !!credentials && cookies === credentials;
        }
        async function bytes(roomId, name2, thumb, w) {
          if (!cookies) {
            return null;
          }
          const checkRoom = roomFence(roomId);
          const authCurrent = roomCopyFence();
          const current = () => {
            try {
              checkRoom();
              return authCurrent();
            } catch {
              return false;
            }
          };
          const engine = authEpoch + "@" + client.base();
          if (noThumbEngine !== engine) {
            noThumbEngine = engine;
            noThumbUntil = 0;
            last415File = null;
          }
          const skipThumb = thumb && noThumbEngine === engine && Date.now() < noThumbUntil;
          let r = skipThumb ? { status: 415 } : await client.requestBytes(assetPath(roomId, name2, thumb, w));
          checkRoom();
          if (!current()) return null;
          if (thumb && !skipThumb && r.status !== 415) last415File = null;
          if (thumb && (r.status === 415 || r.status === 501)) {
            if (!skipThumb) {
              const file = JSON.stringify([String(roomId), String(name2)]);
              if (r.status === 501 || last415File !== null && last415File !== file) {
                noThumbUntil = Date.now() + 5 * 60 * 1e3;
                last415File = null;
              } else last415File = file;
            }
            const info = await client.request("HEAD", assetPath(roomId, name2, false));
            checkRoom();
            if (!current()) return null;
            const length = info.status === 200 && info.headers?.["content-length"];
            const size = length ? Number(length) : NaN, maxBytes = 1.5 * 1024 * 1024;
            if (!Number.isFinite(size) || size <= 0 || size > maxBytes) return null;
            r = await client.requestBytes(assetPath(roomId, name2, false), { maxBytes });
            checkRoom();
            if (!current()) return null;
          }
          if (r.status !== 200 || !r.buffer) {
            return null;
          }
          if (!thumb && current() && ctx.scratchpad) {
            await ctx.scratchpad.asset(roomId, name2, r.buffer, r.type, current).catch(() => {
            });
          }
          return { buffer: r.buffer, type: r.type || "application/octet-stream" };
        }
        const dataUrl = (b) => b ? "data:" + b.type.split(";")[0] + ";base64," + b.buffer.toString("base64") : null;
        ipcMain2.handle("rooms:thumb", wrap(async (a) => dataUrl(await bytes(a.roomId, a.name, true, a.w))));
        ipcMain2.handle("rooms:image", wrap(async (a) => dataUrl(await bytes(a.roomId, a.name, false))));
        ipcMain2.handle("rooms:download", wrap(async (a, e) => {
          const b = await bytes(a.roomId, a.name, false);
          if (!b) {
            return false;
          }
          if (import_process.default.env.WB_SELFTEST) {
            return { bytes: b.buffer.length };
          }
          if (ctx.native && typeof ctx.native.saveFile === "function") return ctx.native.saveFile({ name: String(a.name), type: b.type, buffer: b.buffer });
          const r = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath("downloads"), String(a.name)) });
          if (r.canceled || !r.filePath) {
            return false;
          }
          fs.writeFileSync(r.filePath, b.buffer);
          return true;
        }));
        ipcMain2.handle("rooms:open-window", wrap(async (a) => {
          const b = await bytes(a.roomId, a.name, false);
          if (!b) {
            return false;
          }
          if (import_process.default.env.WB_SELFTEST) {
            return { bytes: b.buffer.length };
          }
          if (ctx.native && typeof ctx.native.openAsset === "function") return ctx.native.openAsset({ roomId: a.roomId, name: String(a.name), type: b.type });
          const w = new BrowserWindow({ width: 1e3, height: 760, title: String(a.name), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
          w.loadURL(dataUrl(b)).catch(() => {
          });
          return true;
        }));
        async function callRaw(method, p, buffer, headers) {
          requestFence(method, p);
          if (!cookies) {
            throw Object.assign(new Error("signed out"), { code: "signed-out" });
          }
          let r;
          try {
            r = await client.requestRaw(method, p, buffer, headers);
          } catch (e) {
            if (localMode && e.code === "account-changed") throw e;
            const off = !online();
            if (off) {
              setConn("offline");
              scheduleReconnect();
            } else {
              setConn("down");
              scheduleReconnect();
            }
            throw Object.assign(new Error(e.message || "unreachable"), { code: off ? "offline" : e.code || "unreachable" });
          }
          if (r.status === 401 || r.status === 302) {
            signedOut("auth");
            throw Object.assign(new Error("signed out"), { code: "signed-out", status: r.status });
          }
          return r;
        }
        const roomPath = (id, sub) => "/api/rooms/" + encodeURIComponent(String(id)) + (sub ? "/" + sub : "");
        const answer2 = (r, what) => {
          if (r.status >= 200 && r.status < 300) {
            return r.json;
          }
          const err = Object.assign(new Error(r.json && (r.json.error || r.json.message) || what + " " + r.status), { code: "http", status: r.status, field: r.json && r.json.field, body: r.json });
          throw err;
        };
        async function post(id, a) {
          const body = { text: String(a && a.text != null ? a.text : "") };
          if (Number.isFinite(a && a.reply_to)) {
            body.reply_to = Number(a.reply_to);
          }
          if (Array.isArray(a && a.attachments) && a.attachments.length) {
            body.attachments = a.attachments.map(String);
          }
          if (Array.isArray(a && a.links) && a.links.length) {
            body.links = a.links;
          }
          if (a && a.confirm) {
            body.confirm = String(a.confirm);
          }
          if (a && a.keep_draft) {
            body.keep_draft = true;
          }
          const r = await call("POST", roomPath(id, "line"), { body });
          const j = answer2(r, "post");
          if (j && Array.isArray(j.entries) && j.entries.length) {
            const entries = merge(id, j.entries);
            j.entries = entries;
            broadcast("rooms:line", { roomId: id, entries, why: "post" });
          }
          cause("rooms-post", { room: id, status: j && j.status, n: j && j.entries ? j.entries.length : 0 });
          return j;
        }
        const draft = async (id) => answer2(await call("GET", roomPath(id, "draft")), "draft");
        const setDraft = async (id, a) => answer2(await call("PUT", roomPath(id, "draft"), { body: { text: String(a && a.text != null ? a.text : ""), ...a && "reply_to" in a ? { reply_to: a.reply_to } : {} } }), "draft");
        const scratch = async (id) => answer2(await call("GET", roomPath(id, "scratch")), "scratch");
        async function scratchUpload(id, a) {
          const buffer = import_buffer.Buffer.isBuffer(a.bytes) ? a.bytes : import_buffer.Buffer.from(a.bytes || []);
          const headers = { "x-filename": encodeURIComponent(String(a.name || "file")), "content-type": String(a.type || "application/octet-stream") };
          if (a.key) {
            headers["x-upload-key"] = String(a.key);
          }
          if (Number.isFinite(a.pos)) {
            headers["x-upload-pos"] = String(a.pos);
          }
          const current = roomCopyFence();
          const result = answer2(await callRaw("POST", roomPath(id, "scratch"), buffer, headers), "upload");
          if (current() && ctx.scratchpad) {
            await ctx.scratchpad.asset(id, String(a.name || "file"), buffer, headers["content-type"], current).catch(() => {
            });
          }
          return result;
        }
        const scratchRemove = async (id, fileId) => answer2(await call("DELETE", roomPath(id, "scratch/" + encodeURIComponent(String(fileId)))), "remove");
        const scratchOrder = async (id, ids) => answer2(await call("PUT", roomPath(id, "scratch/order"), { body: { ids: (ids || []).map(String) } }), "order");
        const assets = async (id) => answer2(await call("GET", roomPath(id, "assets")), "assets");
        const notes = async (id, q) => answer2(await call("GET", roomPath(id, "notes") + (q ? "?q=" + encodeURIComponent(q) : "?summary=1")), "notes");
        async function withNoteCopy(id, request) {
          const current = roomCopyFence();
          const result = answer2(await request(), "note");
          if (current() && ctx.scratchpad && typeof result?.note?.text === "string" && result.note.text.trim()) {
            await ctx.scratchpad.note(id, result.note, current).catch(() => {
            });
          }
          return result;
        }
        const note = async (id, nid) => withNoteCopy(id, () => call("GET", roomPath(id, "notes/" + encodeURIComponent(String(nid)))));
        const noteCreate = async (id, text3) => withNoteCopy(id, () => call("POST", roomPath(id, "notes"), { body: { text: String(text3 || "") } }));
        const noteSet = async (id, nid, text3) => withNoteCopy(id, () => call("PUT", roomPath(id, "notes/" + encodeURIComponent(String(nid))), { body: { text: String(text3 || "") } }));
        const noteAttach = async (id, nid) => answer2(await call("POST", roomPath(id, "notes/" + encodeURIComponent(String(nid)) + "/attach"), { body: {} }), "note");
        const noteClose = async (id, nid) => answer2(await call("POST", roomPath(id, "notes/" + encodeURIComponent(String(nid)) + "/close"), { body: {} }), "note");
        async function commands() {
          return answer2(await call("GET", "/api/rooms/commands"), "commands");
        }
        ipcMain2.handle("rooms:post", wrap((a) => post(String(a && a.id), a || {})));
        ipcMain2.handle("rooms:draft", wrap((a) => draft(String(a && a.id))));
        ipcMain2.handle("rooms:draft-set", wrap((a) => setDraft(String(a && a.id), a || {})));
        ipcMain2.handle("rooms:scratch", wrap((a) => scratch(String(a && a.id))));
        ipcMain2.handle("rooms:scratch-upload", wrap((a) => scratchUpload(String(a && a.id), a || {})));
        ipcMain2.handle("rooms:scratch-remove", wrap((a) => scratchRemove(String(a && a.id), a && a.fileId)));
        ipcMain2.handle("rooms:scratch-order", wrap((a) => scratchOrder(String(a && a.id), a && a.ids)));
        ipcMain2.handle("rooms:assets", wrap((a) => assets(String(a && a.id))));
        ipcMain2.handle("rooms:notes", wrap((a) => notes(String(a && a.id), a && a.q)));
        ipcMain2.handle("rooms:note", wrap((a) => note(String(a && a.id), a && a.nid)));
        ipcMain2.handle("rooms:note-create", wrap((a) => noteCreate(String(a && a.id), a && a.text)));
        ipcMain2.handle("rooms:note-set", wrap((a) => noteSet(String(a && a.id), a && a.nid, a && a.text)));
        ipcMain2.handle("rooms:note-attach", wrap((a) => noteAttach(String(a && a.id), a && a.nid)));
        ipcMain2.handle("rooms:note-close", wrap((a) => noteClose(String(a && a.id), a && a.nid)));
        ipcMain2.handle("rooms:commands", wrap(() => commands()));
        const str = (v, n) => typeof v === "string" ? v.slice(0, n) : void 0;
        const only = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== void 0).map((k) => [k, o[k]]));
        async function after(id, j) {
          if (j && Array.isArray(j.entries) && j.entries.length) {
            const entries = merge(id, j.entries);
            j.entries = entries;
            broadcast("rooms:line", { roomId: id, entries, why: "post" });
          }
          try {
            const v = await room(id);
            if (v) {
              broadcast("rooms:room", { roomId: id, view: v });
            }
            await list({ force: true });
          } catch (e) {
          }
          return j;
        }
        async function roomCreate(a) {
          const body = { name: str(a && a.name, 80) || "" };
          if (a && a.alias) {
            body.alias = str(a.alias, 40);
          }
          if (a && a.parent_id) {
            body.parent_id = String(a.parent_id);
          }
          const j = answer2(await call("POST", "/api/rooms", { body }), "create");
          await list({ force: true }).catch(() => {
          });
          cause("rooms-create", { workgroup: !!body.parent_id });
          return j;
        }
        async function roomPatch(id, a) {
          const body = only(a, ["name", "lead_seat", "mode", "brief"]);
          if (disconnected(id) && Object.keys(body).some((key) => key !== "name")) roomFence(id);
          const result = answer2(await call("PATCH", roomPath(id), { body }), "room");
          if (disconnected(id)) {
            const view = rooms.find((v) => v.room?.id === id);
            if (view && body.name !== void 0) view.room = { ...view.room, name: body.name };
            broadcast("rooms:rooms", { rooms });
            return result;
          }
          return after(id, result);
        }
        async function roomState(id, verb) {
          if (!["archive", "reopen", "dissolve"].includes(verb)) {
            throw Object.assign(new Error("no such room action"), { code: "bad-request" });
          }
          const j = answer2(await call("POST", roomPath(id, verb), { body: {} }), verb);
          cause("rooms-state", { verb });
          return after(verb === "dissolve" && j && j.parent ? j.parent : id, j);
        }
        async function workgroupCreate(id, a) {
          const body = { name: str(a && a.name, 80) || "" };
          if (a && a.alias) {
            body.alias = str(a.alias, 40);
          }
          if (Array.isArray(a && a.move) && a.move.length) {
            body.move = a.move.slice(0, 20).map(String);
          }
          if (Array.isArray(a && a.start) && a.start.length) {
            body.start = a.start.slice(0, 20).map((x) => ({ recipe_id: String(x.recipe_id), ...x.handle ? { handle: String(x.handle) } : {} }));
          }
          return after(id, answer2(await call("POST", roomPath(id, "workgroups"), { body }), "workgroup"));
        }
        async function familyCheck(id, a) {
          const q = new URLSearchParams();
          if (a && a.alias) {
            q.append("alias", String(a.alias));
          }
          for (const h of (a && a.handles || []).slice(0, 50)) {
            q.append("handle", String(h));
          }
          return answer2(await call("GET", roomPath(id, "family-check") + "?" + q.toString()), "check");
        }
        const seatPath = (id, sid, sub) => roomPath(id, "seats/" + encodeURIComponent(String(sid)) + (sub ? "/" + sub : ""));
        const POLICIES = ["persistent", "fresh", "dispatched", "pool"];
        function policyBody(a) {
          const b = {};
          if (a && a.policy !== void 0) {
            if (!POLICIES.includes(a.policy)) {
              throw Object.assign(new Error("no such policy"), { code: "bad-request" });
            }
            b.policy = a.policy;
          }
          if (a && a.pool_size !== void 0) {
            b.pool_size = Math.max(1, Math.min(20, Number(a.pool_size) || 1));
          }
          return b;
        }
        async function seatAdd(id, a) {
          const body = { ...policyBody(a) };
          if (a && a.recipe_id) {
            body.recipe_id = String(a.recipe_id);
          } else if (a && a.project) {
            body.project = String(a.project);
          }
          if (a && a.handle) {
            body.handle = str(a.handle, 40);
          }
          return after(id, answer2(await call("POST", roomPath(id, "seats"), { body }), "seat"));
        }
        async function seatPatch(id, sid, a) {
          const body = { ...policyBody(a) };
          if (a && a.handle) {
            body.handle = str(a.handle, 40);
          }
          return after(id, answer2(await call("PATCH", seatPath(id, sid), { body }), "seat"));
        }
        const seatRemove = async (id, sid) => after(id, answer2(await call("DELETE", seatPath(id, sid), { body: {} }), "remove"));
        const seatHistory = async (id, sid) => answer2(await call("GET", seatPath(id, sid, "history")), "history");
        const seatMove = async (id, sid, to) => after(id, answer2(await call("POST", seatPath(id, sid, "move"), { body: { to_room: String(to) } }), "move"));
        async function seatStart(id, sid, a) {
          const body = {};
          if (a && a.fresh) {
            body.fresh = true;
          }
          if (a && a.model) {
            body.model = str(a.model, 80);
          }
          return after(id, answer2(await call("POST", seatPath(id, sid, "start"), { body }), "start"));
        }
        const wakeDeliver = async (id, sid, lineId) => after(id, answer2(await call("POST", seatPath(id, sid, "wake-deliver"), { body: { lineId: Number(lineId) } }), "wake"));
        async function seatEnd(id, sid, expectedPane) {
          if (!localMode) throw Error("Stop is available only for a local shell seat.");
          const epoch = authEpoch, base = client.base(), checkRoom = roomFence(id);
          const check = () => {
            if (!cookies || suspended || epoch !== authEpoch || base !== client.base()) throw Error("Local rooms changed. Reopen the seat menu.");
            checkRoom();
          };
          check();
          const recipes2 = answer2(await call("GET", "/api/recipes"), "recipes");
          check();
          const view = await room(id);
          check();
          const seat = view?.seats?.find((s) => s.id === sid && !s.left_at);
          if (!seat || !["live", "parked"].includes(seat.status) || !expectedPane || seat.occupant?.id !== expectedPane) {
            throw Error("This seat changed or is no longer running. Reopen its menu.");
          }
          const recipe = recipes2?.recipes?.find((r) => r.id === seat.recipe_id);
          if (!recipe || recipe.target !== "local" || recipe.vendor !== "cli-manager" || recipe.agent) {
            throw Error("This is not a plain shell seat. Use Disconnect for an assistant.");
          }
          return after(id, answer2(await call("POST", "/api/sessions/" + encodeURIComponent(seat.occupant.id) + "/end", { body: {} }), "end"));
        }
        const seatDisconnect = async (id, sid) => after(id, answer2(await call("POST", seatPath(id, sid, "disconnect"), { body: {} }), "disconnect"));
        async function seatProfile(id, sid, a) {
          const body = {};
          for (const k of ["model", "effort"]) {
            if (!a || !(k in a)) {
              continue;
            }
            const v = a[k];
            if (v === null || v === "") {
              body[k] = null;
            } else if (typeof v === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(v)) {
              body[k] = v;
            } else {
              throw Object.assign(new Error(k + " is a name (letters, digits, . _ -)"), { code: "bad-request" });
            }
          }
          if (!Object.keys(body).length) {
            throw Object.assign(new Error("nothing to change"), { code: "bad-request" });
          }
          return after(id, answer2(await call("PATCH", seatPath(id, sid, "profile"), { body }), "profile"));
        }
        const seatCloseWindow = async (id, sid) => after(id, answer2(await call("POST", seatPath(id, sid, "close-window"), { body: {} }), "close-window"));
        const seatReloadPreview = async (id, sid) => answer2(await call("GET", seatPath(id, sid, "reload")), "reload");
        const seatReload = async (id, sid, a) => after(id, answer2(await call("POST", seatPath(id, sid, "reload"), { body: { force: !!(a && a.force), openTab: false, welcome: { mode: "none" } } }), "reload"));
        async function roomSettings(id, a) {
          const body = {};
          if (a && typeof a.color === "string" && /^#[0-9a-f]{6}$/i.test(a.color)) {
            body.color = a.color;
          }
          if (!Object.keys(body).length) {
            throw Object.assign(new Error("nothing to change"), { code: "bad-request" });
          }
          return after(id, answer2(await call("PATCH", roomPath(id, "settings"), { body }), "settings"));
        }
        const presence = async () => answer2(await call("GET", "/api/presence/user"), "presence");
        const recipes = async () => answer2(await call("GET", "/api/recipes"), "recipes");
        const deliverHeld = async (id, paneid) => after(id, answer2(await call("POST", "/api/panes/" + encodeURIComponent(String(paneid)) + "/deliver-held", { body: {} }), "deliver"));
        ipcMain2.handle("rooms:create", wrap((a) => roomCreate(a || {})));
        ipcMain2.handle("rooms:patch", wrap((a) => roomPatch(String(a && a.id), a || {})));
        ipcMain2.handle("rooms:state", wrap((a) => roomState(String(a && a.id), String(a && a.verb))));
        ipcMain2.handle("rooms:workgroup", wrap((a) => workgroupCreate(String(a && a.id), a || {})));
        ipcMain2.handle("rooms:family-check", wrap((a) => familyCheck(String(a && a.id), a || {})));
        ipcMain2.handle("rooms:seat-add", wrap((a) => seatAdd(String(a && a.id), a || {})));
        ipcMain2.handle("rooms:seat-patch", wrap((a) => seatPatch(String(a && a.id), a && a.sid, a || {})));
        ipcMain2.handle("rooms:seat-remove", wrap((a) => seatRemove(String(a && a.id), a && a.sid)));
        ipcMain2.handle("rooms:seat-history", wrap((a) => seatHistory(String(a && a.id), a && a.sid)));
        ipcMain2.handle("rooms:seat-move", wrap((a) => seatMove(String(a && a.id), a && a.sid, a && a.to)));
        ipcMain2.handle("rooms:seat-start", wrap((a) => seatStart(String(a && a.id), a && a.sid, a || {})));
        ipcMain2.handle("rooms:wake-deliver", wrap((a) => wakeDeliver(String(a && a.id), a && a.sid, a && a.lineId)));
        ipcMain2.handle("rooms:seat-end", wrap((a) => seatEnd(String(a && a.id), String(a && a.sid), a && a.paneid)));
        ipcMain2.handle("rooms:seat-disconnect", wrap((a) => seatDisconnect(String(a && a.id), a && a.sid)));
        ipcMain2.handle("rooms:seat-close-window", wrap((a) => seatCloseWindow(String(a && a.id), a && a.sid)));
        ipcMain2.handle("rooms:seat-reload-preview", wrap((a) => seatReloadPreview(String(a && a.id), a && a.sid)));
        ipcMain2.handle("rooms:seat-reload", wrap((a) => seatReload(String(a && a.id), a && a.sid, a || {})));
        ipcMain2.handle("rooms:seat-profile", wrap((a) => seatProfile(String(a && a.id), a && a.sid, a || {})));
        ipcMain2.handle("rooms:settings", wrap((a) => roomSettings(String(a && a.id), a || {})));
        ipcMain2.handle("rooms:presence", wrap(() => presence()));
        ipcMain2.handle("rooms:recipes", wrap(() => recipes()));
        function localSeatLocation(seatId) {
          return localMode ? require_seat_pane().locateSeat(rooms, seatId) : null;
        }
        async function mintTerminal(a) {
          const v = await room(String(a.room));
          const seat = v && Array.isArray(v.seats) ? v.seats.find((x) => x.id === String(a.seat) && !x.left_at) : null;
          if (!seat) {
            return { ok: false, why: "gone", status: 404 };
          }
          if (!seat.occupant || !seat.occupant.id || !["live", "parked"].includes(seat.status)) {
            return { ok: false, why: "not-live", status: 409 };
          }
          const body = { paneid: String(seat.occupant.id), intent: a.intent === "control" ? "control" : "view", room: String(a.room), seat: String(a.seat) };
          const r = await call("POST", "/api/terminal-grants", { body });
          if (r.status !== 200 || !r.json || !r.json.grant) {
            const why = r.status === 409 ? "not-live" : r.status === 429 ? "too-many" : r.status === 404 && !(r.json && r.json.field) ? "off" : r.status === 403 && r.json && r.json.field === "accounts" ? "off" : r.status === 403 ? "not-allowed" : r.status === 404 ? "gone" : "error";
            cause("term-grant-refused", { status: r.status, why });
            return { ok: false, why, status: r.status, limit: r.json && r.json.limit ? Number(r.json.limit) : null };
          }
          let u;
          try {
            u = new URL(String(r.json.socket || "/term"), client.base());
          } catch {
            return { ok: false, why: "error", status: 0 };
          }
          if (localMode) {
            const engine = new URL(client.base());
            if (!["http:", "ws:"].includes(u.protocol) || engine.protocol !== "http:" || engine.hostname !== "127.0.0.1" || u.hostname !== engine.hostname || u.port !== engine.port || u.username || u.password || u.pathname !== "/term" || u.search || u.hash) {
              return { ok: false, why: "error", status: 0 };
            }
            u.protocol = "ws:";
          } else if (u.protocol === "https:") {
            u.protocol = "wss:";
          } else if (u.protocol === "http:" && import_process.default.env.WB_SELFTEST) {
            u.protocol = "ws:";
          } else if (u.protocol !== "wss:") {
            return { ok: false, why: "error", status: 0 };
          }
          cause("term-grant-minted", { intent: body.intent });
          return { ok: true, grant: String(r.json.grant), socket: u.toString(), cookie: localMode ? client.currentCookie() : cookieHeader(cookies), expiresIn: Number(r.json.expires_in) || 30, paneid: body.paneid };
        }
        ipcMain2.handle("rooms:deliver-held", wrap((a) => deliverHeld(String(a && a.id), a && a.paneid)));
        async function historyCall(method, suffix = "", body, roomId) {
          const epoch = authEpoch, base = client.base();
          const checkRoom = roomId === void 0 ? () => {
          } : roomFence(roomId);
          const check = () => {
            if (!cookies || suspended || epoch !== authEpoch || base !== client.base()) throw Object.assign(new Error("Account or engine changed. Reopen settings."), { code: "account-changed" });
            checkRoom();
          };
          check();
          let result;
          try {
            result = await call(method, "/api/history-export" + suffix, body === void 0 ? void 0 : { body });
          } catch (error2) {
            check();
            throw error2;
          }
          check();
          return answer2(result, "history export");
        }
        ipcMain2.handle("rooms:history-get", wrap(() => historyCall("GET")));
        ipcMain2.handle("rooms:history-set", wrap((a) => {
          if (typeof a?.enabled !== "boolean") throw Object.assign(new Error("Expected history enabled boolean"), { code: "bad-request" });
          return historyCall("PATCH", "", { enabled: a.enabled });
        }));
        ipcMain2.handle("rooms:history-export", wrap((a) => {
          const id = a?.roomId;
          if (id !== void 0 && (typeof id !== "string" || !rooms.some((view) => view.room?.id === id))) throw Object.assign(new Error("Room is unavailable"), { code: "bad-request" });
          return historyCall("POST", "/run", { now: true, ...id === void 0 ? {} : { roomId: id } }, id);
        }));
        ipcMain2.handle("rooms:history-start", wrap(() => historyCall("POST", "/run", {})));
        ipcMain2.handle("rooms:history-cancel", wrap(() => historyCall("POST", "/cancel", {})));
        const picks = [];
        ipcMain2.handle("rooms:pick-files", async (e) => {
          let paths;
          if (ctx.native && typeof ctx.native.pickFiles === "function" && !import_process.default.env.WB_SELFTEST) return ctx.native.pickFiles({ max: 10, limit: 25 * 1024 * 1024, mimeOf });
          if (import_process.default.env.WB_SELFTEST) {
            paths = picks.shift() || [];
          } else {
            const w = BrowserWindow.fromWebContents(e.sender);
            const r = await dialog.showOpenDialog(w, { properties: ["openFile", "multiSelections"] });
            paths = r.canceled ? [] : r.filePaths;
          }
          const out = [];
          for (const f of paths.slice(0, 10)) {
            try {
              const size = fs.statSync(f).size;
              const name2 = path.basename(f);
              out.push(size > 25 * 1024 * 1024 ? { name: name2, type: mimeOf(name2), size } : { name: name2, type: mimeOf(name2), size, bytes: fs.readFileSync(f) });
            } catch (err) {
            }
          }
          return out;
        });
        ipcMain2.handle("rooms:me", wrap(async (patch) => {
          const body = patch && typeof patch === "object" ? { ...patch } : {};
          if (body.picture !== void 0 && body.picture !== null && !profilePicture(body.picture)) {
            throw Object.assign(new Error("picture: inline PNG, JPEG or WebP up to 256 KB, or null"), { code: "bad-request" });
          }
          if (body.color !== void 0 && body.color !== null && !colorOrNull(body.color)) {
            throw Object.assign(new Error("color: #rrggbb or null"), { code: "bad-request" });
          }
          const current = roomCopyFence();
          const r = await call("PATCH", "/api/rooms/me", { body });
          if (!current()) throw Object.assign(new Error("account changed"), { code: "account-changed" });
          if (r.status === 200 && r.json) {
            if (r.json.picture !== void 0) pictureData = profilePicture(r.json.picture);
            me = { handle: r.json.handle || me && me.handle || null, name: r.json.name || me && me.name || null, hiddenRooms: Array.isArray(r.json.hiddenRooms) ? r.json.hiddenRooms : me && me.hiddenRooms || [], color: r.json.color !== void 0 ? colorOrNull(r.json.color) : me && me.color || null, tones: r.json.tones !== void 0 ? r.json.tones : me && me.tones || {}, enterSubmits: typeof r.json.enterSubmits === "boolean" ? r.json.enterSubmits : me && me.enterSubmits, pictureKey: profilePictureKey(pictureData) };
            broadcast("rooms:status", status());
            return me;
          }
          throw Object.assign(new Error("me " + r.status), { code: "bad-answer", status: r.status });
        }));
        if (cookies) {
          conn = "polling";
          setTimeout(() => resume().catch(() => {
          }), 200);
          scheduleRenew();
        } else if (!import_process.default.env.WB_SELFTEST) {
          setTimeout(() => quietSignIn("start").catch(() => {
          }), 200);
        }
        return {
          status,
          setLocalSession,
          deactivate: () => {
            suspended = true;
            authEpoch++;
            autoBusy = null;
            clearTimeout(renewTimer);
            clearTimeout(retryTimer);
            clearInterval(pollTimer);
            renewTimer = retryTimer = pollTimer = null;
            stopLinePoll();
            live.close();
            liveOpen = false;
          },
          activate: () => {
            suspended = false;
            broadcast("rooms:status", status());
            if (cookies) {
              scheduleRenew();
              resume().catch(() => {
              });
            } else accountChanged();
          },
          forget: () => {
            authEpoch++;
            suspended = true;
            clearTimeout(renewTimer);
            clearInterval(pollTimer);
            signedOut("account");
          },
          setServer,
          tasksBound,
          tasksRoom,
          tasksEpoch: () => authEpoch,
          tasksRoomTasksPanel: (roomId) => typeof roomId === "string" && !!roomTasksPanel(roomId),
          // revision 10: main's rule for kind room-tasks
          signIn,
          signOut,
          quietSignIn,
          accountChanged,
          /** Self-test only: the realm side (a fake ticket source) and the renew timer's due time. */
          setRealm: import_process.default.env.WB_SELFTEST ? (r, o = {}) => {
            const was = realm;
            realm = r;
            if (o.gapMs !== void 0) {
              exchangeGapMs = o.gapMs;
            }
            return was;
          } : void 0,
          autoState: import_process.default.env.WB_SELFTEST ? () => ({ ...auto, renewDue: !!renewTimer, lastExchange }) : void 0,
          list,
          room,
          line,
          seen,
          setVisible,
          connection,
          post,
          draft,
          setDraft,
          scratch,
          scratchUpload,
          scratchRemove,
          scratchOrder,
          assets,
          notes,
          note,
          noteCreate,
          noteSet,
          noteClose,
          noteAttach,
          commands,
          // W3
          roomCreate,
          roomPatch,
          roomState,
          workgroupCreate,
          familyCheck,
          seatAdd,
          seatPatch,
          seatRemove,
          seatHistory,
          seatMove,
          seatStart,
          wakeDeliver,
          seatDisconnect,
          seatEnd,
          seatProfile,
          seatCloseWindow,
          seatReloadPreview,
          seatReload,
          roomSettings,
          presence,
          recipes,
          deliverHeld,
          mintTerminal,
          localSeatLocation,
          // self-test only
          test: import_process.default.env.WB_SELFTEST ? {
            live,
            secretsFileHas: (s) => {
              try {
                return fs.readFileSync(secPath, "utf8").includes(s);
              } catch (e) {
                return false;
              }
            },
            keychain,
            dropSocket: () => live.close(),
            cache: (id) => lines.get(id),
            queuePick: (paths) => picks.push(paths),
            setOffline: (v) => {
              testOffline = !!v;
            }
          } : void 0
        };
      }
      module.exports = { init };
    }
  });

  // src/rooms/scoped.js
  var require_scoped = __commonJS({
    "src/rooms/scoped.js"(exports, module) {
      "use strict";
      init_globals();
      var { ipcMain } = require_electron();
      var path = require_path();
      var core = require_rooms();
      function init(ctx) {
        const clients = /* @__PURE__ */ new Map();
        const applied = /* @__PURE__ */ new Map();
        const handles = /* @__PURE__ */ new Set(), events = /* @__PURE__ */ new Set();
        const historyCalls = /* @__PURE__ */ new Set(["rooms:history-get", "rooms:history-set", "rooms:history-export", "rooms:history-start", "rooms:history-cancel"]);
        let selected = ctx.accounts?.activeId() || null;
        let selectionVersion = ctx.accounts?.selectionVersion() || 0;
        const scope = () => ({ accountId: ctx.accounts?.activeId() || null, selectionVersion: ctx.accounts?.selectionVersion() || 0 });
        const matches = (wanted) => {
          const now = scope();
          return wanted && Number.isSafeInteger(wanted.selectionVersion) && wanted.selectionVersion >= 0 && wanted.accountId === selected && wanted.accountId === now.accountId && wanted.selectionVersion === now.selectionVersion;
        };
        const refused2 = () => ({ ok: false, code: "account-changed", why: "account-changed" });
        const valid = (id) => id === null || !!ctx.accounts?.has(id);
        function client(id) {
          if (!valid(id)) return null;
          const old = clients.get(id);
          if (old?.bound && !old.bound.has()) {
            old.api.forget();
            clients.delete(id);
          }
          if (clients.has(id)) return clients.get(id);
          const handlers = /* @__PURE__ */ new Map(), listeners = /* @__PURE__ */ new Map();
          const bound = id ? ctx.accounts.forAccount(id) : null;
          const ipc = {
            handle(channel, fn) {
              if (channel.startsWith("rooms:history-") && !historyCalls.has(channel)) throw new Error("Unsupported history call");
              handlers.set(channel, fn);
              if (handles.has(channel)) return;
              handles.add(channel);
              ipcMain.handle(channel, async (event, envelope) => {
                const wanted = envelope?.scope;
                if (!matches(wanted) || !Array.isArray(envelope.args)) return refused2();
                const c2 = client(wanted.accountId);
                if (!c2 || c2.bound && !c2.bound.has()) return refused2();
                const result = await c2.handlers.get(channel)(event, ...envelope.args);
                if (!matches(wanted) || clients.get(wanted.accountId) !== c2 || c2.bound && !c2.bound.has()) return refused2();
                return channel === "rooms:status" ? { ...result, ...scope() } : result;
              });
            },
            on(channel, fn) {
              listeners.set(channel, fn);
              if (events.has(channel)) return;
              events.add(channel);
              ipcMain.on(channel, (event, envelope) => {
                if (!matches(envelope?.scope) || !Array.isArray(envelope.args)) return;
                client(envelope.scope.accountId)?.listeners.get(channel)?.(event, ...envelope.args);
              });
            }
          };
          const generation = {};
          const server = ctx.serverFor && ctx.serverFor(id) || ctx.server;
          applied.set(id, server);
          const api = core.init({
            ...ctx,
            accountId: id,
            server,
            ipcMain: ipc,
            localMode: ctx.localMode === true && id === null,
            scratchpad: ctx.scratchpadFor?.(id, () => clients.get(id)?.generation === generation && valid(id) && selected === id && scope().accountId === id && (!bound || bound.has())),
            dir: id ? path.join(ctx.dir, "accounts", id, "rooms") : ctx.dir,
            realm: bound ? { present: () => bound.has(), ticket: () => bound.engineTicket(), signedInAt: () => bound.signedInAt() } : ctx.realm,
            broadcast: (channel, payload) => {
              if (valid(id) && selected === id && scope().accountId === id && (!bound || bound.has())) ctx.broadcast(channel, { ...payload, ...scope(), accountId: id });
            }
          });
          const c = { api, handlers, listeners, bound, generation };
          clients.set(id, c);
          return c;
        }
        client(selected);
        function applyAddresses() {
          if (!ctx.serverFor) return;
          for (const [id, c] of clients) {
            const url = ctx.serverFor(id);
            if (url && applied.get(id) !== url) {
              applied.set(id, url);
              c.api.setServer(url, { switch: true });
            }
          }
        }
        function accountChanged() {
          const next = ctx.accounts?.activeId() || null;
          const version = scope().selectionVersion;
          if (next !== selected || version !== selectionVersion) {
            selectionVersion = version;
            clients.get(selected)?.api.deactivate();
            selected = next;
            const c = client(next);
            ctx.broadcast("rooms:account", scope());
            c.api.activate();
          } else client(selected).api.accountChanged();
        }
        return new Proxy({
          accountChanged,
          applyAddresses,
          status: () => ({ ...client(selected).api.status(), ...scope() }),
          signedOut(id) {
            clients.get(id)?.api.forget();
            clients.delete(id);
            applied.delete(id);
            accountChanged();
          },
          forAccount: (id) => client(id)?.api || null,
          /** S3: a module window's request goes to the client of the account main captured as its owner, only while that
           *  account is still selected with the same selection version; a reply after a switch is dropped (revision 9, R9.2). */
          async tasksBound(s, verb, input) {
            const wanted = s && typeof s === "object" ? { accountId: s.accountId === void 0 ? void 0 : s.accountId, selectionVersion: s.selectionVersion } : null;
            if (!matches(wanted)) return refused2();
            const c = clients.get(wanted.accountId);
            if (!c || c.bound && !c.bound.has()) return refused2();
            const r = await c.api.tasksBound(s, verb, input);
            if (!matches(wanted) || clients.get(wanted.accountId) !== c || c.bound && !c.bound.has()) return refused2();
            return r;
          },
          tasksRoom: (accountId, roomId) => accountId === selected && scope().accountId === accountId ? clients.get(selected)?.api.tasksRoom(roomId) ?? null : null,
          tasksEpoch: () => clients.get(selected)?.api.tasksEpoch() ?? null,
          tasksRoomTasksPanel: (accountId, roomId) => accountId === selected && scope().accountId === accountId ? !!clients.get(selected)?.api.tasksRoomTasksPanel(roomId) : false,
          stop: () => {
            for (const c of clients.values()) c.api.deactivate();
          }
        }, { get: (target, key) => key in target ? target[key] : client(selected)?.api[key] });
      }
      module.exports = { init };
    }
  });

  // web/lib/native-browser.js
  var require_native_browser = __commonJS({
    "web/lib/native-browser.js"(exports, module) {
      "use strict";
      init_globals();
      var BLOB_TYPE_OK = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
      function pickFiles({ max = 10, limit = 25 * 1024 * 1024, mimeOf = () => "application/octet-stream" } = {}, doc = globalThis.document) {
        return new Promise((resolve) => {
          const input = doc.createElement("input");
          input.type = "file";
          input.multiple = true;
          input.hidden = true;
          let done = false;
          const finish = (list) => {
            if (done) return;
            done = true;
            input.remove();
            resolve(list);
          };
          input.addEventListener("cancel", () => finish([]));
          input.addEventListener("change", async () => {
            const out = [];
            for (const f of [...input.files || []].slice(0, max)) {
              try {
                const type = f.type && BLOB_TYPE_OK.test(f.type) ? f.type : mimeOf(f.name);
                out.push(f.size > limit ? { name: f.name, type, size: f.size } : { name: f.name, type, size: f.size, bytes: new Uint8Array(await f.arrayBuffer()) });
              } catch (e) {
              }
            }
            finish(out);
          });
          doc.body.appendChild(input);
          input.click();
        });
      }
      function saveFile({ name: name2, type, buffer }, win = globalThis) {
        const doc = win.document;
        const url = win.URL.createObjectURL(new win.Blob([buffer], { type: "application/octet-stream" }));
        const a = doc.createElement("a");
        a.href = url;
        a.download = String(name2 || "file").replace(/[\\/\0]/g, "_").slice(0, 200);
        a.rel = "noopener";
        doc.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => win.URL.revokeObjectURL(url), 3e4);
        return true;
      }
      function assetUrl(roomId, name2) {
        return "/api/rooms/" + encodeURIComponent(String(roomId)) + "/assets/raw/" + encodeURIComponent(String(name2));
      }
      function openAsset({ roomId, name: name2 }, win = globalThis) {
        const w = win.open(assetUrl(roomId, name2), "_blank", "noopener,noreferrer");
        return !!w || w === null;
      }
      module.exports = { pickFiles, saveFile, openAsset, assetUrl };
    }
  });

  // web/handlers/rooms.js
  var require_rooms2 = __commonJS({
    "web/handlers/rooms.js"(exports, module) {
      "use strict";
      init_globals();
      var scoped = require_scoped();
      var rt3 = require_runtime();
      var native = require_native_browser();
      function register4(api) {
        const origin = globalThis.location ? globalThis.location.origin : "";
        const tasks = {
          // module-page task calls need the module host (a later slice): refuse, never fake an admission
          fromAppPage: () => false,
          admit: () => false,
          approvals: { mint: () => null }
        };
        scoped.init({
          accounts: void 0,
          // one person per server: no accounts, so the selection is {accountId:null, selectionVersion:0}
          localMode: false,
          dir: "/wb-web",
          server: origin,
          serverFor: () => origin,
          serverName: globalThis.location && globalThis.location.host || "",
          realm: null,
          cause: () => {
          },
          tasks,
          native,
          // rooms:pick-files / rooms:download / rooms:open-window: the browser's own chooser, download and a tab on the engine's raw route
          broadcast: (channel, payload) => rt3.emit(channel, payload)
        });
      }
      module.exports = { register: register4 };
    }
  });

  // src/renderer/web-agents/model.js
  function createAgentModel(api, { onState = () => {
  }, timeoutMs = 15e3 } = {}) {
    if (!api || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw TypeError("Agent API required");
    const timers = api.timers || globalThis;
    let alive = true, generation = 0, pending = null, abort = new AbortController();
    let st = { phase: "loading", programs: [], policy: null, programId: "", name: "", folder: "", choice: "follow", acknowledged: false, picking: false, error: null, answer: null, answerVersion: 0 };
    const publish = () => {
      if (alive) onState(copy(st));
    };
    const current = (mine) => {
      try {
        return alive && mine === generation && !abort.signal.aborted && (typeof api.current !== "function" || api.current() === true);
      } catch {
        return false;
      }
    };
    function set(field, value) {
      if (!current(generation) || st.phase !== "ready" || st.picking) return false;
      if (field === "name") {
        if (typeof value !== "string" || value.length > 60) return false;
      } else if (field === "programId") {
        if (!st.programs.some((p) => p.id === value)) return false;
      } else if (field === "choice") {
        if (!CHOICES.has(value)) return false;
        st.acknowledged = false;
      } else return false;
      st[field] = value;
      st.error = null;
      st.answer = null;
      publish();
      return true;
    }
    async function load() {
      if (!alive || pending || !["loading", "error"].includes(st.phase)) return false;
      const mine = ++generation;
      st.phase = "loading";
      st.error = null;
      publish();
      try {
        const [policy2, rows] = await Promise.all([api.readApproval({ signal: abort.signal }), api.programs()]);
        if (!current(mine)) return;
        if (!validPolicy(policy2) || !Array.isArray(rows)) throw Error("load");
        const programs = rows.filter((p) => p?.enabled !== false && PROGRAMS.has(p?.id)).map((p) => ({ id: p.id, label: String(p.label || p.id).slice(0, 60) }));
        if (!programs.length) throw Error("load");
        st = { ...st, phase: "ready", policy: { default: policy2.default, autoApproveDisclosedAt: policy2.autoApproveDisclosedAt }, programs, programId: programs[0].id, error: null };
        publish();
      } catch {
        if (current(mine)) {
          st.phase = "error";
          st.error = "load";
          publish();
        }
      }
    }
    async function pickFolder() {
      if (!current(generation) || st.phase !== "ready" || st.picking) return false;
      const mine = generation;
      st.picking = true;
      st.error = null;
      publish();
      try {
        const result = await api.chooseFolder({ signal: abort.signal });
        if (!current(mine)) return false;
        if (result?.ok === true && typeof result.path === "string" && result.path.startsWith("/") && result.path.length <= 300 && !/[\u0000-\u001f\u007f]/.test(result.path)) st.folder = result.path;
        else if (!["cancelled", "changed"].includes(result?.code)) st.error = "folder";
      } catch {
        if (current(mine)) st.error = "folder";
      } finally {
        if (current(mine)) {
          st.picking = false;
          publish();
        }
      }
    }
    function save() {
      if (pending) return pending;
      if (!current(generation) || st.phase !== "ready" || st.picking) return Promise.resolve(false);
      if (!st.name.trim() || !st.programs.some((p) => p.id === st.programId)) {
        st.error = "name";
        publish();
        return Promise.resolve(false);
      }
      if (st.choice === "on" && st.policy.autoApproveDisclosedAt === null && !st.acknowledged) {
        st.error = "disclosure";
        publish();
        return Promise.resolve(false);
      }
      const mine = generation, program = st.programs.find((p) => p.id === st.programId);
      const payload = {
        name: st.name.trim(),
        programId: st.programId,
        programLabel: program.label,
        folder: st.folder || "~",
        options: {},
        autoApprove: st.choice,
        ...st.choice === "on" && st.policy.autoApproveDisclosedAt === null && st.acknowledged ? { disclosed: true } : {}
      };
      st.phase = "saving";
      st.error = null;
      st.answer = null;
      publish();
      pending = (async () => {
        if (st.folder) {
          let found = false;
          try {
            found = await api.checkFolder(st.folder, { signal: abort.signal });
          } catch {
          }
          if (!current(mine)) return false;
          if (found !== true) {
            st.phase = "ready";
            st.error = "folder";
            publish();
            return false;
          }
        }
        if (!current(mine)) return false;
        let timer, result;
        try {
          result = await Promise.race([
            Promise.resolve().then(() => current(mine) ? api.save(payload, { signal: abort.signal }) : { unconfirmed: true }),
            new Promise((resolve) => {
              timer = timers.setTimeout(() => resolve({ unconfirmed: true }), timeoutMs);
            })
          ]);
        } catch {
          result = { unconfirmed: true };
        } finally {
          timers.clearTimeout(timer);
        }
        if (!current(mine)) return false;
        if (result?.unconfirmed === true) {
          st.phase = "unconfirmed";
          st.error = "unconfirmed";
          publish();
          return false;
        }
        if (result?.error || result?.ok === false) {
          if ([400, 401, 403, 404, 409, 413, 422].includes(result.status) || typeof result.field === "string") {
            if (typeof api.serverAnswer !== "function") throw TypeError("Server answer mapper required");
            const answer2 = api.serverAnswer(result);
            if (typeof answer2?.text !== "string") throw TypeError("Mapped sentence required");
            st.phase = "ready";
            st.error = "server-answer";
            st.answer = answer2;
            st.answerVersion++;
            if (answer2.action === "show-disclosure") {
              st.acknowledged = false;
              st.policy.autoApproveDisclosedAt = null;
            }
          } else {
            st.phase = "unconfirmed";
            st.error = "unconfirmed";
          }
          publish();
          return false;
        }
        if (typeof result?.id !== "string" || !result.id) {
          st.phase = "unconfirmed";
          st.error = "unconfirmed";
          publish();
          return false;
        }
        st.phase = "saved";
        st.savedId = result.id;
        publish();
        return true;
      })().finally(() => {
        pending = null;
      });
      return pending;
    }
    return Object.freeze({ load, set, pickFolder, save, state: () => copy(st), acknowledge(value) {
      if (current(generation) && st.phase === "ready" && st.choice === "on") {
        st.acknowledged = value === true;
        st.error = null;
        st.answer = null;
        publish();
      }
    }, dispose() {
      alive = false;
      ++generation;
      abort.abort();
      st = { ...st, phase: "closed" };
    } });
  }
  var CHOICES, PROGRAMS, copy, validPolicy;
  var init_model = __esm({
    "src/renderer/web-agents/model.js"() {
      init_globals();
      CHOICES = /* @__PURE__ */ new Set(["follow", "on", "off"]);
      PROGRAMS = /* @__PURE__ */ new Set(["claude-code", "codex-cli", "gemini-cli", "ollama", "shell"]);
      copy = (value) => JSON.parse(JSON.stringify(value));
      validPolicy = (p) => p && ["on", "off"].includes(p.default) && (p.autoApproveDisclosedAt === null || Number.isSafeInteger(p.autoApproveDisclosedAt) && p.autoApproveDisclosedAt >= 0);
    }
  });

  // src/renderer/web-shared/approval-segment.mjs
  function createApprovalSegment({ document: doc, value, label, disabled = false, onChange, current, testPrefix = "web-recipe" }) {
    if (!["follow", "on", "off"].includes(value) || typeof onChange !== "function" || typeof current !== "function") throw TypeError("Invalid approval selector");
    const group = doc.createElement("div");
    group.className = "wb-approval-segment";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const [setting, word] of [["follow", "Follow default"], ["on", "On"], ["off", "Off"]]) {
      const button = doc.createElement("button");
      button.type = "button";
      button.disabled = disabled;
      button.textContent = word;
      button.dataset.wbTest = `${testPrefix}-${setting}`;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(value === setting));
      if (value === setting) {
        const mark = doc.createElement("span");
        mark.textContent = "\u2713";
        mark.setAttribute("aria-hidden", "true");
        button.append(mark);
      }
      button.addEventListener("click", () => {
        if (!disabled && !button.disabled && current() === true) void onChange(setting);
      });
      group.append(button);
    }
    return group;
  }
  var init_approval_segment = __esm({
    "src/renderer/web-shared/approval-segment.mjs"() {
      init_globals();
    }
  });

  // src/renderer/web-agents/view.js
  var view_exports = {};
  __export(view_exports, {
    DISCLOSURE: () => DISCLOSURE,
    ROOM_PROGRAMS: () => ROOM_PROGRAMS,
    ROOM_RULE: () => ROOM_RULE,
    TERMINAL_ONLY: () => TERMINAL_ONLY,
    openAgentDialog: () => openAgentDialog
  });
  function openAgentDialog(api, { document: document2 = globalThis.document, onAdded = () => {
  }, onClose = () => {
  }, forRoom = false } = {}) {
    const el = (tag, text3) => {
      const n = document2.createElement(tag);
      if (text3 !== void 0) n.textContent = text3;
      return n;
    };
    const node = el("dialog");
    node.className = "wb-agent-dialog";
    node.dataset.wbTest = "add-agent";
    const title = el("h2", "Add an agent");
    title.id = "wb-agent-title";
    node.setAttribute("aria-labelledby", title.id);
    node.append(title);
    const field = (label, input) => {
      const wrap = el("label");
      wrap.className = "wb-agent-field";
      wrap.append(el("span", label), input);
      node.append(wrap);
    };
    const program = el("select");
    program.setAttribute("aria-label", "Program");
    field("Program", program);
    const programNote = el("p");
    programNote.className = "wb-agent-help";
    programNote.dataset.wbTest = "agent-program-note";
    programNote.hidden = true;
    node.append(programNote);
    const name2 = el("input");
    name2.maxLength = 60;
    name2.setAttribute("aria-label", "Name");
    field("Name", name2);
    const folderRow = el("div");
    folderRow.className = "wb-agent-folder";
    const folder = el("input");
    folder.readOnly = true;
    folder.placeholder = "Home folder";
    folder.setAttribute("aria-label", "Folder on this server");
    const choose = el("button", "Choose folder\u2026");
    choose.type = "button";
    folderRow.append(folder, choose);
    field("Folder on this server", folderRow);
    const group = el("fieldset"), legend = el("legend", "Auto-approve"), choices = el("div");
    group.append(legend, choices);
    node.append(group);
    const hint = el("p"), authority = el("p", "Only you can change this. Agents can't. A change applies the next time the agent starts.");
    authority.className = "wb-agent-help";
    node.append(hint, authority);
    const error2 = el("p");
    error2.setAttribute("role", "alert");
    node.append(error2);
    const retry = el("button", "Try again");
    retry.type = "button";
    retry.hidden = true;
    node.append(retry);
    const check = el("button", "Check the list");
    check.type = "button";
    check.hidden = true;
    node.append(check);
    const list = el("p");
    list.setAttribute("role", "status");
    node.append(list);
    const actions = el("div");
    actions.className = "wb-agent-actions";
    const cancel = el("button", "Cancel"), save = el("button", "Add agent");
    cancel.type = save.type = "button";
    actions.append(cancel, save);
    node.append(actions);
    let closed = false, disclosure = null, programKey = "", segmentKey = "", noticeVersion = 0;
    const previousFocus = document2.activeElement;
    const words2 = { load: "Couldn't load the agent settings. Try again.", name: "Give the agent a name.", folder: "Folder not found on this server. Choose another folder.", disclosure: "Read the notice before you turn this on.", unconfirmed: "Lost the connection while adding this agent. It may have been added. Check the list before you add it again." };
    const current = () => {
      try {
        return !closed && node.isConnected && node.open && !node.closest("[hidden]") && (typeof api.current !== "function" || api.current() === true);
      } catch {
        return false;
      }
    };
    const model = createAgentModel(api, { onState: render });
    function finish() {
      if (closed) return;
      closed = true;
      disclosure?.close(false);
      model.dispose();
      node.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      onClose();
    }
    function confirmOn() {
      return new Promise((resolve) => {
        const prompt = el("dialog");
        prompt.className = "wb-agent-dialog";
        const heading = el("h2", "Let agents run without asking?");
        heading.id = "wb-agent-disclosure";
        prompt.setAttribute("aria-labelledby", heading.id);
        prompt.append(heading, ...DISCLOSURE.map((text3) => el("p", text3)));
        const controls = el("div");
        controls.className = "wb-agent-actions";
        const no = el("button", "Keep it off"), yes = el("button", "Turn on");
        no.type = yes.type = "button";
        controls.append(no, yes);
        prompt.append(controls);
        let done = false;
        const close = (value) => {
          if (done) return;
          done = true;
          prompt.remove();
          disclosure = null;
          resolve(value);
        };
        disclosure = { close };
        no.addEventListener("click", () => close(false));
        yes.addEventListener("click", () => close(true));
        prompt.addEventListener("cancel", (event) => {
          event.preventDefault();
          close(false);
        });
        document2.body.append(prompt);
        prompt.showModal();
        no.focus();
      });
    }
    async function changeChoice(value) {
      if (!current()) return;
      const before = model.state();
      if (!model.set("choice", value)) return;
      if (value === "on" && before.policy?.autoApproveDisclosedAt === null) {
        const accepted = await confirmOn();
        if (!current()) return;
        if (accepted) model.acknowledge(true);
        else model.set("choice", before.choice);
      }
    }
    function render(st) {
      if (closed) return;
      const ready = st.phase === "ready";
      node.dataset.state = st.phase;
      const offered = forRoom ? st.programs.filter((p) => ROOM_PROGRAMS.includes(p.id)) : st.programs;
      if (forRoom && ready && !ROOM_PROGRAMS.includes(st.programId) && offered.length) model.set("programId", offered[0].id);
      programNote.textContent = forRoom ? ROOM_RULE : st.programId && !ROOM_PROGRAMS.includes(st.programId) ? TERMINAL_ONLY : "";
      programNote.hidden = !programNote.textContent;
      const key = JSON.stringify(offered);
      if (key !== programKey) {
        programKey = key;
        program.replaceChildren(...offered.map((p) => {
          const option = el("option", p.label);
          option.value = p.id;
          return option;
        }));
      }
      if (document2.activeElement !== name2) name2.value = st.name;
      program.value = st.programId;
      folder.value = st.folder;
      program.disabled = !ready;
      name2.disabled = !ready;
      choose.disabled = !ready || st.picking;
      cancel.disabled = st.phase === "saving";
      cancel.textContent = st.phase === "unconfirmed" ? "Close" : "Cancel";
      retry.hidden = st.error !== "load";
      check.hidden = st.phase !== "unconfirmed";
      const selectionKey = st.choice + ":" + !ready;
      if (segmentKey !== selectionKey) {
        const focus = choices.contains(document2.activeElement) ? document2.activeElement?.dataset?.wbTest : null;
        const segment3 = createApprovalSegment({ document: document2, value: st.choice, label: "Auto-approve", disabled: !ready, onChange: changeChoice, current, testPrefix: "web-agent-approval" });
        choices.replaceChildren(segment3);
        segmentKey = selectionKey;
        if (focus) {
          const button = [...segment3.children].find((n) => n.dataset.wbTest === focus);
          button?.focus();
        }
      }
      save.disabled = !ready || st.picking || !st.name.trim() || st.choice === "on" && st.policy?.autoApproveDisclosedAt === null && !st.acknowledged;
      hint.textContent = !st.policy ? "Checking the default\u2026" : st.choice === "follow" ? st.policy.default === "on" ? "The default is On, so this agent will run without asking. Choose Off to make it ask." : "The default is Off, so this agent will ask before it acts." : st.choice === "on" ? "This agent will run without asking." : "This agent will ask before it acts.";
      error2.textContent = st.error === "server-answer" ? st.answer.text : st.error ? words2[st.error] : "";
      error2.hidden = !st.error;
      if (st.error === "server-answer" && st.answer.action === "show-disclosure" && noticeVersion !== st.answerVersion && !disclosure && current()) {
        noticeVersion = st.answerVersion;
        void confirmOn().then((accepted) => {
          if (current() && accepted) model.acknowledge(true);
        });
      }
      if (st.phase === "saved") {
        onAdded({ id: st.savedId });
        finish();
      }
    }
    retry.addEventListener("click", () => model.load());
    check.addEventListener("click", async () => {
      check.disabled = true;
      try {
        const rows = await api.list();
        if (!closed) list.textContent = Array.isArray(rows) ? "Recipes: " + rows.slice(0, 200).map((r) => String(r.name || "").slice(0, 60)).join(", ") : "Couldn't read the recipe list. Try again.";
      } catch {
        if (!closed) list.textContent = "Couldn't read the recipe list. Try again.";
      } finally {
        if (!closed) check.disabled = false;
      }
    });
    name2.addEventListener("input", () => model.set("name", name2.value));
    program.addEventListener("change", () => model.set("programId", program.value));
    choose.addEventListener("click", () => model.pickFolder());
    save.addEventListener("click", () => model.save());
    cancel.addEventListener("click", finish);
    node.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (model.state().phase !== "saving") finish();
    });
    document2.body.append(node);
    node.showModal();
    void model.load();
    return Object.freeze({ dispose: finish, model, focus: () => name2.focus() });
  }
  var DISCLOSURE, ROOM_RULE, TERMINAL_ONLY, ROOM_PROGRAMS;
  var init_view = __esm({
    "src/renderer/web-agents/view.js"() {
      init_globals();
      init_model();
      init_approval_segment();
      DISCLOSURE = Object.freeze([
        "With this on, new agents start in their program's mode that skips permission questions. They can run commands and change files on this server without asking you.",
        "Any agent in a room can cause that, including from a message another agent sends. Turn it on only for work you would let them do unattended.",
        "You can turn it off at any time, and set it for each agent separately."
      ]);
      ROOM_RULE = "Claude Code and Codex can join a room. Gemini opens as a terminal.";
      TERMINAL_ONLY = "Opens as a terminal. It can't join a room.";
      ROOM_PROGRAMS = ["claude-code", "codex-cli"];
    }
  });

  // web/lib/server-answers.js
  var require_server_answers = __commonJS({
    "web/lib/server-answers.js"(exports, module) {
      "use strict";
      init_globals();
      var CATCH_ALL = "The server couldn't do that. Try again.";
      var CALLS = [
        "setup.folder",
        // first-login default folder refused (not a full path / not on this server / outside the allowed places)
        "trust.folder",
        // trust a folder
        "person-only",
        // a person-only route that did not see the person signed in (403)
        "auto-approve",
        // turning auto-approve On without the notice having been read (400)
        "signin.start",
        // opening a program's sign-in terminal
        "agent.status",
        // installed / sign-in status of a program (null is a status, not an error)
        "note.save",
        // a room note saved against a changed or deleted note (412)
        "upload",
        // a file too large (413)
        "plugin.upload",
        // a plugin zip too large (413)
        "module.budget",
        // a plugin made too many requests (429)
        "send.file",
        // sending a message with a picture or file (the room file store is not set up on this server: 503)
        "generic"
        // anything else that has no place of its own yet
      ];
      function fill(template, values) {
        return String(template).replace(/\{(\w+)\}/g, (_, key) => {
          if (!values || values[key] === void 0 || values[key] === null || values[key] === "") throw new Error("server-answers: missing " + key);
          return String(values[key]);
        });
      }
      var ROWS = [
        // a builder: the catch-all lives in CATCH_ALL (no row; reaching it is a defect in a test)
        // a builder: setup folder x3, folder-trust 400, person-only 403, auto-approve-without-notice 400, sign-in could-not-start, agent status null
        {
          id: "setup.absolute",
          call: "setup.folder",
          match: (a) => a.status === 400 && a.field === "defaultFolder" && a.reason === "an absolute folder",
          say: () => "That isn't a full folder path. Choose a folder from the list.",
          samples: [{ status: 400, field: "defaultFolder", reason: "an absolute folder" }]
        },
        {
          id: "setup.missing",
          call: "setup.folder",
          match: (a) => a.status === 400 && a.field === "defaultFolder" && a.reason === "that folder does not exist",
          say: () => "That folder doesn't exist on this server. Choose another.",
          samples: [{ status: 400, field: "defaultFolder", reason: "that folder does not exist" }]
        },
        {
          id: "setup.outside",
          call: "setup.folder",
          match: (a) => a.status === 403 && a.field === "defaultFolder" && a.reason === "outside-root",
          say: () => "That folder is outside the places this server lets you use. Choose another.",
          samples: [{ status: 403, field: "defaultFolder", reason: "outside-root" }]
        },
        {
          id: "trust.missing",
          call: "trust.folder",
          match: (a) => a.status === 400 && a.field === "path" && a.reason === "that folder does not exist",
          say: () => "That folder can't be trusted: it doesn't exist on this server. Choose it from the list.",
          samples: [{ status: 400, field: "path", reason: "that folder does not exist" }]
        },
        {
          id: "person.required",
          call: "person-only",
          match: (a) => a.status === 403 && a.reason === "person_only",
          say: () => "Only you can do this, and the server didn't see you signed in. Sign in again, then try again.",
          samples: [{ status: 403, reason: "person_only" }]
        },
        {
          id: "approval.disclosure",
          call: "auto-approve",
          action: "show-disclosure",
          match: (a) => a.status === 400 && ["disclosed", "autoApprove"].includes(a.field) && a.reason === "disclosure-required",
          say: () => "Read the notice before you turn this on.",
          samples: ["disclosed", "autoApprove"].map((field) => ({ status: 400, field, reason: "disclosure-required" }))
        },
        {
          id: "signin.prepare",
          call: "signin.start",
          match: (a) => a.status === 502 && a.reason === "could not prepare the sign-in terminal" && ["Claude Code", "Codex", "Gemini CLI"].includes(a.program),
          say: (a) => fill("Couldn't open sign-in for {program}. Try again.", a),
          samples: ["Claude Code", "Codex", "Gemini CLI"].map((program) => ({ status: 502, reason: "could not prepare the sign-in terminal", program }))
        },
        {
          id: "agent.unknown",
          call: "agent.status",
          match: (a) => a.status === 200 && a.installed === null,
          say: () => "Can't check. Open a sign-in terminal to see.",
          samples: [{ status: 200, installed: null }]
        },
        // a builder: note 412 changed, note 412 deleted, upload 413 ({name} is {size}. The limit is {limit}.)
        {
          id: "note.save.changed",
          call: "note.save",
          match: (a) => a.status === 412 && a.reason === "changed",
          say: () => "This note changed on the server. Your draft is still here. Reload the saved note to replace your draft.",
          samples: [{ status: 412, reason: "changed" }]
        },
        {
          id: "note.save.deleted",
          call: "note.save",
          match: (a) => a.status === 412 && (a.reason === "deleted" || a.reason === "gone"),
          say: () => "This note was deleted on the server. Your draft is still here. Save it as a new note, or close it.",
          samples: [{ status: 412, reason: "deleted" }, { status: 412, reason: "gone" }]
        },
        {
          id: "note.new.name-exists",
          call: "note.save",
          match: (a) => a.status === 200 && a.reason === "new-name-exists",
          say: () => "A note with that name already exists. Choose a different name.",
          samples: [{ status: 200, reason: "new-name-exists" }]
        },
        {
          id: "note.new.changed",
          call: "note.save",
          match: (a) => a.status === 200 && a.reason === "new-changed",
          say: () => "The new note was changed on the server while it was being saved. Your draft is still here. Check the list before you try again.",
          samples: [{ status: 200, reason: "new-changed" }]
        },
        {
          id: "upload.too-large",
          call: "upload",
          match: (a) => a.status === 413,
          say: (a) => fill("{name} is {size}. The limit is {limit}.", a),
          samples: [{ status: 413, name: "report.pdf", size: "63 MB", limit: "50 MB" }]
        },
        // a builder: plugin upload 413, module budget 429 (the design, web screens section 5)
        {
          id: "plugin.too-big",
          call: "plugin.upload",
          match: (a) => a.status === 413,
          say: (a) => fill("Can't install {file}. The limit is 20 MB zipped and 50 MB unpacked.", a),
          samples: [{ status: 413, file: "notes-plus.zip" }]
        },
        {
          id: "module.too-many-requests",
          call: "module.budget",
          match: (a) => a.status === 429,
          say: () => "This tool has made too many requests. Wait a moment, then try again.",
          samples: [{ status: 429 }, { status: 429, kind: "slow" }]
        },
        // a builder: a picture cannot be sent because the server has no room file store (the design walk; the engine's text is for the operator)
        {
          id: "send.store-missing",
          call: "send.file",
          match: (a) => a.status === 503,
          // the fixed code file-store-missing, or the old operator text from a non-hosted engine: any 503 on a file send
          say: () => "Pictures can't be sent on this server yet. Whoever runs it needs to set up the file store.",
          samples: [{ status: 503, reason: "file-store-missing", field: "file-store" }, { status: 503, reason: "the room file store is not set up" }, { status: 503 }]
        }
      ];
      var unmapped = 0;
      function resetUnmapped() {
        unmapped = 0;
      }
      function unmappedCount() {
        return unmapped;
      }
      function assertNoUnmapped() {
        if (unmapped > 0) throw new Error("server-answers: " + unmapped + " engine answer(s) reached the catch-all; add a row for each");
      }
      function sayServerAnswer(call, answer2) {
        if (!CALLS.includes(call)) throw new Error("server-answers: unknown call " + String(call));
        const a = answer2 || {};
        const row = ROWS.find((r) => r.call === call && r.match(a));
        if (row) return row.say(a);
        unmapped += 1;
        const defects = globalThis.__wbWebDefects;
        if (Array.isArray(defects)) defects.push({ kind: "unmapped-server-answer", channel: call, count: 1, status: Number(a.status) || 0 });
        return CATCH_ALL;
      }
      module.exports = { CATCH_ALL, CALLS, ROWS, fill, sayServerAnswer, unmappedCount, resetUnmapped, assertNoUnmapped };
    }
  });

  // web/handlers/agents.js
  var require_agents = __commonJS({
    "web/handlers/agents.js"(exports, module) {
      "use strict";
      init_globals();
      var { openAgentDialog: openAgentDialog2 } = (init_view(), __toCommonJS(view_exports));
      var { sayServerAnswer, ROWS } = require_server_answers();
      function mapAgentServerAnswer(result) {
        const answer2 = { status: result.status, reason: typeof result.error === "string" ? result.error.slice(0, 160) : "", field: typeof result.field === "string" ? result.field.slice(0, 64) : "" };
        const call = answer2.status === 403 && answer2.reason === "person_only" ? "person-only" : answer2.status === 400 && answer2.reason === "disclosure-required" ? "auto-approve" : "generic";
        const text3 = sayServerAnswer(call, answer2), row = ROWS.find((r) => r.call === call && r.match(answer2));
        return { text: text3, action: row?.action || null };
      }
      function register4(api, { browser = globalThis } = {}) {
        let active = null;
        const web2 = () => browser.wb.web;
        api.expose("agents", Object.freeze({ open(options) {
          if (active) {
            active.focus?.();
            return true;
          }
          const scope = browser.wb.rooms.bind();
          active = openAgentDialog2({
            current: () => scope.current(),
            serverAnswer: mapAgentServerAnswer,
            readApproval: (options2) => web2().settings.readApproval(options2),
            programs: async () => {
              const list = await browser.wb.programsList();
              return web2().capabilities && web2().capabilities.bareShell() === false && Array.isArray(list) ? list.filter((p) => p && p.id !== "shell") : list;
            },
            // a hosted engine opens no bare shell
            list: () => browser.wb.recipesList(),
            chooseFolder: (options2) => web2().files.chooseFolder(options2),
            checkFolder: async (path, options2) => {
              const result = await web2().files.directoryLoader()(path, options2);
              return result?.ok === true;
            },
            save: (payload) => browser.wb.recipesSave(payload)
          }, { document: browser.document, forRoom: options?.forRoom === true, onClose: () => {
            active = null;
          } });
          return true;
        } }));
        const hide = () => {
          active?.dispose();
          active = null;
        };
        browser.addEventListener("pagehide", hide);
        return () => {
          hide();
          browser.removeEventListener("pagehide", hide);
        };
      }
      module.exports = { register: register4, mapAgentServerAnswer };
    }
  });

  // src/renderer/web/browser-actions.js
  var browser_actions_exports = {};
  __export(browser_actions_exports, {
    BrowserActionError: () => BrowserActionError,
    createBrowserActions: () => createBrowserActions
  });
  function createBrowserActions(browser = window) {
    let alive = true;
    const notifications = /* @__PURE__ */ new Set();
    const fail2 = (code) => {
      throw new BrowserActionError(code);
    };
    function current() {
      if (!alive) fail2("disposed");
    }
    function secure() {
      current();
      if (browser.isSecureContext !== true) fail2("secure-context-required");
    }
    function gesture() {
      current();
      if (browser.navigator?.userActivation?.isActive !== true) fail2("user-gesture-required");
    }
    function clipboard(method) {
      secure();
      gesture();
      if (typeof browser.navigator?.clipboard?.[method] !== "function") fail2("clipboard-unavailable");
      return browser.navigator.clipboard;
    }
    function webUrl(value, internal) {
      current();
      if (typeof value !== "string" || value.length > 4096) fail2("unsafe-url");
      let url, origin;
      try {
        url = new URL(value, browser.location.href);
        origin = new URL(browser.location.href).origin;
      } catch {
        fail2("unsafe-url");
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || internal && url.origin !== origin) fail2("unsafe-url");
      return url.href;
    }
    function open(value, internal) {
      const url = webUrl(value, internal);
      gesture();
      if (typeof browser.open !== "function") fail2("popup-unavailable");
      const child = browser.open("about:blank", "_blank");
      if (!child) fail2("popup-blocked");
      try {
        child.opener = null;
        if (child.opener !== null) throw new Error();
        const referrer = child.document.createElement("meta");
        referrer.name = "referrer";
        referrer.content = "no-referrer";
        child.document.head.append(referrer);
        child.location.replace(url);
        return true;
      } catch {
        try {
          child.close();
        } catch {
        }
        fail2("popup-unavailable");
      }
    }
    function notificationStatus() {
      current();
      if (browser.isSecureContext !== true || typeof browser.Notification !== "function") return "unavailable";
      const status = browser.Notification.permission;
      return ["default", "granted", "denied"].includes(status) ? status : "unavailable";
    }
    return Object.freeze({
      async copyText(text3) {
        const clip = clipboard("writeText");
        if (typeof text3 !== "string") fail2("clipboard-invalid");
        if (text3.length > MAX_CLIPBOARD) fail2("clipboard-too-large");
        try {
          await clip.writeText(text3);
        } catch {
          fail2("clipboard-denied");
        }
        current();
        return true;
      },
      async readText() {
        const clip = clipboard("readText");
        let text3;
        try {
          text3 = await clip.readText();
        } catch {
          fail2("clipboard-denied");
        }
        current();
        if (typeof text3 !== "string") fail2("clipboard-invalid");
        if (text3.length > MAX_CLIPBOARD) fail2("clipboard-too-large");
        return text3;
      },
      openTab: (url) => open(url, true),
      openExternal: (url) => open(url, false),
      notificationStatus,
      async requestNotifications() {
        secure();
        const status = notificationStatus();
        if (status === "unavailable") fail2("notifications-unavailable");
        if (status !== "default") return status;
        gesture();
        let next;
        try {
          next = await browser.Notification.requestPermission();
        } catch {
          fail2("notification-denied");
        }
        current();
        return ["default", "granted", "denied"].includes(next) ? next : "unavailable";
      },
      notify(title, { body = "", tag = "", onClick, silent = true } = {}) {
        secure();
        if (notificationStatus() !== "granted") fail2("notification-permission");
        if (typeof title !== "string" || !title || title.length > 200 || typeof body !== "string" || body.length > 500 || typeof tag !== "string" || tag.length > 80) fail2("notification-invalid");
        let note;
        try {
          note = new browser.Notification(title, { body, tag, silent: silent !== false });
        } catch {
          fail2("notifications-unavailable");
        }
        notifications.add(note);
        note.onclick = () => {
          if (alive && typeof onClick === "function") onClick();
        };
        note.onclose = () => notifications.delete(note);
        return true;
      },
      dispose() {
        if (!alive) return;
        alive = false;
        for (const note of notifications) {
          try {
            note.close();
          } catch {
          }
        }
        notifications.clear();
      }
    });
  }
  var BrowserActionError, MAX_CLIPBOARD;
  var init_browser_actions = __esm({
    "src/renderer/web/browser-actions.js"() {
      init_globals();
      BrowserActionError = class extends Error {
        constructor(code) {
          super(code);
          this.name = "BrowserActionError";
          this.code = code;
        }
      };
      MAX_CLIPBOARD = 1e5;
    }
  });

  // src/renderer/web-browser-feedback/words.js
  function browserActionMessage(code, action, { mac = false } = {}) {
    if (!Object.hasOwn(BROWSER_ACTION_WORDS, code) || !Object.hasOwn(BROWSER_ACTION_WORDS[code], action)) throw Error("Unmapped browser action refusal");
    const sentence = BROWSER_ACTION_WORDS[code][action];
    return mac ? sentence.replace("Ctrl+C", "Cmd+C").replace("Ctrl+V", "Cmd+V") : sentence;
  }
  var COPY, PASTE, LINK, BLOCKED, NOTIFY, HTTPS, copy2, BROWSER_ACTION_WORDS;
  var init_words = __esm({
    "src/renderer/web-browser-feedback/words.js"() {
      init_globals();
      COPY = "Couldn't copy automatically. The text is selected: press Ctrl+C.";
      PASTE = "Your browser didn't allow pasting here. Click in the terminal and press Ctrl+V.";
      LINK = "Couldn't open that link.";
      BLOCKED = "Your browser blocked the new tab. Allow pop-ups for this site, then try again.";
      NOTIFY = "Notifications are blocked for this site. Allow them in your browser's site settings, then reload.";
      HTTPS = "Notifications need a secure (https) address, and this one isn't. They can't be turned on here.";
      copy2 = Object.freeze({ copy: COPY, paste: PASTE, open: LINK, notify: NOTIFY });
      BROWSER_ACTION_WORDS = Object.freeze({
        "clipboard-denied": copy2,
        "clipboard-invalid": copy2,
        "clipboard-too-large": Object.freeze({ ...copy2, copy: "That's too much text to copy at once. Select a smaller part." }),
        "clipboard-unavailable": copy2,
        "disposed": copy2,
        "notification-denied": copy2,
        "notification-invalid": copy2,
        "notification-permission": copy2,
        "notifications-unavailable": copy2,
        "popup-blocked": Object.freeze({ ...copy2, open: BLOCKED }),
        "popup-unavailable": Object.freeze({ ...copy2, open: BLOCKED }),
        "secure-context-required": Object.freeze({ ...copy2, notify: HTTPS }),
        "unsafe-url": copy2,
        "user-gesture-required": Object.freeze({ ...copy2, open: BLOCKED })
      });
    }
  });

  // src/renderer/web-browser-feedback/view.js
  var view_exports2 = {};
  __export(view_exports2, {
    createBrowserFeedback: () => createBrowserFeedback
  });
  function createBrowserFeedback(browser = window) {
    let dialog = null, notice = null, disposed = false;
    const mac = /Mac|iPhone|iPad/.test(browser.navigator?.platform || browser.navigator?.userAgent || "");
    const el = (tag, cls, text3) => {
      const n = browser.document.createElement(tag);
      n.className = cls;
      if (text3 !== void 0) n.textContent = text3;
      return n;
    };
    function clearDialog() {
      if (!dialog) return;
      const old = dialog;
      dialog = null;
      old.input.value = "";
      old.node.remove();
      if (old.focus?.isConnected) old.focus.focus();
    }
    function showNotice(text3) {
      if (disposed) return;
      notice?.remove();
      const box = el("div", "wb-browser-notice"), line = el("p", "", text3), close = el("button", "", "Close");
      line.setAttribute("role", "status");
      close.type = "button";
      close.addEventListener("click", () => {
        box.remove();
        if (notice === box) notice = null;
      });
      box.append(line, close);
      browser.document.body.append(box);
      notice = box;
    }
    function copyFallback(text3, sentence) {
      clearDialog();
      const focus = browser.document.activeElement, node = el("dialog", "wb-browser-copy"), title = el("h2", "", "Copy"), input = el("textarea", ""), line = el("p", "", sentence), close = el("button", "", "Close");
      title.id = "wb-browser-copy-title";
      node.setAttribute("aria-labelledby", title.id);
      input.setAttribute("aria-label", "Text to copy");
      input.readOnly = true;
      input.rows = 6;
      input.value = text3;
      close.type = "button";
      line.setAttribute("role", "status");
      node.append(title, input, line, close);
      dialog = { node, input, focus };
      close.addEventListener("click", clearDialog);
      node.addEventListener("close", clearDialog);
      node.addEventListener("cancel", clearDialog);
      browser.document.body.append(node);
      node.showModal();
      input.focus();
      input.select();
    }
    return Object.freeze({
      show(code, action, { text: text3 } = {}) {
        if (disposed || code === "disposed") return;
        if (action === "copy" && typeof text3 !== "string") return;
        const sentence = browserActionMessage(code, action, { mac });
        if (action === "copy" && code !== "clipboard-too-large" && typeof text3 === "string" && text3.length <= 1e5) copyFallback(text3, sentence);
        else showNotice(sentence);
      },
      dispose() {
        disposed = true;
        clearDialog();
        notice?.remove();
        notice = null;
      }
    });
  }
  var init_view2 = __esm({
    "src/renderer/web-browser-feedback/view.js"() {
      init_globals();
      init_words();
    }
  });

  // web/handlers/browser-actions.js
  var require_browser_actions = __commonJS({
    "web/handlers/browser-actions.js"(exports, module) {
      "use strict";
      init_globals();
      var { createBrowserActions: createBrowserActions2 } = (init_browser_actions(), __toCommonJS(browser_actions_exports));
      var { createBrowserFeedback: createBrowserFeedback2 } = (init_view2(), __toCommonJS(view_exports2));
      function register4(api, { browser = globalThis, makeFeedback = createBrowserFeedback2 } = {}) {
        let actions = createBrowserActions2(browser), feedback = makeFeedback(browser), disposed = false;
        const methods = {};
        const operation = { copyText: "copy", readText: "paste", openTab: "open", openExternal: "open", requestNotifications: "notify" };
        for (const [name2, action] of Object.entries(operation)) {
          methods[name2] = (...args) => {
            const refused2 = (error2) => {
              feedback.show(error2.code, action, { text: args[0] });
              throw error2;
            };
            try {
              const result = actions[name2](...args);
              if (result && typeof result.then === "function") return result.then((value) => {
                if (name2 === "requestNotifications" && value === "denied") feedback.show("notification-permission", "notify");
                return value;
              }, refused2);
              return result;
            } catch (error2) {
              return refused2(error2);
            }
          };
        }
        methods.notificationStatus = () => actions.notificationStatus();
        methods.notifyNeedsYou = ({ room, seat, tag = "", onClick } = {}) => {
          try {
            if (typeof room !== "string" || !room || room.length > 120 || /[\u0000-\u001f]/.test(room) || typeof seat !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(seat)) throw Object.assign(new Error("notification-invalid"), { code: "notification-invalid" });
            return actions.notify(room + " needs you", { body: "@" + seat + " is waiting for your OK.", tag, onClick });
          } catch (error2) {
            feedback.show(error2.code, "notify");
            throw error2;
          }
        };
        api.expose("browserActions", Object.freeze(methods));
        api.handle("clipboard:write", async ([text3]) => {
          try {
            return await methods.copyText(text3);
          } catch {
            return false;
          }
        });
        api.handle("shell:open-external", ([url]) => {
          try {
            return methods.openExternal(url);
          } catch {
            return false;
          }
        });
        const hide = () => {
          actions.dispose();
          feedback.dispose();
        };
        const show = (event) => {
          if (!disposed && event.persisted) {
            actions = createBrowserActions2(browser);
            feedback = makeFeedback(browser);
          }
        };
        browser.addEventListener("pagehide", hide);
        browser.addEventListener("pageshow", show);
        return () => {
          disposed = true;
          actions.dispose();
          feedback.dispose();
          browser.removeEventListener("pagehide", hide);
          browser.removeEventListener("pageshow", show);
        };
      }
      module.exports = { register: register4 };
    }
  });

  // src/renderer/web-setup/policy.mjs
  var modes, settings, text, serverFolder;
  var init_policy = __esm({
    "src/renderer/web-setup/policy.mjs"() {
      init_globals();
      modes = /* @__PURE__ */ new Set(["on", "off"]);
      settings = /* @__PURE__ */ new Set(["follow", ...modes]);
      text = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
      serverFolder = (value) => text(value) && value.startsWith("/") && !value.split("/").some((part) => part === "." || part === "..");
    }
  });

  // web/handlers/setup-settings.mjs
  var setup_settings_exports = {};
  __export(setup_settings_exports, {
    createSettingsAPI: () => createSettingsAPI,
    register: () => register
  });
  function createSettingsAPI(fetch, { timeoutMs = 15e3, maxBytes = 1024 * 1024 } = {}) {
    if (typeof fetch !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) invalid();
    async function request(path, method, body, { signal, current } = {}) {
      if (signal?.aborted || current && current() !== true) throw unknown();
      const abort = new AbortController();
      let timer, reader;
      const cancel = () => abort.abort();
      const interrupted = new Promise((_, reject) => abort.signal.addEventListener("abort", () => {
        if (reader) void reader.cancel().catch(() => {
        });
        reject(unknown());
      }, { once: true }));
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(cancel, timeoutMs);
      try {
        return await Promise.race([interrupted, (async () => {
          let response;
          try {
            response = await fetch(path, {
              method,
              credentials: "same-origin",
              redirect: "error",
              cache: "no-store",
              signal: abort.signal,
              headers: { accept: "application/json", ...body === void 0 ? {} : { "content-type": "application/json" } },
              ...body === void 0 ? {} : { body: JSON.stringify(body) }
            });
          } catch {
            throw unknown();
          }
          if (abort.signal.aborted) {
            void response.body?.cancel().catch(() => {
            });
            throw unknown();
          }
          const length = response.headers.get("content-length");
          if (length !== null && Number(length) > maxBytes) {
            void response.body?.cancel().catch(() => {
            });
            throw unknown();
          }
          if (!response.body?.getReader) throw unknown();
          reader = response.body.getReader();
          let size = 0, text3 = "";
          const decoder = new TextDecoder("utf-8", { fatal: true });
          try {
            for (; ; ) {
              const { done, value } = await reader.read();
              if (abort.signal.aborted) throw unknown();
              if (done) break;
              size += value.byteLength;
              if (size > maxBytes) {
                void reader.cancel().catch(() => {
                });
                throw unknown();
              }
              text3 += decoder.decode(value, { stream: true });
            }
            text3 += decoder.decode();
          } catch {
            throw unknown();
          }
          let data;
          try {
            data = JSON.parse(text3);
          } catch {
            throw unknown();
          }
          if (refusalStatuses.has(response.status) && data && typeof data.error === "string") {
            throw { code: "settings-refused", status: response.status };
          }
          if (!response.ok) throw unknown();
          return data;
        })()]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    }
    return Object.freeze({
      readSetup: (options) => request("/api/settings/setup", "GET", void 0, options),
      readPersonDisplay: (options) => request("/api/rooms/me", "GET", void 0, options),
      readAgents: (options) => request("/api/agents/status", "GET", void 0, options),
      async writeSetup(input, options) {
        if (!input || typeof input !== "object") invalid();
        const body = {};
        if ("defaultFolder" in input) {
          if (input.defaultFolder !== null && !serverFolder(input.defaultFolder)) invalid();
          body.defaultFolder = input.defaultFolder;
        }
        if ("complete" in input) {
          if (input.complete !== true) invalid();
          body.complete = true;
        }
        if (!Object.keys(body).length) invalid();
        return request("/api/settings/setup", "PUT", body, options);
      },
      async prepareAgentSignIn(vendor, options) {
        if (!["claude-code", "codex-cli", "gemini-cli"].includes(vendor)) invalid();
        return request(`/api/agents/${vendor}/sign-in`, "POST", {}, options);
      },
      readApproval: (options) => request("/api/settings/auto-approve", "GET", void 0, options),
      async writeApproval(input, options) {
        if (!input || !["on", "off"].includes(input.default) || input.disclosed !== void 0 && input.disclosed !== true) invalid();
        const body = { default: input.default, ...input.disclosed === true ? { disclosed: true } : {} };
        return request("/api/settings/auto-approve", "PUT", body, options);
      },
      readTrust: (options) => request("/api/settings/folder-trust", "GET", void 0, options),
      async writeTrust(input, options) {
        if (!input || !serverFolder(input.path) || typeof input.trusted !== "boolean") invalid();
        return request("/api/settings/folder-trust", "PUT", { path: input.path, trusted: input.trusted }, options);
      }
    });
  }
  function register(api) {
    api.expose("settings", createSettingsAPI((path, init) => api.engine.fetch(path, init)));
  }
  var refusalStatuses, unknown, invalid;
  var init_setup_settings = __esm({
    "web/handlers/setup-settings.mjs"() {
      init_globals();
      init_policy();
      refusalStatuses = /* @__PURE__ */ new Set([400, 401, 403, 404, 409, 413, 422]);
      unknown = () => ({ code: "settings-unconfirmed" });
      invalid = () => {
        throw { code: "settings-invalid" };
      };
    }
  });

  // web/handlers/capabilities.mjs
  var capabilities_exports = {};
  __export(capabilities_exports, {
    createCapabilities: () => createCapabilities,
    register: () => register2
  });
  function createCapabilities(read) {
    let bare = true;
    const listeners = /* @__PURE__ */ new Set();
    const verdict = (setup) => !(setup && typeof setup === "object" && (setup.hosted === true || setup.bareShell === false));
    async function refresh() {
      let next = bare;
      try {
        next = verdict(await read());
      } catch {
      }
      if (next !== bare) {
        bare = next;
        for (const fn of [...listeners]) {
          try {
            fn(bare);
          } catch {
          }
        }
      }
      return bare;
    }
    return Object.freeze({
      /** false only when the engine said so (hosted, or bareShell false). */
      bareShell: () => bare,
      refresh,
      onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    });
  }
  function register2(api) {
    const settings2 = createSettingsAPI((path, init) => api.engine.fetch(path, init));
    api.expose("capabilities", createCapabilities(() => settings2.readSetup()));
  }
  var init_capabilities = __esm({
    "web/handlers/capabilities.mjs"() {
      init_globals();
      init_setup_settings();
    }
  });

  // web/handlers/capabilities.js
  var require_capabilities = __commonJS({
    "web/handlers/capabilities.js"(exports, module) {
      "use strict";
      init_globals();
      module.exports = { register: (init_capabilities(), __toCommonJS(capabilities_exports)).register };
    }
  });

  // src/renderer/web-files/folder-picker-client.js
  var folder_picker_client_exports = {};
  __export(folder_picker_client_exports, {
    createFolderDirectoryCreator: () => createFolderDirectoryCreator,
    createFolderDirectoryLoader: () => createFolderDirectoryLoader
  });
  async function json(response, valid) {
    const reader = response.body?.getReader();
    if (!reader) throw Error("response");
    const chunks = [];
    let size = 0;
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (!valid()) throw Error("changed");
        if (done) break;
        size += value.byteLength;
        if (size > MAX_REPLY_BYTES) throw Error("response");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of chunks) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error2) {
      try {
        await reader.cancel();
      } catch {
      }
      throw error2;
    } finally {
      reader.releaseLock();
    }
  }
  function createFolderDirectoryLoader({ request, current = () => true } = {}) {
    if (typeof request !== "function") throw TypeError("Directory transport required");
    return async function load(directoryId, { signal, hidden = false } = {}) {
      const valid = () => {
        try {
          return !signal?.aborted && current() === true;
        } catch {
          return false;
        }
      };
      if (!valid()) return { ok: false, code: "changed" };
      if (directoryId !== null && !absolute(directoryId)) return { ok: false, code: "unavailable" };
      try {
        const params = new URLSearchParams({ path: directoryId || "", hidden: hidden === true ? "1" : "0" });
        const response = await request("/api/fs/dirs?" + params.toString(), { method: "GET", signal });
        if (!valid()) return { ok: false, code: "changed" };
        if (response.status === 401) return { ok: false, code: "signed-out" };
        const body = await json(response, valid);
        if (!valid()) return { ok: false, code: "changed" };
        if (!response.ok) return { ok: false, code: ["outside-root", "unreadable", "not-found"].includes(body?.error) ? body.error : "unavailable" };
        if (!absolute(body?.path) || !(body.parent === null || absolute(body.parent)) || !Array.isArray(body.entries) || body.entries.length > 500) throw Error("response");
        const seen = /* @__PURE__ */ new Set(), entries = [];
        for (const entry of body.entries) {
          if (!name(entry?.name) || !absolute(entry.path) || seen.has(entry.path)) throw Error("response");
          seen.add(entry.path);
          entries.push({ id: entry.path, name: entry.name });
        }
        return { ok: true, directory: { id: body.path, name: body.path.split("/").filter(Boolean).at(-1) || "/", parentId: body.parent }, entries, ...body.truncated === true ? { limited: true } : {} };
      } catch {
        return { ok: false, code: valid() ? "unavailable" : "changed" };
      }
    };
  }
  function createFolderDirectoryCreator({ request, current = () => true } = {}) {
    if (typeof request !== "function") throw TypeError("Directory transport required");
    return async function createDirectory(path, folderName, { signal } = {}) {
      const valid = () => {
        try {
          return !signal?.aborted && current() === true;
        } catch {
          return false;
        }
      };
      if (!valid()) return { ok: false, code: "changed" };
      if (!absolute(path) || !name(folderName) || /^\.+$/.test(folderName)) return { ok: false, code: "invalid" };
      try {
        const response = await request("/api/fs/dirs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, name: folderName }), signal });
        if (!valid()) return { ok: false, code: "changed" };
        if (!response.ok) return { ok: false, code: { 400: "invalid", 401: "signed-out", 403: "outside-root", 404: "unsupported", 409: "exists" }[response.status] || "unavailable" };
        const body = await json(response, valid);
        if (!valid()) return { ok: false, code: "changed" };
        return absolute(body?.path) ? { ok: true, path: body.path } : { ok: false, code: "unavailable" };
      } catch {
        return { ok: false, code: valid() ? "unavailable" : "changed" };
      }
    };
  }
  var MAX_REPLY_BYTES, absolute, name;
  var init_folder_picker_client = __esm({
    "src/renderer/web-files/folder-picker-client.js"() {
      init_globals();
      MAX_REPLY_BYTES = 4 * 1024 * 1024;
      absolute = (value) => typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) && !value.split("/").some((part) => part === "." || part === "..");
      name = (value) => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(value) && value !== "." && value !== "..";
    }
  });

  // src/renderer/web-files/room-files-client.js
  var room_files_client_exports = {};
  __export(room_files_client_exports, {
    MAX_ROOM_FILE_BYTES: () => MAX_ROOM_FILE_BYTES,
    createRoomFilesClient: () => createRoomFilesClient
  });
  function createRoomFilesClient({ roomId, request, current = () => true, signal } = {}) {
    if (!segment(roomId) || typeof request !== "function" || typeof current !== "function") throw TypeError("Room and request required");
    const room = roomId, base = `/api/rooms/${encodeURIComponent(room)}/files`, pending = /* @__PURE__ */ new Set();
    let destroyed = false;
    const active = () => {
      try {
        return !destroyed && !signal?.aborted && current() === true;
      } catch {
        return false;
      }
    };
    function destroy() {
      destroyed = true;
      signal?.removeEventListener("abort", destroy);
      for (const controller of pending) controller.abort();
      pending.clear();
    }
    signal?.addEventListener("abort", destroy, { once: true });
    const filePath = (dir, rel) => `${base}/${dir}/${rel.split("/").map(encodeURIComponent).join("/")}`;
    function project2(answer2) {
      if (!Array.isArray(answer2?.entries) || answer2.entries.length > MAX_ENTRIES) return null;
      const entries = [], seen = /* @__PURE__ */ new Set();
      for (const entry of answer2.entries) {
        if (!entry || !segment(entry.name) || seen.has(entry.name) || !["file", "dir"].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isFinite(entry.mtime) || entry.mtime < 0 || entry.mtime > 864e13) return null;
        seen.add(entry.name);
        entries.push({ name: entry.name, kind: entry.kind, size: entry.size, mtime: entry.mtime });
      }
      return entries;
    }
    async function boundedBody(response, limit, controller, live = active) {
      if (!response.body) return { parts: [] };
      const reader = response.body.getReader(), parts2 = [];
      let size = 0, finished = false;
      const cancel = () => {
        try {
          reader.cancel().catch(() => {
          });
        } catch {
        }
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          if (!live()) return { error: changed() };
          const { done, value } = await reader.read();
          if (!live()) return { error: changed() };
          if (done) {
            finished = true;
            return { parts: parts2 };
          }
          if (!(value instanceof Uint8Array)) return { error: unavailable() };
          size += value.byteLength;
          if (size > limit) return { error: { ok: false, code: "too-large", limitBytes: limit, sizeBytes: size } };
          parts2.push(value);
        }
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        if (!finished) cancel();
        reader.releaseLock();
      }
    }
    async function send(path, options, read, operationSignal) {
      const uncertain = () => options.method === "POST" || options.method === "PUT" || options.method === "DELETE" ? { ok: false, code: "unconfirmed" } : unavailable();
      const live = () => active() && !operationSignal?.aborted;
      if (!live()) return changed();
      const controller = new AbortController();
      pending.add(controller);
      const abort = () => controller.abort();
      operationSignal?.addEventListener("abort", abort, { once: true });
      try {
        if (!live()) return changed();
        const response = await request(path, { ...options, signal: controller.signal });
        if (!live()) {
          cancelBody(response);
          return changed();
        }
        if (!response?.ok) {
          const status = response?.status;
          let details = null;
          if ([403, 412, 413].includes(status)) {
            try {
              const body = await boundedBody(response, MAX_REPLY_BYTES2, controller, live);
              if (!live()) return changed();
              if (!body.error) details = JSON.parse(await new Blob(body.parts).text());
            } catch {
            }
          } else cancelBody(response);
          if (!live()) return changed();
          const code = { 401: "sign-in", 403: "forbidden", 404: "not-found", 409: "conflict", 412: "conflict", 413: "too-large", 428: "reload-required" }[status] || "unavailable";
          const reason = status === 412 ? details?.error === "gone" ? "deleted" : details?.error === "changed" ? "changed" : "unmapped" : status === 403 && details?.error === "person_only" ? "person-only" : null;
          const limit = Number.isSafeInteger(details?.max) && details.max > 0 ? details.max : MAX_ROOM_FILE_BYTES;
          return { ok: false, code, ...Number.isInteger(status) ? { status } : {}, ...reason ? { reason } : {}, ...status === 413 ? { limitBytes: limit } : {} };
        }
        if (read) {
          const noteRevision = read === "note-read" || read === "revision" ? response.headers.get("etag") : null;
          if ((read === "note-read" || read === "revision") && !revision(noteRevision)) {
            cancelBody(response);
            return live() ? unavailable() : changed();
          }
          if (read === "revision") {
            cancelBody(response);
            return live() ? { ok: true, revision: noteRevision } : changed();
          }
          const limit = read === "list" ? MAX_LIST_BYTES : read === "upload" || read === "note-write" ? MAX_REPLY_BYTES2 : MAX_ROOM_FILE_BYTES;
          const body = await boundedBody(response, limit, controller, live);
          if (!live()) return changed();
          if (body.error) return read === "upload" || read === "note-write" ? uncertain() : body.error;
          if (read === "blob") {
            const baseline = response.headers.get("etag");
            return { ok: true, blob: new Blob(body.parts, { type: response.headers.get("content-type") || "" }), ...revision(baseline) ? { revision: baseline } : {} };
          }
          let text3;
          if (read === "note-read") {
            const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), parts2 = [];
            for (const part of body.parts) parts2.push(decoder.decode(part, { stream: true }));
            parts2.push(decoder.decode());
            text3 = parts2.join("");
            if (text3.includes("\0")) return unavailable();
          } else text3 = await new Blob(body.parts).text();
          if (!live()) return changed();
          if (read === "note-read") return { ok: true, text: text3, revision: noteRevision };
          const answer2 = JSON.parse(text3);
          if (read === "upload" || read === "note-write") {
            if (!metadata(answer2)) return uncertain();
            return read === "upload" ? { ok: true, name: answer2.name } : { ok: true, revision: answer2.etag };
          }
          const entries = project2(answer2);
          return entries ? { ok: true, entries } : unavailable();
        }
        cancelBody(response);
        return { ok: true };
      } catch {
        return live() ? uncertain() : changed();
      } finally {
        pending.delete(controller);
        operationSignal?.removeEventListener("abort", abort);
        if (!live()) controller.abort();
      }
    }
    function bodyError(body) {
      if (!(body instanceof Blob)) return invalid2();
      return body.size > MAX_ROOM_FILE_BYTES ? { ok: false, code: "too-large", limitBytes: MAX_ROOM_FILE_BYTES, sizeBytes: body.size } : null;
    }
    return Object.freeze({
      roomId: room,
      list(dir, sub = "") {
        if (!active()) return Promise.resolve(changed());
        if (!directories.has(dir) || !relative(sub, true)) return Promise.resolve(invalid2());
        return send(`${base}?dir=${dir}&sub=${encodeURIComponent(sub)}`, { method: "GET" }, "list");
      },
      read(dir, rel) {
        if (!active()) return Promise.resolve(changed());
        if (!directories.has(dir) || !relative(rel)) return Promise.resolve(invalid2());
        return send(filePath(dir, rel), { method: "GET" }, "blob");
      },
      readRevision(dir, rel, { signal: operationSignal } = {}) {
        if (!active() || operationSignal?.aborted) return Promise.resolve(changed());
        if (!directories.has(dir) || !relative(rel)) return Promise.resolve(invalid2());
        return send(filePath(dir, rel), { method: "GET" }, "revision", operationSignal);
      },
      readNote(name2, { signal: operationSignal } = {}) {
        if (!active() || operationSignal?.aborted) return Promise.resolve(changed());
        if (!relative(name2)) return Promise.resolve(invalid2());
        return send(filePath("notes", name2), { method: "GET" }, "note-read", operationSignal);
      },
      writeNote(name2, text3, { revision: baseline, signal: operationSignal } = {}) {
        if (!active() || operationSignal?.aborted) return Promise.resolve(changed());
        if (!relative(name2) || typeof text3 !== "string") return Promise.resolve(invalid2());
        if (!revision(baseline)) return Promise.resolve({ ok: false, code: "reload-required" });
        const body = new Blob([text3], { type: "text/plain; charset=utf-8" }), error2 = bodyError(body);
        if (error2) return Promise.resolve(error2);
        return send(filePath("notes", name2), { method: "PUT", body, headers: { "if-match": baseline } }, "note-write", operationSignal);
      },
      write(dir, rel, body, { revision: baseline } = {}) {
        if (!active()) return Promise.resolve(changed());
        if (!directories.has(dir) || !relative(rel)) return Promise.resolve(invalid2());
        const error2 = bodyError(body);
        if (error2) return Promise.resolve(error2);
        if (baseline !== void 0 && !revision(baseline)) return Promise.resolve(invalid2());
        return send(filePath(dir, rel), { method: "PUT", body, headers: baseline === void 0 ? { "if-none-match": "*" } : { "if-match": baseline } });
      },
      upload(dir, body, name2 = body?.name) {
        if (!active()) return Promise.resolve(changed());
        if (!directories.has(dir) || !segment(name2)) return Promise.resolve(invalid2());
        const error2 = bodyError(body);
        if (error2) return Promise.resolve(error2);
        return send(`${base}/${dir}`, { method: "POST", body, headers: { "x-filename": encodeURIComponent(name2) } }, "upload");
      },
      remove(dir, rel, { revision: baseline } = {}) {
        if (!active()) return Promise.resolve(changed());
        if (!directories.has(dir) || !relative(rel)) return Promise.resolve(invalid2());
        if (baseline !== void 0 && !revision(baseline)) return Promise.resolve(invalid2());
        return send(filePath(dir, rel), { method: "DELETE", ...baseline === void 0 ? {} : { headers: { "if-match": baseline } } });
      },
      destroy
    });
  }
  var MAX_ROOM_FILE_BYTES, MAX_LIST_BYTES, MAX_REPLY_BYTES2, MAX_ENTRIES, directories, segment, relative, changed, invalid2, unavailable, revision, metadata, cancelBody;
  var init_room_files_client = __esm({
    "src/renderer/web-files/room-files-client.js"() {
      init_globals();
      MAX_ROOM_FILE_BYTES = 50 * 1024 * 1024;
      MAX_LIST_BYTES = 4 * 1024 * 1024;
      MAX_REPLY_BYTES2 = 16 * 1024;
      MAX_ENTRIES = 1e3;
      directories = /* @__PURE__ */ new Set(["notes", "assets", "files"]);
      segment = (value) => typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f\\/]/.test(value);
      relative = (value, empty2 = false) => typeof value === "string" && value.length <= 4096 && !/^[A-Za-z]:\//.test(value) && (empty2 && value === "" || value.split("/").every(segment));
      changed = () => ({ ok: false, code: "changed" });
      invalid2 = () => ({ ok: false, code: "invalid" });
      unavailable = () => ({ ok: false, code: "unavailable" });
      revision = (value) => typeof value === "string" && value.length <= 4096 && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
      metadata = (value) => !!value && segment(value.name) && Number.isSafeInteger(value.size) && value.size >= 0 && Number.isFinite(value.mtime) && value.mtime >= 0 && value.mtime <= 864e13 && revision(value.etag);
      cancelBody = (response) => {
        try {
          response?.body?.cancel().catch(() => {
          });
        } catch {
        }
      };
    }
  });

  // src/renderer/web-files/folder-picker-model.js
  function createServerFolderPicker({ load, createDirectory, current = () => true, onState = () => {
  } } = {}) {
    if (typeof load !== "function") throw TypeError("Directory loader required");
    let epoch = 0, request = null, destroyed = false, canCreate = typeof createDirectory === "function", createNeedsReload = false;
    const createState = () => ({ canCreate, createOpen: false, createName: "", createError: null, creating: false, createNeedsReload });
    const folderName = (value) => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\\/\u0000-\u001f\u007f]/.test(value) && !/^\.+$/.test(value);
    let state = { open: false, busy: false, directory: null, entries: [], error: null, hidden: false, rootId: null, limited: false, ...createState() };
    const active = () => {
      try {
        return !destroyed && current() === true;
      } catch {
        return false;
      }
    };
    const live = (mine) => active() && state.open && epoch === mine;
    const snapshot = () => ({ ...state, directory: state.directory ? { ...state.directory } : null, entries: state.entries.map((entry) => ({ ...entry })) });
    const publish = () => {
      try {
        onState(snapshot());
      } catch {
      }
    };
    const text3 = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
    const exact = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
    function project2(answer2) {
      const dir = answer2?.directory;
      if (answer2?.ok !== true || !exact(dir, ["id", "name", "parentId"]) || !text3(dir.id, 4096) || !text3(dir.name, 256) || !(dir.parentId === null || text3(dir.parentId, 4096) && dir.parentId !== dir.id) || !Array.isArray(answer2.entries) || answer2.entries.length > 500) return null;
      const seen = /* @__PURE__ */ new Set(), entries = [];
      for (const entry of answer2.entries) {
        if (!exact(entry, ["id", "name"]) || !text3(entry.id, 4096) || !text3(entry.name, 256) || seen.has(entry.id) || entry.id === dir.id) return null;
        seen.add(entry.id);
        entries.push({ id: entry.id, name: entry.name });
      }
      return { directory: { id: dir.id, name: dir.name, parentId: dir.parentId }, entries, limited: answer2.limited === true };
    }
    async function read(id) {
      const mine = ++epoch, previous = request, controller = new AbortController();
      request = controller;
      state = { ...state, busy: true, creating: false, error: null };
      previous?.abort();
      publish();
      if (!live(mine)) return { ok: false, code: "changed" };
      try {
        const answer2 = await load(id, { signal: controller.signal, hidden: state.hidden });
        if (!live(mine)) return { ok: false, code: "changed" };
        const next = project2(answer2);
        if (!next) {
          state = { ...state, error: ["outside-root", "unreadable", "not-found", "signed-out"].includes(answer2?.code) ? answer2.code : "unavailable" };
          return { ok: false, code: state.error };
        }
        createNeedsReload = false;
        state = { ...state, ...createState(), ...next, rootId: state.rootId || (id === null ? next.directory.id : null) };
        return { ok: true };
      } catch {
        if (!live(mine)) return { ok: false, code: "changed" };
        state = { ...state, error: "unavailable" };
        return { ok: false, code: "unavailable" };
      } finally {
        if (live(mine)) {
          request = null;
          state = { ...state, busy: false };
          publish();
        }
      }
    }
    function close() {
      ++epoch;
      const previous = request;
      request = null;
      state = { open: false, busy: false, directory: null, entries: [], error: null, hidden: false, rootId: null, limited: false, ...createState() };
      previous?.abort();
      publish();
    }
    return Object.freeze({
      open() {
        if (!active()) return Promise.resolve({ ok: false, code: "changed" });
        state = { open: true, busy: false, directory: null, entries: [], error: null, hidden: false, rootId: null, limited: false, ...createState() };
        return read(null);
      },
      navigate(id) {
        if (!text3(id, 4096) || !active() || !state.open || state.busy || !state.entries.some((entry) => entry.id === id) && state.directory?.parentId !== id) return Promise.resolve({ ok: false, code: "unavailable" });
        return read(id);
      },
      beginCreate() {
        if (!active() || !state.open) return { ok: false, code: "changed" };
        if (state.busy || !state.directory || state.error || !canCreate) return { ok: false, code: "unavailable" };
        state = { ...state, createOpen: true, createName: "", createError: null };
        publish();
        return { ok: true };
      },
      setCreateName(value) {
        if (!active() || !state.open) return { ok: false, code: "changed" };
        if (!state.createOpen || state.busy || typeof value !== "string") return { ok: false, code: "unavailable" };
        state = { ...state, createName: value, createError: null };
        publish();
        return { ok: true };
      },
      cancelCreate() {
        if (!active() || !state.open) return { ok: false, code: "changed" };
        if (state.busy) return { ok: false, code: "busy" };
        state = { ...state, createOpen: false, createName: "", createError: null };
        publish();
        return { ok: true };
      },
      async createFolder() {
        if (!active() || !state.open) return { ok: false, code: "changed" };
        if (state.busy) return { ok: false, code: "busy" };
        if (createNeedsReload) return { ok: false, code: "reload-required" };
        if (!canCreate || !state.createOpen || !state.directory || state.error) return { ok: false, code: "unavailable" };
        const name2 = state.createName;
        if (!folderName(name2)) {
          state = { ...state, createError: "invalid" };
          publish();
          return { ok: false, code: "invalid" };
        }
        const mine = ++epoch, controller = new AbortController();
        request = controller;
        const parent = state.directory.id;
        state = { ...state, busy: true, creating: true, createError: null };
        publish();
        try {
          if (!live(mine)) return { ok: false, code: "changed" };
          let result;
          try {
            result = await createDirectory(parent, name2, { signal: controller.signal });
          } catch {
            result = { ok: false, code: "unavailable" };
          }
          if (!live(mine)) return { ok: false, code: "changed" };
          if (result?.ok === true && text3(result.path, 4096)) {
            state = { ...state, createOpen: false, createName: "", createError: null };
            return await read(result.path);
          }
          const code = ["exists", "invalid", "outside-root", "signed-out", "unsupported"].includes(result?.code) ? result.code : "unavailable";
          if (code === "unsupported") canCreate = false;
          if (code === "unavailable") createNeedsReload = true;
          state = { ...state, canCreate, createNeedsReload, createError: code, createOpen: canCreate };
          return { ok: false, code };
        } finally {
          if (live(mine)) {
            request = null;
            state = { ...state, busy: false, creating: false };
            publish();
          }
        }
      },
      goPath(path) {
        return !text3(path, 4096) || !active() || !state.open || state.busy ? Promise.resolve({ ok: false, code: "unavailable" }) : read(path);
      },
      home() {
        return !active() || !state.open || state.busy ? Promise.resolve({ ok: false, code: "unavailable" }) : read(state.rootId);
      },
      setHidden(value) {
        if (typeof value !== "boolean" || !active() || !state.open || state.creating) return Promise.resolve({ ok: false, code: "unavailable" });
        state = { ...state, hidden: value };
        return read(state.directory?.id || null);
      },
      up() {
        const id = state.directory?.parentId;
        return id ? this.navigate(id) : Promise.resolve({ ok: false, code: "unavailable" });
      },
      confirm() {
        if (!active() || !state.open || state.busy || !state.directory || state.error || state.createOpen) return null;
        const answer2 = { id: state.directory.id, name: state.directory.name };
        close();
        return answer2;
      },
      close,
      state: snapshot,
      destroy() {
        destroyed = true;
        close();
      }
    });
  }
  var init_folder_picker_model = __esm({
    "src/renderer/web-files/folder-picker-model.js"() {
      init_globals();
    }
  });

  // src/renderer/web-files/folder-picker-view.js
  function createServerFolderPickerView({ model, document: document2 = globalThis.document, mount = document2?.body, onChoose = () => {
  }, onCancel = () => {
  } } = {}) {
    if (!document2 || !mount || !model || !["state", "open", "close", "up", "navigate", "confirm"].every((key) => typeof model[key] === "function")) throw TypeError("Folder picker model required");
    let destroyed = false, opened = false, priorFocus = null, entryButtons = [], generation = 0, settled = false, prepared = false, lastDirectoryId = null, createWasOpen = false;
    const listeners = [], entryListeners = [];
    const make = (tag, className, text3) => {
      const node = document2.createElement(tag);
      node.className = className;
      if (text3 !== void 0) node.textContent = text3;
      return node;
    };
    const bind = (node, type, handler, list2 = listeners) => {
      node.addEventListener(type, handler);
      list2.push(() => node.removeEventListener(type, handler));
    };
    const clear = (list2) => {
      for (const remove of list2.splice(0)) remove();
    };
    const element = make("div", "wb-web-folder-picker");
    element.hidden = true;
    element.setAttribute("data-wb-test", "picker");
    const dialog = make("section", "wb-web-folder-picker__dialog");
    const heading = make("h2", "wb-web-folder-picker__heading", "Choose a folder on this server");
    const headingId = `wb-web-folder-picker-title-${++nextPickerId}`;
    heading.setAttribute("id", headingId);
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", headingId);
    dialog.setAttribute("tabindex", "-1");
    const path = make("input", "wb-web-folder-picker__path");
    path.type = "text";
    path.setAttribute("aria-label", "Server folder");
    path.setAttribute("data-wb-test", "path");
    path.setAttribute("autocomplete", "off");
    path.setAttribute("spellcheck", "false");
    const newFolder = make("button", "wb-web-folder-picker__new", "New folder");
    newFolder.type = "button";
    newFolder.setAttribute("data-wb-test", "new-folder");
    const address = make("div", "wb-web-folder-picker__address");
    address.append(path, newFolder);
    const createRow = make("div", "wb-web-folder-picker__create-row");
    createRow.hidden = true;
    const createName = make("input", "wb-web-folder-picker__name");
    createName.type = "text";
    createName.setAttribute("aria-label", "Folder name");
    createName.setAttribute("data-wb-test", "new-folder-name");
    createName.setAttribute("autocomplete", "off");
    const createButton = make("button", "wb-web-folder-picker__create", "Create");
    createButton.type = "button";
    const createCancel = make("button", "wb-web-folder-picker__create-cancel", "Cancel");
    createCancel.type = "button";
    createCancel.setAttribute("data-wb-test", "new-folder-cancel");
    createRow.append(createName, createButton, createCancel);
    const createStatus = make("p", "wb-web-folder-picker__create-status");
    createStatus.setAttribute("role", "status");
    createStatus.hidden = true;
    const createReload = make("button", "wb-web-folder-picker__create-reload", "Reload folders");
    createReload.type = "button";
    createReload.hidden = true;
    const up = make("button", "wb-web-folder-picker__up", "Up");
    up.type = "button";
    const hiddenLabel = make("label", "wb-web-folder-picker__hidden-label");
    const hidden = make("input", "wb-web-folder-picker__hidden");
    hidden.type = "checkbox";
    hidden.checked = false;
    hiddenLabel.append(hidden, make("span", "wb-web-folder-picker__hidden-text", "Show hidden folders"));
    const tools = make("div", "wb-web-folder-picker__tools");
    tools.append(up, hiddenLabel);
    const status = make("p", "wb-web-folder-picker__status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const back = make("button", "wb-web-folder-picker__back", "Go back");
    back.type = "button";
    back.hidden = true;
    const retry = make("button", "wb-web-folder-picker__retry", "Retry");
    retry.type = "button";
    retry.hidden = true;
    const limit = make("p", "wb-web-folder-picker__limit");
    limit.hidden = true;
    const list = make("ul", "wb-web-folder-picker__list");
    list.setAttribute("aria-label", "Folders");
    list.setAttribute("data-wb-test", "list");
    const actions = make("div", "wb-web-folder-picker__actions");
    const cancel = make("button", "wb-web-folder-picker__cancel", "Cancel");
    cancel.type = "button";
    cancel.setAttribute("data-wb-test", "cancel");
    const choose = make("button", "wb-web-folder-picker__choose", "Choose this folder");
    choose.type = "button";
    choose.setAttribute("data-wb-test", "choose");
    actions.append(cancel, choose);
    dialog.append(heading, address, tools, status, back, retry, limit, createRow, createStatus, createReload, list, actions);
    element.append(dialog);
    mount.append(element);
    const inside = (node) => {
      while (node) {
        if (node === dialog) return true;
        node = node.parentNode;
      }
      return false;
    };
    function restore() {
      const previous = priorFocus;
      priorFocus = null;
      if (previous?.isConnected !== false) previous?.focus?.();
    }
    function render(state = model.state()) {
      if (destroyed) return;
      if (!state.open) {
        element.hidden = true;
        if (opened) {
          opened = false;
          restore();
        }
        return;
      }
      const opening = !opened, hadEntryFocus = entryButtons.includes(document2.activeElement);
      if (opening) {
        if (!prepared) {
          ++generation;
          settled = false;
        }
        prepared = false;
        priorFocus = document2.activeElement;
        opened = true;
      }
      element.hidden = false;
      dialog.setAttribute("aria-busy", state.busy ? "true" : "false");
      const directoryId = state.directory?.id || "";
      if (opening || lastDirectoryId !== directoryId || document2.activeElement !== path) path.value = directoryId;
      lastDirectoryId = directoryId;
      path.disabled = !!state.busy;
      hidden.disabled = !!state.busy;
      hidden.checked = state.hidden === true;
      up.hidden = !state.directory?.parentId;
      up.disabled = !!state.busy || up.hidden;
      const rowOpen = state.createOpen === true && state.canCreate === true;
      newFolder.hidden = state.canCreate !== true;
      newFolder.disabled = !!state.busy || !state.directory || !!state.error || rowOpen;
      createRow.hidden = !rowOpen;
      for (const control of [createName, createButton, createCancel]) {
        control.hidden = !rowOpen;
        control.disabled = !!state.busy || !rowOpen;
      }
      if (createName.value !== state.createName) createName.value = state.createName || "";
      createButton.disabled = createButton.disabled || !state.createName || state.createNeedsReload === true;
      const createWords = { exists: `A folder named ${state.createName || ""} already exists here.`, invalid: "That name can't be used for a folder.", "outside-root": "That place isn't available here.", "signed-out": "Can't create this folder. Sign in again.", unavailable: "Couldn't create the folder. Reload the folders before trying again." };
      createStatus.textContent = createWords[state.createError] || "";
      createStatus.hidden = !createStatus.textContent;
      createReload.hidden = state.createNeedsReload !== true;
      createReload.disabled = !!state.busy;
      choose.disabled = !!state.busy || !state.directory || !!state.error || rowOpen;
      const outside = state.error === "outside-root" && typeof state.rootId === "string" && state.rootId.length > 0;
      status.textContent = state.busy ? "Loading\u2026" : outside ? `That place isn't available here. Go back to ${state.rootId}.` : state.error === "not-found" ? "No folder with that path." : state.error ? "Can't open this folder. Choose another." : state.entries.length ? "" : "No folders here.";
      back.hidden = !outside;
      back.disabled = !!state.busy;
      retry.hidden = !state.error || !!state.directory || outside;
      retry.disabled = !!state.busy;
      limit.hidden = state.limited !== true;
      limit.textContent = state.limited === true ? "Showing the first 500 folders. Type a path above to go further." : "";
      clear(entryListeners);
      entryButtons = [];
      list.replaceChildren();
      for (const entry of state.entries) {
        const item = make("li", "wb-web-folder-picker__item");
        const button = make("button", "wb-web-folder-picker__folder", entry.name);
        button.type = "button";
        button.disabled = !!state.busy;
        bind(button, "click", () => run(() => model.navigate(entry.id)), entryListeners);
        entryButtons.push(button);
        item.append(button);
        list.append(item);
      }
      if (rowOpen && !createWasOpen) createName.focus();
      else if (!rowOpen && createWasOpen && !newFolder.hidden) newFolder.focus();
      else if (opening || hadEntryFocus) cancel.focus();
      createWasOpen = rowOpen;
    }
    function cancelSession(code, mine = generation) {
      if (destroyed || settled || mine !== generation) return;
      settled = true;
      prepared = false;
      try {
        model.close();
      } catch {
      }
      render();
      try {
        onCancel({ code });
      } catch {
      }
    }
    function run(action, mine = generation) {
      if (destroyed) return Promise.resolve();
      try {
        const answer2 = action();
        render();
        return Promise.resolve(answer2).then((value) => {
          if (value?.code === "changed") cancelSession("changed", mine);
          render();
          return value;
        }, () => {
          render();
        });
      } catch {
        render();
        return Promise.resolve();
      }
    }
    const close = () => cancelSession("cancelled");
    bind(newFolder, "click", () => run(() => model.beginCreate()));
    bind(createName, "input", () => run(() => model.setCreateName(createName.value)));
    bind(createName, "keydown", (event) => {
      if (event.key === "Enter" && !createButton.disabled) {
        event.preventDefault();
        run(() => model.createFolder());
      }
    });
    bind(createButton, "click", () => run(() => model.createFolder()));
    bind(createCancel, "click", () => run(() => model.cancelCreate()));
    bind(createReload, "click", () => run(() => model.goPath(model.state().directory.id)));
    bind(path, "keydown", (event) => {
      if (event.key === "Enter" && !path.disabled) {
        event.preventDefault();
        run(() => model.goPath(path.value));
      }
    });
    bind(hidden, "change", () => run(() => model.setHidden(hidden.checked)));
    bind(back, "click", () => run(() => model.home()));
    bind(retry, "click", () => run(() => model.home()));
    bind(up, "click", () => run(() => model.up()));
    bind(cancel, "click", close);
    bind(choose, "click", () => run(() => {
      const selected = model.confirm();
      render();
      if (selected) {
        settled = true;
        onChoose(selected);
      }
    }));
    bind(document2, "keydown", (event) => {
      if (!opened || destroyed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [path, newFolder, up, hidden, back, retry, createName, createButton, createCancel, createReload, ...entryButtons, cancel, choose].filter((node) => !node.hidden && !node.disabled);
      const first = controls[0], last = controls[controls.length - 1], focused = document2.activeElement;
      if (!inside(focused) || event.shiftKey && focused === first || !event.shiftKey && focused === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    });
    bind(document2, "focusin", () => {
      if (opened && !inside(document2.activeElement)) cancel.focus();
    });
    render();
    return Object.freeze({
      element,
      render,
      open() {
        ++generation;
        settled = false;
        prepared = true;
        return run(() => model.open());
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clear(listeners);
        clear(entryListeners);
        try {
          model.close();
        } catch {
        }
        element.remove();
        opened = false;
        restore();
      }
    });
  }
  var nextPickerId;
  var init_folder_picker_view = __esm({
    "src/renderer/web-files/folder-picker-view.js"() {
      init_globals();
      nextPickerId = 0;
    }
  });

  // src/renderer/web-files/folder-picker.js
  var folder_picker_exports = {};
  __export(folder_picker_exports, {
    createServerFolderChooser: () => createServerFolderChooser
  });
  function createServerFolderChooser({ load, createDirectory, current = () => true, document: document2 = globalThis.document, mount, makeView = createServerFolderPickerView } = {}) {
    if (typeof load !== "function") throw TypeError("Directory loader required");
    let active = null, disposed = false;
    const live = (scope) => {
      try {
        return !disposed && current() === true && scope() === true;
      } catch {
        return false;
      }
    };
    function finish(operation, result) {
      if (operation.finished) return;
      operation.finished = true;
      if (active === operation) active = null;
      operation.signal?.removeEventListener("abort", operation.cancel);
      try {
        operation.view?.destroy();
      } finally {
        operation.model?.destroy();
        operation.resolve(result);
      }
    }
    return Object.freeze({
      choose({ signal, current: scope = () => true, initialPath = null } = {}) {
        if (signal?.aborted || !live(scope)) return Promise.resolve({ ok: false, code: "changed" });
        if (active) return Promise.resolve({ ok: false, code: "busy" });
        let resolve;
        const promise = new Promise((done) => resolve = done);
        const operation = { resolve, signal, finished: false, view: null, model: null, cancel: null };
        active = operation;
        operation.cancel = () => finish(operation, { ok: false, code: "changed" });
        try {
          operation.model = createServerFolderPicker({ load, createDirectory, current: () => !operation.finished && live(scope), onState: (state) => operation.view?.render(state) });
          operation.view = makeView({
            model: operation.model,
            document: document2,
            mount: mount || document2?.body,
            onChoose: (selection) => finish(operation, live(scope) ? { ok: true, path: selection.id } : { ok: false, code: "changed" }),
            onCancel: (result) => finish(operation, { ok: false, code: result?.code === "changed" ? "changed" : "cancelled" })
          });
          signal?.addEventListener("abort", operation.cancel, { once: true });
          if (signal?.aborted || !live(scope)) operation.cancel();
          else Promise.resolve(operation.view.open()).then(async (result) => {
            if (result?.code === "changed") {
              operation.cancel();
              return;
            }
            if (result?.ok && typeof initialPath === "string" && initialPath.startsWith("/") && initialPath !== operation.model.state().directory?.id) {
              const navigation = await operation.model.goPath(initialPath);
              if (navigation?.code === "changed") operation.cancel();
            }
          }, () => finish(operation, { ok: false, code: "unavailable" }));
        } catch {
          finish(operation, { ok: false, code: "unavailable" });
        }
        return promise;
      },
      dispose() {
        disposed = true;
        if (active) finish(active, { ok: false, code: "changed" });
      }
    });
  }
  var init_folder_picker = __esm({
    "src/renderer/web-files/folder-picker.js"() {
      init_globals();
      init_folder_picker_model();
      init_folder_picker_view();
    }
  });

  // src/renderer/web-files/room-files-model.js
  function createRoomFilesModel({ makeClient, current = () => true, onState = () => {
  } } = {}) {
    if (typeof makeClient !== "function") throw TypeError("Room files client factory required");
    let epoch = 0, binding = null, destroyed = false, reads = 0;
    let state = { roomId: null, dir: "assets", sub: "", busy: false, entries: [], failures: [], notices: [], error: null };
    const active = () => {
      try {
        return !destroyed && current() === true;
      } catch {
        return false;
      }
    };
    const live = (token) => active() && binding === token && token.epoch === epoch;
    const snapshot = () => ({ ...state, entries: state.entries.map((e) => ({ ...e })), failures: state.failures.map((f) => ({ ...f })), notices: state.notices.map((n) => ({ ...n })) });
    const publish = () => {
      try {
        onState(snapshot());
      } catch {
      }
    };
    const changed2 = () => ({ ok: false, code: "changed" });
    const code = (result) => ["sign-in", "forbidden", "not-found", "conflict", "too-large", "invalid", "unconfirmed"].includes(result?.code) ? result.code : "unavailable";
    async function listing(token, dir, sub) {
      const read = ++reads;
      try {
        const result = await token.client.list(dir, sub);
        if (!live(token) || read !== reads) return changed2();
        if (!result?.ok) {
          state = { ...state, entries: [], error: code(result) };
          return { ok: false, code: state.error };
        }
        state = { ...state, dir, sub, entries: result.entries.map((e) => ({ ...e })), error: null };
        return { ok: true };
      } catch {
        if (!live(token) || read !== reads) return changed2();
        state = { ...state, entries: [], error: "unavailable" };
        return { ok: false, code: "unavailable" };
      }
    }
    async function refresh(dir = state.dir, sub = state.sub) {
      const token = binding;
      if (!token || !live(token)) return changed2();
      if (state.busy) return { ok: false, code: "busy" };
      state = { ...state, busy: true, failures: [], notices: [] };
      publish();
      try {
        return await listing(token, dir, sub);
      } finally {
        if (live(token)) {
          state = { ...state, busy: false };
          publish();
        }
      }
    }
    async function bind(roomId) {
      if (!active()) return changed2();
      const old = binding, token = { roomId, epoch: ++epoch, client: null };
      binding = token;
      ++reads;
      state = { roomId, dir: "assets", sub: "", busy: false, entries: [], failures: [], notices: [], error: null };
      old?.client?.destroy();
      try {
        token.client = makeClient(roomId, { current: () => live(token) });
      } catch {
        binding = null;
        state = { ...state, error: "unavailable" };
        publish();
        return { ok: false, code: "unavailable" };
      }
      return refresh();
    }
    return Object.freeze({
      bind,
      refresh,
      state: snapshot,
      async upload(files) {
        const token = binding;
        if (!token || !live(token)) return changed2();
        if (state.busy) return { ok: false, code: "busy" };
        if (!Array.isArray(files) || files.length < 1 || files.length > 20 || files.some((f) => !(f instanceof Blob) || typeof f.name !== "string" || !f.name)) return { ok: false, code: "invalid" };
        const dir = state.dir, sub = state.sub;
        if (sub) return { ok: false, code: "invalid" };
        state = { ...state, busy: true, failures: [], notices: [], error: null };
        publish();
        let uploaded = 0;
        const failures = [], notices = [];
        try {
          for (const file of files) {
            if (!live(token)) return changed2();
            let result;
            try {
              result = await token.client.upload(dir, file, file.name);
            } catch {
              result = { ok: false, code: "unavailable" };
            }
            if (!live(token)) return changed2();
            if (result?.ok) {
              uploaded++;
              if (typeof result.name === "string" && result.name !== file.name) notices.push({ name: file.name, addedAs: result.name });
            } else failures.push({ name: file.name, code: code(result), ...result?.reason === "person-only" ? { reason: "person-only" } : {}, ...Number.isFinite(result?.limitBytes) ? { limitBytes: result.limitBytes } : {}, ...Number.isFinite(result?.sizeBytes) ? { sizeBytes: result.sizeBytes } : result?.code === "too-large" ? { sizeBytes: file.size } : {} });
          }
          state = { ...state, failures, notices };
          if (uploaded) await listing(token, dir, sub);
          return live(token) ? { ok: failures.length === 0, uploaded, failures: failures.map((f) => ({ ...f })) } : changed2();
        } finally {
          if (live(token)) {
            state = { ...state, busy: false };
            publish();
          }
        }
      },
      async read(name2) {
        const token = binding;
        if (!token || !live(token)) return changed2();
        const entry = state.entries.find((e) => e.name === name2 && e.kind === "file");
        if (!entry) return { ok: false, code: "invalid" };
        const dir = state.dir, rel = state.sub ? state.sub + "/" + name2 : name2;
        try {
          const result = await token.client.read(dir, rel);
          return live(token) ? result : changed2();
        } catch {
          return live(token) ? { ok: false, code: "unavailable" } : changed2();
        }
      },
      async remove(name2, confirm) {
        const token = binding;
        if (!token || !live(token)) return changed2();
        if (state.busy) return { ok: false, code: "busy" };
        const entry = state.entries.find((e) => e.name === name2 && e.kind === "file");
        if (!entry || typeof confirm !== "function") return { ok: false, code: "invalid" };
        const dir = state.dir, sub = state.sub, rel = sub ? sub + "/" + name2 : name2;
        state = { ...state, busy: true };
        publish();
        try {
          const baseline = await token.client.readRevision(dir, rel);
          if (!live(token)) return changed2();
          if (!baseline?.ok) return { ok: false, code: code(baseline) };
          const revision2 = baseline.revision;
          if (typeof revision2 !== "string" || revision2.length > 4096 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(revision2)) return { ok: false, code: "unavailable" };
          const yes = await confirm({ name: name2, roomId: token.roomId });
          if (!live(token)) return changed2();
          if (yes !== true) return { ok: false, code: "cancelled" };
          const result = await token.client.remove(dir, rel, { revision: revision2 });
          if (!live(token)) return changed2();
          if (!result?.ok) return { ok: false, code: code(result) };
          await listing(token, dir, sub);
          return live(token) ? { ok: true } : changed2();
        } catch {
          return live(token) ? { ok: false, code: "unavailable" } : changed2();
        } finally {
          if (live(token)) {
            state = { ...state, busy: false };
            publish();
          }
        }
      },
      destroy() {
        destroyed = true;
        ++epoch;
        ++reads;
        const old = binding;
        binding = null;
        state = { roomId: null, dir: "assets", sub: "", busy: false, entries: [], failures: [], notices: [], error: null };
        old?.client?.destroy();
        publish();
      }
    });
  }
  var init_room_files_model = __esm({
    "src/renderer/web-files/room-files-model.js"() {
      init_globals();
    }
  });

  // src/renderer/web-files/note-editor-model.js
  function createNoteEditorModel({ roomId, name: name2, read, write, current = () => true, onState = () => {
  }, signal, draft, serverAnswer } = {}) {
    if (!segment2(roomId) || !noteName(name2) || typeof read !== "function" || typeof write !== "function" || typeof current !== "function" || typeof serverAnswer !== "function") throw TypeError("Note binding and transport required");
    const room = roomId, note = name2;
    const messageFor = (code) => code === "conflict" ? serverAnswer("note.save", { status: 412, reason: "changed" }) : code === "deleted" ? serverAnswer("note.save", { status: 412, reason: "deleted" }) : code === "person-only" ? serverAnswer("person-only", { status: 403, reason: "person-only" }) : code === "server" ? serverAnswer("generic", {}) : null;
    let state = empty(), epoch = 0, pending = null, operation = null, revoked = false, destroyed = false;
    const snapshot = () => ({ ...state });
    function revoke() {
      revoked = true;
      ++epoch;
      const previous = pending;
      pending = null;
      operation = null;
      previous?.abort();
    }
    function active() {
      if (destroyed || revoked) return false;
      let allowed = false;
      try {
        allowed = !signal?.aborted && current() === true;
      } catch {
      }
      if (!allowed) revoke();
      return allowed;
    }
    const live = (mine) => active() && state.open && mine === epoch;
    const publish = () => {
      if (active()) try {
        onState(snapshot());
      } catch {
      }
    };
    signal?.addEventListener("abort", revoke, { once: true });
    function begin(kind) {
      const controller = new AbortController();
      pending = controller;
      operation = kind;
      const mine = ++epoch;
      state = { ...state, busy: true, error: null };
      publish();
      return { controller, mine };
    }
    function finish(mine) {
      if (live(mine)) {
        pending = null;
        operation = null;
        state = { ...state, busy: false };
        publish();
      }
    }
    async function load() {
      const { controller, mine } = begin("read");
      try {
        if (!live(mine)) return failure("changed");
        const answer2 = await read(note, { signal: controller.signal });
        if (!live(mine)) return failure("changed");
        if (answer2?.ok === true && typeof answer2.text === "string" && validRevision(answer2.revision)) {
          state = { ...state, text: answer2.text, savedText: answer2.text, revision: answer2.revision, dirty: false, error: null, message: null, needsReload: false };
          return { ok: true };
        }
        const code = answer2?.code === "not-found" && validRevision(state.revision) ? "deleted" : answer2?.reason === "person-only" || answer2?.code === "sign-in" ? "person-only" : answer2?.code === "forbidden" ? "forbidden" : "unavailable";
        state = { ...state, error: code, message: messageFor(code) || "Can't read this file." };
        return failure(code);
      } catch {
        if (!live(mine)) return failure("changed");
        state = { ...state, error: "unavailable" };
        return failure("unavailable");
      } finally {
        finish(mine);
      }
    }
    async function save() {
      if (!active()) return failure("changed");
      if (!state.open) return failure("closed");
      if (state.busy) return failure("busy");
      if (state.needsReload || !validRevision(state.revision)) return failure("reload-required");
      if (!state.dirty) return { ok: true };
      const sentText = state.text, revision2 = state.revision;
      const { controller, mine } = begin("write");
      try {
        if (!live(mine)) return failure("changed");
        const answer2 = await write(note, sentText, { revision: revision2, signal: controller.signal });
        if (!live(mine)) return failure("changed");
        if (answer2?.ok === true && validRevision(answer2.revision)) {
          state = { ...state, savedText: sentText, revision: answer2.revision, dirty: state.text !== sentText, error: null, message: null, needsReload: false };
          return { ok: true };
        }
        if (answer2?.ok === false && answer2.code === "conflict") {
          const code2 = answer2.reason === "deleted" ? "deleted" : answer2.reason === void 0 || answer2.reason === "changed" ? "conflict" : "server";
          state = { ...state, error: code2, message: code2 === "server" ? serverAnswer("note.save", { status: answer2.status || 412, reason: answer2.reason }) : messageFor(code2), needsReload: true };
          return failure(code2);
        }
        if (answer2?.code === "too-large" && Number.isSafeInteger(answer2.sizeBytes) && Number.isSafeInteger(answer2.limitBytes)) {
          state = { ...state, error: "too-large", message: serverAnswer("upload", { status: 413, name: note, size: sizeText(answer2.sizeBytes), limit: sizeText(answer2.limitBytes) }) };
          return failure("too-large");
        }
        if (answer2?.reason === "person-only" || answer2?.code === "sign-in") {
          state = { ...state, error: "person-only", message: messageFor("person-only") };
          return failure("forbidden");
        }
        if (answer2?.ok === false && answer2.code === "forbidden") {
          state = { ...state, error: "forbidden", message: serverAnswer("person-only", { status: 403, reason: answer2.reason || answer2.code }) };
          return failure("forbidden");
        }
        const code = Number.isInteger(answer2?.status) ? "server" : "unavailable";
        state = { ...state, error: code, message: code === "server" ? serverAnswer("note.save", { status: answer2.status, reason: answer2.code }) : messageFor(code), needsReload: true };
        return failure(code);
      } catch {
        if (!live(mine)) return failure("changed");
        state = { ...state, error: "unavailable", needsReload: true };
        return failure("unavailable");
      } finally {
        finish(mine);
      }
    }
    function close({ discard = false } = {}) {
      if (!active()) return failure("changed");
      if ((state.dirty || operation === "write") && discard !== true) return failure("blocked");
      ++epoch;
      const previous = pending;
      pending = null;
      operation = null;
      state = empty();
      previous?.abort();
      publish();
      return { ok: true };
    }
    return Object.freeze({
      roomId: room,
      name: note,
      state() {
        active();
        return snapshot();
      },
      open() {
        if (!active()) return Promise.resolve(failure("changed"));
        if (state.open) return Promise.resolve(state.dirty || state.busy ? failure("blocked") : { ok: true });
        if (draft && typeof draft.text === "string" && typeof draft.savedText === "string" && validRevision(draft.revision)) {
          const error2 = messageFor(draft.error) ? draft.error : draft.needsReload ? "unavailable" : null;
          state = { ...empty(), open: true, text: draft.text, savedText: draft.savedText, revision: draft.revision, dirty: draft.text !== draft.savedText, needsReload: draft.needsReload === true, error: error2, message: messageFor(error2) };
          draft = null;
          publish();
          return Promise.resolve({ ok: true });
        }
        state = { ...empty(), open: true };
        return load();
      },
      setText(text3) {
        if (!active()) return failure("changed");
        if (!state.open) return failure("closed");
        if (operation === "read") return failure("busy");
        if (typeof text3 !== "string") return failure("invalid");
        state = { ...state, text: text3, dirty: text3 !== state.savedText };
        publish();
        return { ok: true };
      },
      save,
      reload() {
        if (!active()) return Promise.resolve(failure("changed"));
        if (!state.open) return Promise.resolve(failure("closed"));
        if (state.busy) return Promise.resolve(failure("busy"));
        return load();
      },
      close,
      hide: close,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        signal?.removeEventListener("abort", revoke);
        revoke();
        state = { ...state, open: false, busy: false };
      }
    });
  }
  var sizeText, segment2, noteName, validRevision, failure, empty;
  var init_note_editor_model = __esm({
    "src/renderer/web-files/note-editor-model.js"() {
      init_globals();
      sizeText = (value) => value >= 1048576 ? Math.ceil(value / 1048576) + " MB" : value >= 1024 ? Math.ceil(value / 1024) + " KB" : value + " B";
      segment2 = (value) => typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f/\\]/.test(value);
      noteName = (value) => typeof value === "string" && value.length <= 4096 && !/^[A-Za-z]:\//.test(value) && value.split("/").every(segment2);
      validRevision = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) && value.trim().length > 0;
      failure = (code) => ({ ok: false, code });
      empty = () => ({ open: false, busy: false, text: "", savedText: "", revision: null, dirty: false, error: null, message: null, needsReload: false });
    }
  });

  // src/renderer/web-files/cards-model.js
  function parts(ms) {
    const p = {};
    for (const x of DAY.formatToParts(new Date(ms))) p[x.type] = x.value;
    return p;
  }
  function ageGroup(iso, now) {
    const t = timeOf(iso);
    if (!Number.isFinite(t)) return "earlier";
    const d = dayIndex(now) - dayIndex(t);
    if (d <= 0) return "today";
    if (d === 1) return "yesterday";
    if (d <= 6) return "week";
    return "earlier";
  }
  function ageText(iso, now, { short = false } = {}) {
    const t = timeOf(iso);
    if (!Number.isFinite(t)) return "";
    const diff = now - t;
    if (diff < 6e4) return "just now";
    const min = Math.floor(diff / 6e4);
    if (min < 60) return short ? min + " min ago" : min === 1 ? "1 minute ago" : min + " minutes ago";
    const d = dayIndex(now) - dayIndex(t);
    if (d <= 0) {
      const h = Math.floor(diff / 36e5);
      return h === 1 ? "1 hour ago" : h + " hours ago";
    }
    if (d === 1) return short ? "Yesterday" : "yesterday";
    if (d <= 6) return WEEKDAY.format(new Date(t));
    return parts(t).year === parts(now).year ? DATE.format(new Date(t)) : DATE_YEAR.format(new Date(t));
  }
  function typeLabel(item) {
    if (item.kind === "note") return "Note";
    const t = typeof item.type === "string" ? item.type.toLowerCase() : "";
    if (t.startsWith("image/")) return "Image";
    if (ARCHIVES.has(t)) return "Archive";
    if (t === "application/pdf") return "PDF";
    if (t.startsWith("text/")) return "Text";
    return "File";
  }
  function sizeText2(n) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return Math.round(n) + " B";
    if (n < 1024 * 1024) {
      const kb = Math.round(n / 1024);
      if (kb < 1024) return kb + " KB";
    }
    if (n < 1024 ** 3) return short1(n / 1024 ** 2) + " MB";
    return short1(n / 1024 ** 3) + " GB";
  }
  function authorText(author, me, { row = false } = {}) {
    if (typeof author !== "string" || !author) return "";
    if (author === me) return row ? "You" : "you";
    return "@" + author;
  }
  function cardLine(item) {
    if (item.kind === "note") return typeof item.preview === "string" ? item.preview.split(/\r?\n/)[0].trim() : "";
    return [typeLabel(item), sizeText2(item.size)].filter(Boolean).join(" \xB7 ");
  }
  function groupItems(items, now) {
    const by = new Map(GROUPS.map((g) => [g.key, []]));
    const order = (it) => {
      const t = timeOf(whenOf(it));
      return Number.isFinite(t) ? t : -Infinity;
    };
    const sorted = [...items].sort((a, b) => order(b) - order(a) || 0);
    for (const it of sorted) by.get(ageGroup(whenOf(it), now)).push(it);
    return GROUPS.filter((g) => by.get(g.key).length).map((g) => ({ key: g.key, label: g.label, items: by.get(g.key) }));
  }
  function isNew(item, me, seenVersion) {
    if (!copyable(item) || typeof item.id !== "string" || !item.id || typeof item.author !== "string" || !item.author || typeof me !== "string" || !me) return false;
    if (typeof item.version !== "string" || !item.version) return false;
    if (item.author === me) return false;
    return seenVersion(item.id) !== item.version;
  }
  var TZ, DAY, WEEKDAY, DATE, DATE_YEAR, REF, ARCHIVES, GROUPS, VIEWS, DEFAULT_VIEW, readView, timeOf, dayIndex, short1, whenOf, copyable;
  var init_cards_model = __esm({
    "src/renderer/web-files/cards-model.js"() {
      init_globals();
      TZ = "America/Los_Angeles";
      DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
      WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" });
      DATE = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
      DATE_YEAR = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
      REF = /^(line_\d{1,20}|note_[0-9a-f]{12}|asset_[0-9a-f]{12})$/;
      ARCHIVES = /* @__PURE__ */ new Set(["application/zip", "application/x-zip-compressed", "application/x-7z-compressed", "application/x-tar", "application/gzip", "application/x-gzip", "application/x-rar-compressed"]);
      GROUPS = Object.freeze([
        { key: "today", label: "Today" },
        { key: "yesterday", label: "Yesterday" },
        { key: "week", label: "This week" },
        { key: "earlier", label: "Earlier" }
      ]);
      VIEWS = Object.freeze(["compact", "detailed"]);
      DEFAULT_VIEW = "compact";
      readView = (v) => VIEWS.includes(v) ? v : DEFAULT_VIEW;
      timeOf = (v) => {
        const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
        return Number.isFinite(t) && Math.abs(t) <= 864e13 ? t : NaN;
      };
      dayIndex = (ms) => {
        const p = parts(ms);
        return Date.UTC(+p.year, +p.month - 1, +p.day) / 864e5;
      };
      short1 = (v) => v < 10 ? String(Number(v.toFixed(1))) : String(Math.round(v));
      whenOf = (item) => item.modified_at ?? item.created_at ?? null;
      copyable = (item) => item.inEngine === true && typeof item.ref === "string" && REF.test(item.ref);
    }
  });

  // src/renderer/web-files/cards-view.js
  function createScratchCards(deps) {
    const doc = deps.document || globalThis.document;
    const host = deps.host;
    let view = readView(deps.prefs?.get?.());
    let items = [];
    let cursor = null;
    let failed = false;
    let loaded = false;
    let busy = false;
    let token = 0;
    let destroyed = false, revoked = false, renderToken = 0;
    const active = () => {
      if (destroyed || revoked) return false;
      try {
        if (!deps.current || deps.current() === true) return true;
      } catch {
      }
      revoked = true;
      return false;
    };
    const scope = () => {
      const read2 = token, render = renderToken;
      return () => active() && read2 === token && render === renderToken;
    };
    const bindAction = (node, event, fn) => {
      const current = scope();
      node.addEventListener(event, (e) => {
        if (current()) fn(e);
      });
    };
    function ownerActions(item, root, actionsHost = root) {
      if (typeof deps.actions !== "function") return;
      const current = scope();
      for (const event of ["click", "keydown", "submit"]) root.addEventListener(event, (e) => {
        if (!current()) {
          e.preventDefault();
          e.stopImmediatePropagation?.();
          e.stopPropagation?.();
        }
      }, true);
      deps.actions(item, root, { current, actionsHost });
    }
    const el = (tag, cls, text3) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text3 !== void 0) n.textContent = text3;
      return n;
    };
    const icon = (name2) => {
      const s = el("span", "ms sc-icon", name2);
      s.setAttribute("aria-hidden", "true");
      return s;
    };
    const fresh = (it) => isNew(it, deps.me, (id) => deps.seen?.version?.(id) ?? null);
    const accessible = (it) => [it.name || "Untitled", typeLabel(it), sizeText2(it.size), authorText(it.author, deps.me), ageText(whenOf(it), deps.now())].filter(Boolean).join(", ");
    function choose(v, focus) {
      if (!VIEWS.includes(v) || !active()) return;
      if (v !== view) {
        view = v;
        deps.prefs?.set?.(v);
        paint();
      }
      if (focus) segments()[VIEWS.indexOf(v)]?.focus();
    }
    let segs = [];
    const segments = () => segs;
    function toggle() {
      const g = el("div", "sc-toggle");
      g.setAttribute("role", "radiogroup");
      g.setAttribute("aria-label", "View");
      segs = VIEWS.map((v) => {
        const b = el("button", "sc-seg" + (v === view ? " is-on" : ""));
        b.setAttribute("type", "button");
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(v === view));
        b.tabIndex = v === view ? 0 : -1;
        if (v === view) b.appendChild(icon("check"));
        b.appendChild(el("span", "sc-seg-label", LABELS[v]));
        bindAction(b, "click", () => choose(v, false));
        bindAction(b, "keydown", (e) => {
          const i = VIEWS.indexOf(v);
          const to = { ArrowLeft: i - 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowDown: i + 1, Home: 0, End: VIEWS.length - 1 }[e.key];
          if (to === void 0) return;
          e.preventDefault();
          choose(VIEWS[(to + VIEWS.length) % VIEWS.length], true);
        });
        g.appendChild(b);
        return b;
      });
      return g;
    }
    function copyButton(it, label) {
      const b = el("button", "sc-copy");
      b.setAttribute("type", "button");
      b.setAttribute("aria-label", "Copy reference");
      const ok = copyable(it);
      b.disabled = !ok;
      b.title = ok ? "Copy reference" : "Not in the room yet";
      if (label) b.appendChild(el("span", "sc-copy-label", label));
      else b.appendChild(icon("content_copy"));
      const current = scope();
      b.addEventListener("click", async () => {
        if (!current() || busy || !copyable(it)) return;
        const ref2 = it.ref;
        try {
          const result = await deps.copy(ref2);
          if (current()) deps.snackbar?.(result === false || result?.ok === false ? "Couldn't copy reference." : "Reference copied \xB7 " + ref2);
        } catch {
          if (current()) deps.snackbar?.("Couldn't copy reference.");
        }
      });
      return b;
    }
    function openItem(it) {
      if (!active() || busy) return;
      if (fresh(it)) deps.seen?.mark?.(it);
      deps.open?.(it);
      paint();
    }
    function newPill() {
      return el("span", "sc-new", "New");
    }
    function tile(it) {
      const t = el("div", "sc-tile" + (fresh(it) ? " is-new" : ""));
      t.setAttribute("role", "listitem");
      t.setAttribute("data-kind", it.kind);
      const open = el("button", "sc-open");
      open.setAttribute("type", "button");
      const name2 = accessible(it);
      open.setAttribute("aria-label", name2);
      open.title = name2;
      open.appendChild(icon(ICONS[it.kind] || ICONS.asset));
      open.appendChild(el("span", "sc-name", it.name || "Untitled"));
      if (fresh(it)) open.appendChild(newPill());
      open.appendChild(el("span", "sc-meta", [typeLabel(it), sizeText2(it.size), ageText(whenOf(it), deps.now())].filter(Boolean).join(" \xB7 ")));
      bindAction(open, "click", () => openItem(it));
      t.append(open);
      if (!deps.hideUnavailableCopy || copyable(it)) t.append(copyButton(it));
      ownerActions(it, t);
      return t;
    }
    function row(it) {
      const r = el("div", "sc-tr" + (fresh(it) ? " is-new" : ""));
      r.setAttribute("role", "row");
      const nameCell = el("div", "sc-td sc-td-name");
      nameCell.setAttribute("role", "cell");
      const open = el("button", "sc-open");
      open.setAttribute("type", "button");
      open.appendChild(icon(ICONS[it.kind] || ICONS.asset));
      open.appendChild(el("span", "sc-name", it.name || "Untitled"));
      if (fresh(it)) open.appendChild(newPill());
      if (it.kind === "note" && cardLine(it)) open.title = cardLine(it);
      bindAction(open, "click", () => openItem(it));
      nameCell.appendChild(open);
      const cell = (text3) => {
        const c = el("div", "sc-td", text3);
        c.setAttribute("role", "cell");
        return c;
      };
      const act = el("div", "sc-td sc-td-act");
      act.setAttribute("role", "cell");
      if (!deps.hideUnavailableCopy || copyable(it)) act.appendChild(copyButton(it, "Copy ref"));
      r.append(nameCell, cell(typeLabel(it)), cell(sizeText2(it.size)), cell(authorText(it.author, deps.me, { row: true })), cell(ageText(whenOf(it), deps.now(), { short: true })), act);
      ownerActions(it, r, act);
      return r;
    }
    function body() {
      if (failed) {
        const box = el("div", "sc-error");
        box.setAttribute("role", "alert");
        const retry = el("button", "sc-retry", "Try again");
        retry.setAttribute("type", "button");
        bindAction(retry, "click", () => {
          void refresh();
        });
        box.append(el("p", "sc-error-text", "Couldn't load the Scratchpad."), retry);
        return [box];
      }
      if (!loaded) return [];
      if (!items.length) {
        const box = el("div", "sc-empty");
        box.append(el("p", "sc-empty-title", EMPTY[0]), el("p", "sc-empty-text", EMPTY[1]));
        return [box];
      }
      const out = [];
      if (view === "detailed") {
        const table = el("div", "sc-table");
        table.setAttribute("role", "table");
        table.setAttribute("aria-label", "Notes and files");
        const head = el("div", "sc-th");
        head.setAttribute("role", "row");
        for (const h of ["Name", "Type", "Size", "Author", "Modified", ""]) {
          const c = el("div", "sc-thc", h);
          c.setAttribute("role", "columnheader");
          head.appendChild(c);
        }
        table.appendChild(head);
        for (const g of groupItems(items, deps.now())) {
          const sec = el("div", "sc-group");
          sec.setAttribute("role", "rowgroup");
          sec.appendChild(el("div", "sc-gh", g.label));
          for (const it of g.items) sec.appendChild(row(it));
          table.appendChild(sec);
        }
        out.push(table);
      } else {
        for (const g of groupItems(items, deps.now())) {
          const sec = el("section", "sc-group");
          sec.appendChild(el("h3", "sc-gh", g.label));
          const list = el("div", "sc-tiles");
          list.setAttribute("role", "list");
          for (const it of g.items) list.appendChild(tile(it));
          sec.appendChild(list);
          out.push(sec);
        }
      }
      if (cursor !== null) {
        const more = el("button", "sc-more", "Show more");
        more.setAttribute("type", "button");
        more.disabled = busy;
        bindAction(more, "click", () => {
          void loadMore();
        });
        out.push(more);
      }
      return out;
    }
    function paint() {
      if (!active()) return;
      ++renderToken;
      const head = el("div", "sc-head");
      head.appendChild(toggle());
      const main = el("div", "sc-body");
      main.append(...body());
      const root = el("div", "sc-cards sc-" + view);
      root.setAttribute("aria-busy", String(busy));
      root.append(head, main);
      host.replaceChildren(root);
    }
    async function read(from) {
      const mine = ++token;
      busy = true;
      paint();
      let r;
      try {
        r = await deps.load({ cursor: from });
      } catch {
        r = { ok: false };
      }
      if (!active() || mine !== token) return false;
      busy = false;
      if (!r || r.ok !== true || !Array.isArray(r.items)) {
        failed = true;
      } else {
        failed = false;
        loaded = true;
        items = from === null ? r.items.slice() : items.concat(r.items);
        cursor = typeof r.cursor === "string" && r.cursor ? r.cursor : null;
      }
      paint();
      return true;
    }
    async function refresh() {
      if (!active()) return;
      cursor = null;
      await read(null);
    }
    async function loadMore() {
      if (!active() || busy || cursor === null) return;
      await read(cursor);
    }
    paint();
    return Object.freeze({
      refresh,
      view: () => view,
      setView: (v) => choose(v, false),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        token++;
        host.replaceChildren();
      }
    });
  }
  var LABELS, EMPTY, ICONS;
  var init_cards_view = __esm({
    "src/renderer/web-files/cards-view.js"() {
      init_globals();
      init_cards_model();
      LABELS = { compact: "Compact", detailed: "Detailed" };
      EMPTY = ["No notes or files yet.", "Notes and files that you or your agents add appear here, newest first."];
      ICONS = { note: "sticky_note_2", asset: "draft" };
    }
  });

  // src/renderer/web-files/confirm-dialog.js
  function confirmDialog(message, { document: doc = globalThis.document } = {}) {
    const text3 = String(message || "");
    const [keepWords, yesWords] = (LABELS2.find(([re]) => re.test(text3)) || [null, ["Cancel", "OK"]])[1];
    const cut = text3.search(/[?.!](\s|$)/);
    const heading = cut < 0 ? text3 : text3.slice(0, cut + 1), rest = cut < 0 ? "" : text3.slice(cut + 1).trim();
    return new Promise((resolve) => {
      const dialog = doc.createElement("dialog");
      dialog.className = "web-confirm";
      dialog.dataset.wbTest = "web-confirm";
      const title = doc.createElement("h2");
      title.id = "web-confirm-title";
      title.textContent = heading;
      dialog.setAttribute("aria-labelledby", title.id);
      const actions = doc.createElement("div");
      actions.className = "web-confirm-actions";
      const keep = doc.createElement("button");
      keep.type = "button";
      keep.textContent = keepWords;
      keep.dataset.wbTest = "web-confirm-keep";
      const yes = doc.createElement("button");
      yes.type = "button";
      yes.textContent = yesWords;
      yes.className = "web-confirm-yes";
      yes.dataset.wbTest = "web-confirm-yes";
      actions.append(keep, yes);
      dialog.append(title);
      if (rest) {
        const p = doc.createElement("p");
        p.textContent = rest;
        dialog.append(p);
      }
      dialog.append(actions);
      let done = false;
      const settle = (v) => {
        if (done) return;
        done = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(v);
      };
      keep.addEventListener("click", () => settle(false));
      yes.addEventListener("click", () => settle(true));
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        settle(false);
      });
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) settle(false);
      });
      (doc.body || doc.documentElement).append(dialog);
      dialog.showModal();
      keep.focus();
    });
  }
  var LABELS2;
  var init_confirm_dialog = __esm({
    "src/renderer/web-files/confirm-dialog.js"() {
      init_globals();
      LABELS2 = [
        [/^Delete\b/, ["Keep it", "Delete"]],
        [/^Discard\b/, ["Keep editing", "Discard"]],
        [/^Replace\b/, ["Keep my draft", "Replace"]]
      ];
    }
  });

  // src/renderer/web-files/scratchpad-page.js
  var scratchpad_page_exports = {};
  __export(scratchpad_page_exports, {
    createRoomScratchpadPage: () => createRoomScratchpadPage
  });
  function createRoomScratchpadPage({ host, files, document: document2 = host?.ownerDocument, confirm = (message) => confirmDialog(message, { document: document2 }), openBlob, downloadBlob, prefs } = {}) {
    if (!host || !document2 || !files || typeof files.serverAnswer !== "function") throw TypeError("Scratchpad host and files required");
    const serverAnswer = files.serverAnswer;
    const folderSettings = document2.getElementById?.("gsScratchpad");
    if (folderSettings) folderSettings.hidden = true;
    let shown = false, destroyed = false, room = null, roomName2 = null, client = null, model = null, epoch = 0, editor = null, editorName = null, tab = "assets", addingNote = false, cards = null, newNoteSource = null, needsListCheck = false;
    const viewPrefs = prefs || { get() {
      try {
        return globalThis.localStorage?.getItem("wb.web.files.view");
      } catch {
        return null;
      }
    }, set(value) {
      try {
        globalThis.localStorage?.setItem("wb.web.files.view", value);
      } catch {
      }
    } };
    const parked = /* @__PURE__ */ new Map(), urls = /* @__PURE__ */ new Set(), removers = [];
    const make = (tag, cls, text4) => {
      const node = document2.createElement(tag);
      node.className = cls;
      if (text4 !== void 0) node.textContent = text4;
      return node;
    };
    const bind = (node, event, fn) => {
      node.addEventListener(event, fn);
      removers.push(() => node.removeEventListener(event, fn));
    };
    const root = make("section", "wb-room-files");
    root.tabIndex = 0;
    root.setAttribute("aria-label", "Room Scratchpad");
    const title = make("h1", "wb-room-files__title", "Scratchpad");
    const context = make("p", "wb-room-files__room", "Choose a room in Workrooms first.");
    const subtitle = make("p", "wb-room-files__subtitle", "Notes, assets and files for this room. Kept on this server. Agents in this room can read them.");
    const tabs = make("div", "wb-room-files__tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Room files");
    const tabButtons = /* @__PURE__ */ new Map();
    for (const [key, label] of [["notes", "Notes"], ["assets", "Assets"], ["files", "Files"]]) {
      const b = make("button", "wb-room-files__tab", label);
      b.type = "button";
      b.setAttribute("role", "tab");
      bind(b, "click", () => void changeTab(key));
      tabs.append(b);
      tabButtons.set(key, b);
    }
    const input = make("input", "wb-room-files__input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.setAttribute("aria-label", "Add files");
    const add = make("button", "wb-room-files__add", "Add files");
    add.type = "button";
    bind(add, "click", () => input.click());
    const refresh = make("button", "wb-room-files__refresh", "Check the list");
    refresh.type = "button";
    refresh.hidden = true;
    bind(refresh, "click", () => {
      needsListCheck = false;
      if (model) void model.refresh();
    });
    const newNote = make("button", "wb-room-files__new-note", "New note");
    newNote.type = "button";
    newNote.hidden = true;
    const newNoteForm = make("div", "wb-room-files__new-note-form");
    newNoteForm.hidden = true;
    const newName = make("input", "wb-room-files__new-note-name");
    newName.type = "text";
    newName.setAttribute("aria-label", "Note name");
    const newNameLabel = make("label", "wb-room-files__new-note-label");
    newNameLabel.append(make("span", "", "Note name"), newName);
    const createNote = make("button", "wb-room-files__create-note", "Create note"), cancelNote = make("button", "wb-room-files__cancel-note", "Cancel");
    createNote.type = cancelNote.type = "button";
    newNoteForm.append(newNameLabel, createNote, cancelNote);
    bind(newNote, "click", () => {
      newNoteSource = null;
      newNoteForm.hidden = false;
      newName.focus();
    });
    bind(cancelNote, "click", () => {
      if (!addingNote) {
        newNoteForm.hidden = true;
        newNoteSource = null;
      }
    });
    bind(createNote, "click", () => void addNote());
    bind(newName, "keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void addNote();
      }
    });
    const hint = make("p", "wb-room-files__hint", "Drag files here, paste, or choose Add files.");
    const status = make("p", "wb-room-files__status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const list = make("ul", "wb-room-files__list");
    list.setAttribute("aria-label", "Files in this room");
    const edit = make("section", "wb-room-files__editor");
    edit.hidden = true;
    const editTitle = make("h2", "wb-room-files__note-title");
    const text3 = make("textarea", "wb-room-files__note-text");
    text3.setAttribute("aria-label", "Note text");
    const noteStatus = make("p", "wb-room-files__note-status");
    noteStatus.setAttribute("role", "status");
    const save = make("button", "wb-room-files__save", "Save note"), reload = make("button", "wb-room-files__reload", "Reload saved note"), close = make("button", "wb-room-files__close", "Close note");
    const saveAsNew = make("button", "wb-room-files__save-new", "Save as new note");
    saveAsNew.type = "button";
    saveAsNew.hidden = true;
    bind(saveAsNew, "click", () => {
      if (!editor || editor.state().error !== "deleted" || addingNote) return;
      newNoteSource = { owner: editor, name: editorName, epoch };
      newName.value = "";
      newNoteForm.hidden = false;
      newName.focus();
    });
    for (const b of [save, reload, close]) b.type = "button";
    bind(text3, "input", () => editor?.setText(text3.value));
    bind(save, "click", () => void editor?.save());
    bind(reload, "click", () => void reloadNote());
    bind(close, "click", () => void closeNote());
    const tools = make("div", "wb-room-files__tools");
    tools.append(add, refresh, newNote);
    edit.append(editTitle, text3, noteStatus, save, saveAsNew, reload, close);
    root.append(title, context, subtitle, tabs, input, tools, newNoteForm, hint, status, list, edit);
    host.replaceChildren(root);
    const live = (mine) => !destroyed && shown && room && epoch === mine;
    function park() {
      if (editor) {
        const state = editor.state(), key = room + "\n" + editorName;
        if (state.dirty || state.needsReload) parked.set(key, { text: state.text, revision: state.revision, savedText: state.savedText, needsReload: state.needsReload || state.busy, error: state.busy ? "unavailable" : state.error });
        else parked.delete(key);
        editor.destroy();
      }
      editor = null;
      editorName = null;
      edit.hidden = true;
    }
    function deactivate() {
      needsListCheck = false;
      refresh.hidden = true;
      park();
      ++epoch;
      cards?.destroy();
      cards = null;
      addingNote = false;
      newNoteSource = null;
      saveAsNew.hidden = true;
      createNote.disabled = false;
      cancelNote.disabled = false;
      newName.disabled = false;
      newNoteForm.hidden = true;
      newName.value = "";
      model?.destroy();
      model = null;
      client?.destroy();
      client = null;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    }
    function paintEditor(s) {
      if (!s.dirty && !s.needsReload) parked.delete(room + "\n" + editorName);
      edit.hidden = !s.open;
      if (text3.value !== s.text) text3.value = s.text;
      text3.disabled = s.busy && !s.revision;
      save.disabled = s.busy || !s.dirty || s.needsReload || !s.revision;
      reload.disabled = s.busy || addingNote;
      close.disabled = s.busy || addingNote;
      saveAsNew.hidden = s.error !== "deleted";
      saveAsNew.disabled = s.busy || addingNote;
      noteStatus.textContent = s.message || (s.error === "unavailable" ? "Lost the connection while saving. Reload the saved note to see if it went through. Your draft is still here." : s.error ? "Can't read this file." : s.dirty ? "Unsaved changes" : "Saved");
    }
    async function closeNote() {
      const owner = editor, mine = epoch;
      if (!owner) return true;
      if (owner.state().dirty && await confirm("Discard the changes to this note?") !== true) return false;
      if (owner !== editor || !live(mine)) return false;
      owner.close({ discard: true });
      parked.delete(room + "\n" + editorName);
      owner.destroy();
      editor = null;
      editorName = null;
      edit.hidden = true;
      return true;
    }
    async function reloadNote() {
      const owner = editor;
      if (!owner) return;
      if (owner.state().dirty && await confirm("Replace your draft with the saved note?") !== true) return;
      if (owner === editor) await owner.reload();
    }
    async function openNote(name2) {
      const mine = epoch;
      if (!await closeNote() || !live(mine)) return;
      editorName = name2;
      editTitle.textContent = name2;
      const draft = parked.get(room + "\n" + name2), transport = client;
      editor = createNoteEditorModel({ roomId: room, name: name2, serverAnswer, read: transport.readNote, write: transport.writeNote, current: () => live(mine), onState: paintEditor, draft });
      await editor.open();
      if (live(mine)) text3.focus();
    }
    async function recoverNote(source, name2, sentText, mine, transport) {
      if (!live(mine) || editor !== source.owner) return false;
      let candidate;
      candidate = createNoteEditorModel({
        roomId: room,
        name: name2,
        serverAnswer,
        read: transport.readNote,
        write: transport.writeNote,
        current: () => live(mine) && (editor === source.owner || editor === candidate),
        onState: (s) => {
          if (editor === candidate) paintEditor(s);
        }
      });
      const result = await candidate.open();
      if (!live(mine) || editor !== source.owner) {
        candidate.destroy();
        return false;
      }
      if (!result.ok) {
        candidate.destroy();
        status.textContent = "Can't read this file.";
        return false;
      }
      if (candidate.state().savedText !== sentText) {
        candidate.destroy();
        status.textContent = serverAnswer("note.save", { status: 200, reason: "new-changed" });
        return false;
      }
      const latest = source.owner.state().text;
      candidate.setText(latest);
      source.owner.close({ discard: true });
      source.owner.destroy();
      parked.delete(room + "\n" + source.name);
      editor = candidate;
      editorName = name2;
      editTitle.textContent = name2;
      newNoteSource = null;
      paintEditor(candidate.state());
      text3.focus();
      return true;
    }
    async function addNote() {
      if (!shown || !client || !model || model.state().busy || addingNote) return;
      const mine = epoch, owner = client, name2 = newName.value, source = newNoteSource;
      if (source && (source.epoch !== mine || source.owner !== editor || editor.state().error !== "deleted")) return;
      if (!name2 || name2 === "." || name2 === ".." || /[\\/\u0000-\u001f\u007f]/.test(name2)) {
        status.textContent = `${name2} can't be used as a file name. Rename it and try again.`;
        return;
      }
      const sentText = source ? source.owner.state().text : "";
      addingNote = true;
      createNote.disabled = true;
      cancelNote.disabled = true;
      newName.disabled = true;
      paint(model.state());
      if (editor) paintEditor(editor.state());
      try {
        if (source) {
          let baseline;
          try {
            baseline = await owner.readRevision("notes", name2);
          } catch {
            baseline = { ok: false, code: "unavailable" };
          }
          if (!live(mine) || editor !== source.owner) return;
          if (baseline?.ok) {
            status.textContent = serverAnswer("note.save", { status: 200, reason: "new-name-exists" });
            return;
          }
          if (baseline?.code !== "not-found" || baseline.status !== 404) {
            status.textContent = failure2({ name: name2, ...baseline });
            return;
          }
        }
        let result;
        try {
          result = await owner.upload("notes", new Blob([sentText], { type: "text/plain; charset=utf-8" }), name2);
        } catch {
          result = { ok: false, code: "unconfirmed" };
        }
        if (!live(mine)) return;
        if (!result.ok) {
          paint(model.state());
          status.textContent = failure2({ name: name2, ...result });
          return;
        }
        if (source) {
          const actual = result.name, oldBasename = source.name.split("/").at(-1);
          if (typeof actual !== "string" || !actual || actual === oldBasename && name2 !== oldBasename || /[\\/\u0000-\u001f\u007f]/.test(actual)) {
            status.textContent = failure2({ name: name2, code: "unconfirmed" });
            return;
          }
          if (!await recoverNote(source, actual, sentText, mine, owner)) return;
          newNoteForm.hidden = true;
          newName.value = "";
          await model.refresh("notes", "");
          return;
        }
        newNoteForm.hidden = true;
        newName.value = "";
        await model.refresh("notes", "");
        if (live(mine)) await openNote(result.name || name2);
      } finally {
        if (live(mine)) {
          const message = status.textContent;
          addingNote = false;
          createNote.disabled = false;
          cancelNote.disabled = false;
          newName.disabled = false;
          paint(model.state());
          status.textContent = message;
          if (editor) paintEditor(editor.state());
        }
      }
    }
    function blobAction(blob, name2, download) {
      if (download && downloadBlob) {
        downloadBlob(blob, name2);
        return;
      }
      if (!download && openBlob) {
        openBlob(blob, name2);
        return;
      }
      const inline = /^(?:text\/plain(?:;|$)|image\/(?:png|jpeg|gif|webp|avif|bmp)(?:;|$))/i.test(blob.type);
      const url = URL.createObjectURL(blob);
      urls.add(url);
      const a = make("a", "");
      a.href = url;
      a.rel = "noopener noreferrer";
      if (download || !inline) a.download = name2;
      else a.target = "_blank";
      root.append(a);
      a.click();
      a.remove();
    }
    async function readFile(name2, download) {
      const mine = epoch;
      const result = await model.read(name2);
      if (!live(mine)) return;
      if (result.ok) blobAction(result.blob, name2, download);
      else status.textContent = "Can't read this file.";
    }
    const bytes = (n) => n >= 1048576 ? Math.ceil(n / 1048576) + " MB" : n >= 1024 ? Math.ceil(n / 1024) + " KB" : n + " B";
    function failure2(f) {
      if (f.code === "unconfirmed") {
        needsListCheck = true;
        refresh.hidden = false;
      }
      if (f.reason === "person-only") return serverAnswer("person-only", { status: 403, reason: "person_only" });
      if (f.code === "too-large") return serverAnswer("upload", { status: 413, name: f.name, size: bytes(f.sizeBytes || 0), limit: bytes(Number.isFinite(f.limitBytes) && f.limitBytes > 0 ? f.limitBytes : 50 * 1024 * 1024) });
      if (f.code === "invalid") return `${f.name} can't be used as a file name. Rename it and try again.`;
      if (f.code === "sign-in") return "You were signed out. Sign in again, then add it again.";
      if (f.code === "unconfirmed") return `Lost the connection while adding ${f.name}. Try again.`;
      return `Couldn't add ${f.name}. Try again.`;
    }
    function paint(s) {
      if (!shown || destroyed) return;
      const mine = epoch, owner = model;
      add.hidden = s.dir === "notes";
      hint.hidden = s.dir === "notes";
      list.setAttribute("aria-label", s.dir === "notes" ? "Notes in this room" : "Files in this room");
      add.disabled = s.busy || !!s.sub || addingNote;
      refresh.disabled = s.busy || addingNote;
      newNote.hidden = s.dir !== "notes";
      newNote.disabled = s.busy || !!s.sub || addingNote;
      for (const [key, b] of tabButtons) {
        b.disabled = s.busy || addingNote;
        b.setAttribute("aria-selected", String(s.dir === key));
        b.tabIndex = s.dir === key ? 0 : -1;
      }
      status.textContent = s.busy ? "Loading\u2026" : s.failures.length ? s.failures.map(failure2).join(" ") : s.error === "sign-in" ? "You were signed out. Sign in again." : s.error ? "Couldn't load the files. Try again." : s.entries.length ? "" : s.dir === "notes" ? "No notes yet. Create a note to keep it in this room." : "No files yet. Add files from this device.";
      refresh.textContent = s.error && !needsListCheck ? "Try again" : "Check the list";
      refresh.hidden = !needsListCheck && !s.error;
      if (!s.busy && s.notices?.length) status.textContent += (status.textContent ? " " : "") + s.notices.map((n) => `Added as ${n.addedAs} because ${n.name} is already here.`).join(" ");
      cards?.destroy();
      cards = null;
      list.replaceChildren();
      if (s.sub) {
        const up = make("button", "wb-room-files__up", "Up");
        up.type = "button";
        up.disabled = s.busy;
        up.addEventListener("click", () => {
          if (live(mine) && model === owner) void owner.refresh(s.dir, s.sub.split("/").slice(0, -1).join("/"));
        });
        list.append(up);
      }
      for (const entry of s.entries.filter((e) => e.kind === "dir")) {
        const li = make("li", "wb-room-files__row"), label = make("span", "wb-room-files__name", entry.name);
        li.append(label);
        const action = (word, fn) => {
          const b = make("button", "wb-room-files__action", word);
          b.type = "button";
          b.disabled = s.busy || addingNote;
          b.addEventListener("click", () => {
            if (live(mine) && model === owner && !addingNote) fn();
          });
          li.append(b);
        };
        action("Open folder", () => void model.refresh(s.dir, s.sub ? s.sub + "/" + entry.name : entry.name));
        list.append(li);
      }
      const entries = s.entries.filter((e) => e.kind === "file");
      if (entries.length) {
        const host2 = make("li", "wb-room-files__cards");
        host2.setAttribute("role", "presentation");
        list.append(host2);
        const items = entries.map((entry) => ({ id: entry.name, room_id: room, name: entry.name, kind: s.dir === "notes" ? "note" : "asset", type: s.dir === "notes" ? "text/plain" : "", size: entry.size, modified_at: entry.mtime, created_at: null, author: "", version: null, inEngine: false, ref: null }));
        const current = () => live(mine) && model === owner && !owner.state().busy && !addingNote;
        cards = createScratchCards({
          host: host2,
          document: document2,
          now: Date.now,
          prefs: viewPrefs,
          hideUnavailableCopy: true,
          current,
          load: async () => ({ ok: true, items, cursor: null }),
          open: (item) => {
            if (current()) void (s.dir === "notes" ? openNote(s.sub ? s.sub + "/" + item.name : item.name) : readFile(item.name, false));
          },
          actions: (item, row, { current: cardCurrent, actionsHost }) => {
            row.className += " wb-room-files__row";
            const actions = make("div", "wb-room-files__card-actions");
            actions.setAttribute("role", "group");
            actions.setAttribute("aria-label", "Actions for " + item.name);
            const action = (word, fn) => {
              const b = make("button", "wb-room-files__action", word);
              b.type = "button";
              b.disabled = s.busy || addingNote;
              b.addEventListener("click", () => {
                if (current() && cardCurrent()) fn();
              });
              actions.append(b);
            };
            if (s.dir === "notes") action("Edit note", () => void openNote(s.sub ? s.sub + "/" + item.name : item.name));
            action("Open", () => void readFile(item.name, false));
            action("Download", () => void readFile(item.name, true));
            action("Delete\u2026", () => void remove(item.name));
            actionsHost.append(actions);
          }
        });
        void cards.refresh();
      }
    }
    async function remove(name2) {
      const mine = epoch;
      const result = await model.remove(name2, () => confirm(`Delete ${name2}? This can't be undone.`));
      if (live(mine) && result.code === "unconfirmed") {
        needsListCheck = true;
        refresh.hidden = false;
      }
      if (live(mine) && !result.ok && !["cancelled", "changed"].includes(result.code)) status.textContent = result.code === "unconfirmed" ? `Lost the connection while deleting ${name2}. Check the list to see if it was deleted.` : `Couldn't delete ${name2}. Try again.`;
    }
    async function upload(values) {
      if (model?.state().dir === "notes") return;
      needsListCheck = false;
      const batch = Array.from(values || []);
      if (!model || !batch.length || addingNote) return;
      if (batch.length > 20) {
        status.textContent = "Add up to 20 files at a time.";
        return;
      }
      const mine = epoch;
      const result = await model.upload(batch);
      if (live(mine) && result.code === "invalid") status.textContent = "Choose files with valid names, then try again.";
    }
    bind(input, "change", () => {
      void upload(input.files);
      input.value = "";
    });
    bind(root, "dragover", (event) => {
      if (shown && room) event.preventDefault();
    });
    bind(root, "drop", (event) => {
      if (!shown || !room) return;
      event.preventDefault();
      void upload(event.dataTransfer?.files);
    });
    bind(root, "paste", (event) => {
      if (event.target === text3 || !shown || !room || !event.clipboardData?.files?.length) return;
      event.preventDefault();
      void upload(event.clipboardData.files);
    });
    async function changeTab(next) {
      if (addingNote) return;
      const mine = epoch;
      if (!await closeNote() || !live(mine)) return;
      tab = next;
      needsListCheck = false;
      await model.refresh(next, "");
    }
    function activate() {
      deactivate();
      if (!shown || !room || destroyed) {
        context.textContent = "Choose a room in Workrooms first.";
        add.disabled = true;
        list.replaceChildren();
        status.textContent = "";
        for (const b of tabButtons.values()) b.disabled = true;
        return;
      }
      context.textContent = "Room \xB7 " + (roomName2 || room);
      const mine = epoch;
      client = files.room(room, { current: () => live(mine) });
      model = createRoomFilesModel({ makeClient: () => client, current: () => live(mine), onState: paint });
      void model.bind(room).then(() => {
        if (live(mine) && tab !== "assets") void model.refresh(tab);
      });
    }
    const off = files.subscribeRoom((value) => {
      if (!value?.roomId) return;
      roomName2 = value.roomName || value.roomId;
      if (room !== value.roomId) {
        deactivate();
        room = value.roomId;
        tab = "assets";
        if (shown) activate();
      } else if (shown) {
        context.textContent = "Room \xB7 " + roomName2;
      }
    });
    const beforeUnload = (event) => {
      if (editor?.state().dirty || parked.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    globalThis.addEventListener?.("beforeunload", beforeUnload);
    return Object.freeze({
      element: root,
      selectTab(value) {
        if (!["notes", "assets", "files"].includes(value)) return;
        if (shown && model) void changeTab(value);
        else tab = value;
      },
      setShown(value) {
        if (destroyed || shown === (value === true)) return;
        shown = value === true;
        if (shown) {
          const mine = ++epoch;
          Promise.resolve().then(() => {
            if (live(mine)) activate();
            else if (shown && !destroyed && !room) activate();
          });
        } else deactivate();
      },
      canChangeLocation: () => !editor?.state().dirty,
      canChangeFiles: () => !editor?.state().dirty,
      changed() {
        if (shown && model) void model.refresh();
      },
      accountChanged() {
        deactivate();
        room = null;
        activate();
      },
      destroy() {
        if (destroyed) return;
        deactivate();
        destroyed = true;
        off?.();
        globalThis.removeEventListener?.("beforeunload", beforeUnload);
        for (const remove2 of removers) remove2();
        root.remove();
      }
    });
  }
  var init_scratchpad_page = __esm({
    "src/renderer/web-files/scratchpad-page.js"() {
      init_globals();
      init_room_files_model();
      init_note_editor_model();
      init_cards_view();
      init_confirm_dialog();
    }
  });

  // src/renderer/web-files/scratch-index.js
  var scratch_index_exports = {};
  __export(scratch_index_exports, {
    LIMITS: () => LIMITS,
    createRoomScratchIndex: () => createRoomScratchIndex
  });
  function companion(value) {
    if (!plain(value) || !["annotations", "annotated"].includes(value.kind) || typeof value.asset_id !== "string" || !assetId.test(value.asset_id)) return null;
    return Object.freeze({
      name: text2(value.name, 255),
      kind: value.kind,
      asset_id: value.asset_id,
      size: count(value.size),
      ...typeof value.by === "string" ? { by: text2(value.by, 128) } : {}
    });
  }
  function project(value, room) {
    if (!plain(value) || value.room_id !== room || !["asset", "note"].includes(value.kind) || typeof value.id !== "string" || !value.id || value.id.length > 128 || /[\u0000-\u001f\u007f]/.test(value.id)) return null;
    const companions = [];
    if (Array.isArray(value.companions)) for (const candidate of value.companions) {
      const result = companion(candidate);
      if (result) companions.push(result);
      if (companions.length === 8) break;
    }
    const presence = typeof value.inEngine === "boolean" ? value.inEngine : null;
    return Object.freeze({
      ref: typeof value.ref === "string" && ref.test(value.ref) ? value.ref : null,
      id: value.id,
      room_id: room,
      kind: value.kind,
      name: text2(value.name, 255),
      type: text2(value.type, 255),
      size: count(value.size),
      author: text2(value.author, 128),
      created_at: timestamp(value.created_at),
      modified_at: timestamp(value.modified_at),
      version: optionalText(value.version, 64),
      inEngine: presence,
      residency: presence === true && value.residency === "local" ? "local" : "unknown",
      batch_id: typeof value.batch_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.batch_id) ? value.batch_id : null,
      companions: Object.freeze(companions),
      preview: value.kind === "note" && typeof value.preview === "string" ? value.preview.slice(0, 800) : null
    });
  }
  function createRoomScratchIndex({ roomId, request, current = () => true, signal } = {}) {
    if (!roomName(roomId) || typeof request !== "function" || typeof current !== "function") throw TypeError("Room and index transport required");
    const room = roomId, base = `/api/rooms/${encodeURIComponent(room)}/assets/index`, cursors = /* @__PURE__ */ new Map(), used = /* @__PURE__ */ new Set(), pending = /* @__PURE__ */ new Set();
    let epoch = 0, destroyed = false, revoked = false;
    function invalidate() {
      ++epoch;
      cursors.clear();
      used.clear();
      for (const controller of pending) controller.abort();
      pending.clear();
    }
    const revoke = () => {
      revoked = true;
      invalidate();
    };
    function active() {
      if (destroyed || revoked) return false;
      try {
        if (!signal?.aborted && current() === true) return true;
      } catch {
      }
      revoke();
      return false;
    }
    signal?.addEventListener("abort", revoke, { once: true });
    async function readBody(response, controller, live) {
      const reader = response.body?.getReader();
      if (!reader) throw Error("transport");
      const parts2 = [];
      let size = 0, finished = false;
      const cancel = () => {
        try {
          reader.cancel().catch(() => {
          });
        } catch {
        }
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (; ; ) {
          if (!live()) throw Error("stale");
          const { value, done } = await reader.read();
          if (!live()) throw Error("stale");
          if (done) {
            finished = true;
            break;
          }
          if (!(value instanceof Uint8Array)) throw Error("transport");
          size += value.byteLength;
          if (size > LIMITS.pageBytes) throw Error("transport");
          parts2.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts2) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        if (!finished) cancel();
        reader.releaseLock();
      }
    }
    return Object.freeze({
      async page({ cursor = null, limit = LIMITS.limitDefault } = {}) {
        if (!active()) return fail("stale");
        if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.limitMax) return fail("limit");
        const mine = epoch;
        let held = null;
        if (cursor !== null) {
          const record = cursorValue(cursor) ? cursors.get(cursor) : null;
          if (!record || record.busy || record.epoch !== mine) return fail("cursor");
          record.busy = true;
          held = record;
        }
        const controller = new AbortController();
        pending.add(controller);
        const live = () => active() && mine === epoch && !controller.signal.aborted;
        const failure2 = (why, extra) => {
          if (!live()) return fail("stale");
          if (held && cursors.get(cursor) === held) held.busy = false;
          return fail(why, extra);
        };
        try {
          if (!live()) return fail("stale");
          const query = new URLSearchParams({ scope: "room", limit: String(limit) });
          if (held) query.set("cursor", cursor);
          const response = await request(`${base}?${query}`, { method: "GET", signal: controller.signal });
          if (!live()) {
            cancelBody2(response);
            return fail("stale");
          }
          if (response?.status !== 200) {
            cancelBody2(response);
            return Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? failure2("engine", { status: response.status }) : failure2("transport");
          }
          const body = await readBody(response, controller, live);
          if (!live()) return fail("stale");
          if (!plain(body) || !Array.isArray(body.items) || body.items.length > limit || count(body.total) === null || body.total < body.items.length) return failure2("transport");
          const next = body.next_cursor === void 0 || body.next_cursor === null ? null : body.next_cursor;
          if (next !== null && (!cursorValue(next) || next === cursor || used.has(next) || cursors.get(next)?.busy)) return failure2("transport");
          const items = Object.freeze(body.items.map((value) => project(value, room)).filter(Boolean));
          if (held) {
            cursors.delete(cursor);
            used.add(cursor);
          }
          if (next !== null && !cursors.has(next)) cursors.set(next, { epoch: mine, busy: false });
          return Object.freeze({ ok: true, items, cursor: next, total: body.total });
        } catch {
          return failure2("transport");
        } finally {
          pending.delete(controller);
          if (!live()) controller.abort();
        }
      },
      // Restart pagination after a refresh/switch/hide. Consumed cursors become
      // valid again only if the engine issues them under this new view epoch.
      bump() {
        if (!destroyed) invalidate();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        signal?.removeEventListener("abort", revoke);
        invalidate();
      }
    });
  }
  var LIMITS, encoder, plain, encodable, roomName, cursorValue, text2, optionalText, count, timestamp, ref, assetId, fail, cancelBody2;
  var init_scratch_index = __esm({
    "src/renderer/web-files/scratch-index.js"() {
      init_globals();
      LIMITS = Object.freeze({ limitDefault: 50, limitMax: 200, cursorBytes: 512, pageBytes: 256 * 1024 });
      encoder = new TextEncoder();
      plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
      encodable = (value) => {
        try {
          encodeURIComponent(value);
          return true;
        } catch {
          return false;
        }
      };
      roomName = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value) && encodable(value);
      cursorValue = (value) => typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= LIMITS.cursorBytes && encodable(value);
      text2 = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
      optionalText = (value, max) => typeof value === "string" && value.length <= max ? value : null;
      count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
      timestamp = (value) => count(value) !== null && value <= 864e13 ? value : null;
      ref = /^(?:line_\d{1,12}|(?:note|asset)_[0-9a-f]{12})$/;
      assetId = /^[0-9a-f]{12}$/;
      fail = (why, extra = {}) => ({ ok: false, why, ...extra });
      cancelBody2 = (response) => {
        try {
          response?.body?.cancel().catch(() => {
          });
        } catch {
        }
      };
    }
  });

  // web/handlers/files.js
  var require_files = __commonJS({
    "web/handlers/files.js"(exports, module) {
      "use strict";
      init_globals();
      var { createFolderDirectoryLoader: createFolderDirectoryLoader2, createFolderDirectoryCreator: createFolderDirectoryCreator2 } = (init_folder_picker_client(), __toCommonJS(folder_picker_client_exports));
      var { createRoomFilesClient: createRoomFilesClient2 } = (init_room_files_client(), __toCommonJS(room_files_client_exports));
      var { createServerFolderChooser: createServerFolderChooser2 } = (init_folder_picker(), __toCommonJS(folder_picker_exports));
      var { createRoomScratchpadPage: createRoomScratchpadPage2 } = (init_scratchpad_page(), __toCommonJS(scratchpad_page_exports));
      var { sayServerAnswer } = require_server_answers();
      var { createRoomScratchIndex: createRoomScratchIndex2 } = (init_scratch_index(), __toCommonJS(scratch_index_exports));
      function register4(api) {
        if (typeof api?.engine?.fetch !== "function" || typeof api?.expose !== "function") throw TypeError("Web files bridge required");
        const request = (path, options) => api.engine.fetch(path, options);
        const chooser = createServerFolderChooser2({ load: createFolderDirectoryLoader2({ request }), createDirectory: createFolderDirectoryCreator2({ request }) });
        let context = null, selected = null, epoch = 0, offRoom = null;
        const listeners = /* @__PURE__ */ new Set(), clients = /* @__PURE__ */ new Set();
        const copy3 = () => context ? { ...context, epoch } : null;
        const publish = () => {
          for (const listener of [...listeners]) try {
            listener(copy3());
          } catch {
          }
        };
        function roomShown(value) {
          const id = value?.roomId;
          const next = typeof id === "string" && id.length > 0 && id.length <= 255 && id !== "." && id !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(id) ? { roomId: id, familyId: typeof value.familyId === "string" ? value.familyId : null, group: typeof value.group === "string" ? value.group : null, ...typeof value.roomName === "string" && value.roomName.length <= 4096 ? { roomName: value.roomName } : {} } : null;
          if (JSON.stringify(next) === JSON.stringify(context)) return;
          context = next;
          if (next) selected = next;
          ++epoch;
          const old = [...clients];
          clients.clear();
          for (const client of old) client.destroy();
          publish();
        }
        const marks = /* @__PURE__ */ new Map();
        function hasMarks(roomId, name2) {
          if (typeof roomId !== "string" || !roomId || roomId.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(roomId) || typeof name2 !== "string" || !name2 || name2.length > 240 || /[\\/\u0000-\u001f\u007f]/.test(name2)) return Promise.resolve(false);
          const key = roomId + "\n" + name2;
          if (marks.has(key)) return marks.get(key);
          if (marks.size >= 500) marks.delete(marks.keys().next().value);
          const answer2 = (async () => {
            try {
              const r = await request("/api/rooms/" + encodeURIComponent(roomId) + "/assets/raw/" + encodeURIComponent(name2 + ".annotations.svg"), { method: "GET", headers: { accept: "image/svg+xml" } });
              try {
                await r.body?.cancel?.();
              } catch {
              }
              return r.status === 200;
            } catch {
              marks.delete(key);
              return false;
            }
          })();
          marks.set(key, answer2);
          return answer2;
        }
        const files = Object.freeze({
          hasMarks,
          roomShown,
          roomState: copy3,
          serverAnswer: sayServerAnswer,
          subscribeRoom(listener) {
            if (typeof listener !== "function") throw TypeError("Room listener required");
            listeners.add(listener);
            try {
              listener(selected ? { ...selected, epoch } : null);
            } catch {
            }
            return () => listeners.delete(listener);
          },
          createPage: (options) => {
            if (!offRoom) offRoom = globalThis.wb?.web?.events?.on("room-shown", roomShown) || null;
            return createRoomScratchpadPage2({ ...options, files });
          },
          chooseFolder: (options) => chooser.choose(options),
          async pickFolder(initial = null, options = {}) {
            const result = await chooser.choose({ ...options, initialPath: typeof initial === "string" ? initial : null });
            if (result.ok) return result.path;
            if (["cancelled", "changed"].includes(result.code)) return null;
            throw Object.assign(Error("Couldn't list the folders. Try again."), { code: result.code });
          },
          dispose: () => {
            marks.clear();
            chooser.dispose();
            roomShown(null);
            selected = null;
            offRoom?.();
            offRoom = null;
            listeners.clear();
          },
          directoryLoader: ({ current } = {}) => createFolderDirectoryLoader2({ request, current }),
          index: (roomId, { current = () => true, signal } = {}) => {
            const captured = epoch, reader = createRoomScratchIndex2({ roomId, request, signal, current: () => captured === epoch && selected?.roomId === roomId && current() === true });
            const wrapped = Object.freeze({ ...reader, destroy() {
              clients.delete(wrapped);
              reader.destroy();
            } });
            clients.add(wrapped);
            return wrapped;
          },
          room: (roomId, { current = () => true, signal } = {}) => {
            const captured = epoch, client = createRoomFilesClient2({ roomId, request, signal, current: () => captured === epoch && selected?.roomId === roomId && current() === true });
            const wrapped = Object.freeze({ ...client, destroy() {
              clients.delete(wrapped);
              client.destroy();
            } });
            clients.add(wrapped);
            return wrapped;
          }
        });
        api.expose("files", files);
      }
      module.exports = { register: register4 };
    }
  });

  // src/module-cards.js
  var require_module_cards = __commonJS({
    "src/module-cards.js"(exports, module) {
      "use strict";
      init_globals();
      var MAX_CARDS = 2;
      var CARD_ID = /^[a-z][a-z0-9-]{0,23}$/;
      var KINDS = /* @__PURE__ */ new Set(["room-tasks"]);
      var MAX_ROOM = 128;
      function createCardAdmission2(deps) {
        const wins = /* @__PURE__ */ new Map();
        let seq = 0;
        const entryOf = (id) => deps.catalog().find((m) => m.id === id) || null;
        const allowed = (m) => !!m && m.source === "bundled" && m.enabled === true && !m.error && m.class === "tool" && !!m.tool && Array.isArray(m.tool.contexts) && m.tool.contexts.includes("workroom") && Array.isArray(m.permissions) && m.permissions.includes("ui.railCard");
        const current = (rec, moduleId) => {
          const a = deps.account() || {};
          return rec.accountId === a.accountId && rec.selectionVersion === a.selectionVersion && rec.gen === deps.moduleGen(moduleId) && allowed(entryOf(moduleId)) && deps.roomKnown(rec.roomId);
        };
        const sorted = (cards) => [...cards].sort((x, y) => (x.kind === "room-tasks" ? 0 : 1) - (y.kind === "room-tasks" ? 0 : 1) || x.seq - y.seq);
        const refuse = (why) => ({ ok: false, why });
        return Object.freeze({
          /** {moduleId, cardId, kind, roomId} from the app page. → {ok, seq, kind} | {ok:false, why}. */
          admit(winId, a) {
            const moduleId = a && typeof a.moduleId === "string" ? a.moduleId : "";
            const m = entryOf(moduleId);
            if (!allowed(m)) return refuse("not a bundled workroom tool with ui.railCard");
            const cardId = a.cardId;
            if (typeof cardId !== "string" || !CARD_ID.test(cardId)) return refuse("a card id is a-z, digits and dashes, at most 24");
            const kind = a.kind === void 0 || a.kind === null ? null : a.kind;
            if (kind !== null && !KINDS.has(kind)) return refuse("unknown card kind");
            const roomId = typeof a.roomId === "string" && a.roomId.length <= MAX_ROOM ? a.roomId : "";
            if (!roomId || !deps.roomKnown(roomId)) return refuse("no such room here");
            if (kind === "room-tasks") {
              if (!m.permissions.includes("rooms.tasks.read")) return refuse("room-tasks needs rooms.tasks.read");
              if (!deps.roomTasksPanel(roomId)) return refuse("no Room Tasks panel in this room");
            }
            const acct = deps.account() || {};
            let mods = wins.get(winId);
            if (!mods) wins.set(winId, mods = /* @__PURE__ */ new Map());
            let rec = mods.get(moduleId);
            if (!rec || rec.roomId !== roomId || !current(rec, moduleId)) {
              rec = { roomId, gen: deps.moduleGen(moduleId), accountId: acct.accountId, selectionVersion: acct.selectionVersion, cards: [] };
              mods.set(moduleId, rec);
            }
            const others = rec.cards.filter((c) => c.cardId !== cardId);
            if (others.length >= MAX_CARDS) return refuse("a module has at most two rail cards");
            const card = { cardId, kind, seq: ++seq };
            rec.cards = [...others, card];
            return { ok: true, seq: card.seq, kind };
          },
          /** Forget exactly one admission: the card id AND the sequence it was admitted with (an old release never removes
           *  a fresh admission of the same id, a builder ). */
          release(winId, a) {
            const rec = wins.get(winId)?.get(a && a.moduleId);
            if (!rec || !a || !Number.isSafeInteger(a.seq)) return;
            rec.cards = rec.cards.filter((c) => !(c.cardId === a.cardId && c.seq === a.seq));
          },
          /** Is this card admitted, now, for this window, module and room? */
          isAdmitted(winId, a) {
            const rec = wins.get(winId)?.get(a && a.moduleId);
            return !!rec && rec.roomId === (a && a.roomId) && current(rec, a.moduleId) && rec.cards.some((c) => c.cardId === a.cardId);
          },
          /** The module's admitted cards, in main's order (room-tasks first, then registration). */
          admitted(winId, moduleId) {
            const rec = wins.get(winId)?.get(moduleId);
            return rec && current(rec, moduleId) ? sorted(rec.cards).map((c) => ({ ...c })) : [];
          },
          /** After any change main makes (account, selection, a module scan or setting, the rooms cache): drop what went stale. */
          checkAll() {
            for (const mods of wins.values()) for (const [moduleId, rec] of mods) if (!current(rec, moduleId)) mods.delete(moduleId);
          },
          windowGone(winId) {
            wins.delete(winId);
          }
        });
      }
      module.exports = { createCardAdmission: createCardAdmission2, MAX_CARDS };
    }
  });

  // web/handlers/modules.js
  var modules_exports = {};
  __export(modules_exports, {
    APP_MISSING_TEXT: () => APP_MISSING_TEXT,
    APP_MISSING_TITLE: () => APP_MISSING_TITLE,
    appMissingNotice: () => appMissingNotice,
    createModulesHandlers: () => createModulesHandlers,
    register: () => register3
  });
  function createModulesHandlers(deps) {
    let engine = null;
    let pluginsOn = null;
    const settings2 = /* @__PURE__ */ new Map();
    let catalog = [];
    let roles = null;
    function merged() {
      const boot = Array.isArray(deps.boot()) ? deps.boot() : [];
      const ids = new Set(boot.map((b) => b.id));
      return catalog = [...boot.map((b) => {
        const s = settings2.has(b.id) ? settings2.get(b.id) : b.settings || {};
        if (!engine) return { ...b, settings: s };
        const e = engine.get(b.id);
        if (!e) return { ...b, settings: s, enabled: b.core === true, error: b.core === true ? b.error ?? null : OFF_HERE, missing: true };
        return { ...b, settings: s, enabled: b.core === true ? !e.error : e.enabled === true, error: e.error || b.error || null };
      }), ...pluginRows.filter((r) => !ids.has(r.id))];
    }
    let pluginRows = [];
    const PLUGIN_ID = /^[a-z][a-z0-9-]{0,40}$/;
    const PLUGIN_ENTRY = /^ui\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.html$/;
    function takeEngine(list) {
      engine = /* @__PURE__ */ new Map();
      pluginRows = [];
      for (const v of list) {
        if (!v || typeof v.id !== "string") continue;
        engine.set(v.id, { enabled: v.enabled === true, error: typeof v.error === "string" && v.error ? v.error : null });
        if (v.source === "plugin" && PLUGIN_ID.test(v.id)) {
          pluginRows.push({
            id: v.id,
            name: String(v.name || v.id).slice(0, 60),
            version: String(v.version || ""),
            class: typeof v.class === "string" ? v.class : "",
            source: "plugin",
            parent: null,
            icon: "extension",
            core: false,
            main: null,
            settingsSchema: null,
            description: "",
            entry: typeof v.entry === "string" && PLUGIN_ENTRY.test(v.entry) ? v.entry : null,
            permissions: Array.isArray(v.permissions) ? v.permissions.filter((x) => typeof x === "string") : [],
            tool: Array.isArray(v.contexts) ? { contexts: v.contexts.filter((x) => typeof x === "string"), role: typeof v.role === "string" ? v.role : null } : null,
            url: "/app/plugins/" + v.id + "/",
            enabled: v.enabled === true,
            error: typeof v.error === "string" && v.error ? v.error : null,
            settings: {}
          });
        }
      }
    }
    merged();
    const cards = deps.makeCards({
      catalog: () => catalog,
      moduleGen: (id) => catalog.find((m) => m.id === id)?.gen ?? 0,
      account: () => deps.account(),
      roomKnown: (roomId) => deps.roomKnown(roomId),
      roomTasksPanel: () => false
    });
    async function modulesList() {
      try {
        const r = await deps.request("GET", "/api/modules");
        if (r.status !== 200 || !isList(r.json)) return null;
        takeEngine(r.json.modules);
        if (r.json.plugins && typeof r.json.plugins.enabled === "boolean") pluginsOn = r.json.plugins.enabled;
        return merged();
      } catch {
        return null;
      }
    }
    function taskCall(a) {
      if (!a || typeof a !== "object" || typeof a.moduleId !== "string" || !ID.test(a.moduleId)) return null;
      if (typeof a.verb !== "string" || !a.verb || a.verb.length > 40) return null;
      if (typeof a.roomId !== "string" || !a.roomId || a.roomId.length > 128) return null;
      return "/api/modules/" + a.moduleId + "/rooms/" + encodeURIComponent(a.roomId) + "/tasks";
    }
    return Object.freeze({
      /** The engine's catalog merged (null: it did not answer). */
      modulesList,
      catalog: () => catalog,
      /** Whether this server takes plugin installs: true, false, or null when the engine has not said. */
      pluginsEnabled: () => pluginsOn,
      /** A person turns a module on or off (PUT .../enabled), or changes its settings (kept in the page). → the list. */
      async moduleSet(p) {
        if (!p || typeof p.id !== "string" || !ID.test(p.id) || !catalog.some((m) => m.id === p.id)) return catalog;
        if (p.settings && typeof p.settings === "object" && !Array.isArray(p.settings)) settings2.set(p.id, p.settings);
        if (typeof p.enabled === "boolean") {
          try {
            const r = await deps.request("PUT", "/api/modules/" + p.id + "/enabled", { enabled: p.enabled });
            if (r.status === 200 && r.json && r.json.id === p.id && engine) {
              engine.set(p.id, { enabled: r.json.enabled === true, error: typeof r.json.error === "string" && r.json.error ? r.json.error : null });
              return merged();
            }
          } catch {
          }
          return await modulesList() || merged();
        }
        return merged();
      },
      modulesRescan: async () => {
        const list = await modulesList();
        if (list) appMissingNotice(list);
        return list || merged();
      },
      async moduleStorage(p) {
        if (!p || typeof p.id !== "string" || !ID.test(p.id)) return { ok: false, error: "no such module" };
        const op = String(p.op || "");
        if (!STORAGE_OPS.has(op)) return { ok: false, error: "unknown storage op: " + op.slice(0, 20) };
        const base = "/api/modules/" + p.id + "/storage";
        if (op !== "list" && (typeof p.key !== "string" || !STORAGE_NAME.test(p.key) || p.key === "." || p.key === "..")) {
          return { ok: false, error: "a storage key is a plain name (letters, digits, dot, dash, underscore)" };
        }
        try {
          if (op === "list") {
            const r2 = await deps.request("GET", base);
            return r2.status === 200 && r2.json && Array.isArray(r2.json.names) ? { ok: true, keys: r2.json.names, files: [] } : { ok: false, error: words(r2.json, "The server refused that.") };
          }
          const path = base + "/" + encodeURIComponent(p.key);
          if (op === "get") {
            const r2 = await deps.request("GET", path);
            if (r2.status === 404 && r2.json && r2.json.field === "name") return { ok: true, value: null };
            if (r2.status !== 200 || !r2.json || typeof r2.json.value !== "string") return { ok: false, error: words(r2.json, "The server refused that.") };
            try {
              return { ok: true, value: JSON.parse(r2.json.value) };
            } catch {
              return { ok: true, value: null };
            }
          }
          if (op === "delete") {
            const r2 = await deps.request("DELETE", path);
            return r2.status === 200 ? { ok: true } : { ok: false, error: words(r2.json, "The server refused that.") };
          }
          const r = await deps.request("PUT", path, { value: JSON.stringify(p.value === void 0 ? null : p.value) });
          return r.status === 200 ? { ok: true } : { ok: false, error: words(r.json, "The server refused that.") };
        } catch {
          return { ok: false, error: DOWN };
        }
      },
      /** The page's guard before it sets a module frame's src (module-frame.js `declare`): this origin, an enabled
       *  catalog module under its own prefix (bundled /app/modules, plugin /app/plugins), a ui/ page, a load nonce.
       *  The engine's M1 route applies the real path rules and the sandbox CSP whatever this says. */
      moduleFrameExpect(p) {
        let u;
        try {
          u = new URL(p && p.url, deps.origin);
        } catch {
          return false;
        }
        if (u.origin !== deps.origin || !u.searchParams.get("wbl")) return false;
        const m = UI_PAGE.exec(u.pathname);
        if (!m || m[3].split("/").some((s) => s === "." || s === ".." || /^\.|\.\./.test(s))) return false;
        const e = catalog.find((x) => x.id === m[2]);
        return !!e && e.enabled === true && !e.error && e.source === (m[1] === "plugins" ? "plugin" : "bundled");
      },
      moduleCardAdmit: async (p) => cards.admit(WIN, { moduleId: p && p.moduleId, cardId: p && p.cardId, kind: p && p.kind, roomId: p && p.roomId }),
      async moduleCardRelease(p) {
        const seq = p && Number.isSafeInteger(p.seq) && p.seq > 0 ? p.seq : null;
        if (seq !== null) cards.release(WIN, { moduleId: p.moduleId, cardId: p.cardId, seq });
        return { ok: true };
      },
      /** Theme roles for pop-outs (desktop: main kept them for module windows). Nothing leaves the page. */
      moduleTheme(r) {
        roles = r && typeof r === "object" ? r : null;
      },
      themeRoles: () => roles,
      async roomsTasks(a) {
        const path = taskCall(a);
        if (!path) return refused(400, "Not a Tasks call.", "input");
        const body = { verb: a.verb, input: a.input === void 0 ? {} : a.input };
        if (a.approval !== void 0) body.approval = a.approval;
        try {
          const r = await deps.request("POST", path, body);
          if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, body: r.json === void 0 ? null : r.json };
          if (r.status === 429) return { ok: false, kind: "slow" };
          if (r.status >= 400 && r.status < 500) {
            const j = r.json && typeof r.json === "object" ? r.json : {};
            return refused(r.status, words(j, "The room refused that."), typeof j.field === "string" ? j.field.slice(0, 40) : null);
          }
          return TRANSPORT;
        } catch {
          return TRANSPORT;
        }
      },
      async roomsTasksApprove(a) {
        const path = taskCall(a);
        if (!path) return { ok: false, kind: "refused", status: 400 };
        try {
          const r = await deps.request("POST", path + "/approve", { verb: a.verb, input: a.input === void 0 ? {} : a.input });
          if (r.status === 200 && r.json && typeof r.json.approval === "string") return { ok: true, approval: r.json.approval };
          return { ok: false, kind: "refused", status: r.status };
        } catch {
          return TRANSPORT;
        }
      },
      /** An engine stream event → [wb channel, payload] for the page's wb.on bus, or null when it is not ours. */
      engineEvent(name2, payload) {
        if (name2 === "modules.changed") {
          if (isList(payload)) takeEngine(payload.modules);
          return ["modules:changed", merged()];
        }
        if (name2 === "rooms.tasks" && payload && typeof payload.roomId === "string") {
          return ["rooms:tasks", { roomId: payload.roomId, familyId: typeof payload.familyId === "string" ? payload.familyId : null }];
        }
        return null;
      }
    });
  }
  function register3(api) {
    const request = async (method, path, body) => {
      const init = { method, headers: { accept: "application/json" } };
      if (body !== void 0) {
        init.body = JSON.stringify(body);
        init.headers["content-type"] = "application/json";
      }
      const res = await api.engine.fetch(path, init);
      let json2 = null;
      try {
        json2 = await res.json();
      } catch {
        json2 = null;
      }
      return { status: res.status, json: json2 };
    };
    const pageBase = new URL("./", globalThis.location ? globalThis.location.href : "http://localhost/");
    const boot = () => ((globalThis.__WB_WEB__ || {}).modules || []).map((m) => ({ ...m, url: new URL(m.url, pageBase).href, enabled: m.core ? true : m.defaultEnabled, settings: {} }));
    const h = createModulesHandlers({
      request,
      boot,
      origin: globalThis.location ? globalThis.location.origin : "",
      makeCards: (deps) => (0, import_module_cards.createCardAdmission)(deps),
      account: () => ({ accountId: null, selectionVersion: 0 }),
      // one person per server, no accounts
      // a card carries no data (the engine admits every call behind it); the page draws cards only for the room it
      // shows, so any room id it names is the shown room
      roomKnown: (roomId) => typeof roomId === "string" && roomId.length > 0 && roomId.length <= 128
    });
    const told = (list) => {
      if (Array.isArray(list)) api.emit("modules:changed", list);
      return list;
    };
    api.handle("modules:set", async ([p]) => told(await h.moduleSet(p)));
    api.handle("modules:rescan", async () => told(await h.modulesRescan()));
    api.handle("modules:storage", ([p]) => h.moduleStorage(p));
    api.handle("modules:frame-expect", ([p]) => h.moduleFrameExpect(p));
    api.handle("modules:card-admit", ([p]) => h.moduleCardAdmit(p));
    api.handle("modules:card-release", ([p]) => h.moduleCardRelease(p));
    api.handle("modules:window-open", async () => ({ ok: false, kind: "refused", status: 501, error: "Opening a tool in its own window comes later in the web app.", field: null }));
    rt.removeHandler("rooms:tasks");
    rt.removeHandler("rooms:tasks-approve");
    api.handle("rooms:tasks", (args) => h.roomsTasks(roomsArg(args)));
    api.handle("rooms:tasks-approve", (args) => h.roomsTasksApprove(roomsArg(args)));
    api.expose("modulesPluginsEnabled", () => h.pluginsEnabled());
    api.expose("modulesEngineEvent", (name2, payload) => {
      const out = h.engineEvent(name2, payload);
      if (out) api.emit(out[0], out[1]);
      return !!out;
    });
    const ready = () => !!(globalThis.document && document.documentElement && document.documentElement.getAttribute("data-wb-web") === "ready");
    const whenReady = (fn) => {
      if (ready()) {
        fn();
        return;
      }
      if (typeof MutationObserver !== "function" || !globalThis.document) return;
      const mo = new MutationObserver(() => {
        if (ready()) {
          mo.disconnect();
          fn();
        }
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-wb-web"] });
    };
    void h.modulesList().then((list) => {
      if (!list) return;
      appMissingNotice(list);
      api.emit("modules:changed", list);
      whenReady(() => api.emit("modules:changed", h.catalog()));
    });
  }
  function appMissingNotice(list, doc = globalThis.document) {
    if (!doc || !doc.body || !Array.isArray(list)) return;
    const lost = list.some((m) => m && m.id === "workrooms" && m.missing === true);
    let box = doc.getElementById("wbAppMissing");
    if (!lost) {
      if (box) box.remove();
      return;
    }
    if (box) return;
    const make = (tag, cls, text3) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text3) e.textContent = text3;
      return e;
    };
    box = make("div", "wb-appmissing");
    box.id = "wbAppMissing";
    box.setAttribute("role", "alert");
    const card = make("div", "wb-appmissing-card");
    const again = make("button", "wb-appmissing-reload", "Reload");
    again.type = "button";
    again.addEventListener("click", () => globalThis.location.reload());
    card.append(make("h1", null, APP_MISSING_TITLE), make("p", null, APP_MISSING_TEXT), again);
    box.append(card);
    doc.body.append(box);
  }
  var import_module_cards, rt, ID, STORAGE_OPS, STORAGE_NAME, UI_PAGE, WIN, DOWN, OFF_HERE, refused, TRANSPORT, words, isList, roomsArg, APP_MISSING_TITLE, APP_MISSING_TEXT;
  var init_modules = __esm({
    "web/handlers/modules.js"() {
      init_globals();
      import_module_cards = __toESM(require_module_cards());
      rt = __toESM(require_runtime());
      ID = /^[a-z][a-z0-9-]{0,40}$/;
      STORAGE_OPS = /* @__PURE__ */ new Set(["get", "set", "list", "delete"]);
      STORAGE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
      UI_PAGE = /^\/app\/(modules|plugins)\/([a-z][a-z0-9-]{0,40})\/ui\/((?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.html)$/;
      WIN = "page";
      DOWN = "The server did not answer.";
      OFF_HERE = "This tool is not on this server.";
      refused = (status, error2, field) => ({ ok: false, kind: "refused", status, error: error2, field: field || null });
      TRANSPORT = Object.freeze({ ok: false, kind: "transport" });
      words = (j, fallback) => j && typeof j.error === "string" && j.error ? (typeof j.message === "string" && j.message ? j.message : j.error).slice(0, 300) : fallback;
      isList = (j) => !!j && Array.isArray(j.modules);
      roomsArg = (args) => args && args[0] && Array.isArray(args[0].args) ? args[0].args[0] : void 0;
      APP_MISSING_TITLE = "This server can't run Agent Workbench yet";
      APP_MISSING_TEXT = "The app's own tools aren't on this server, so Workrooms can't open. Whoever runs the server should point HARBOR_WB_APP_DIR at this app's built folder, then reload this page.";
    }
  });

  // src/renderer/web-notifications/view.js
  var view_exports3 = {};
  __export(view_exports3, {
    notificationSummary: () => notificationSummary,
    renderBrowserNotifications: () => renderBrowserNotifications
  });
  function notificationSummary(notify = {}, status = "granted") {
    const toast = notify.toast === true && status === "granted";
    return toast ? "Notification" : "Off";
  }
  function renderBrowserNotifications(sec, prefs, setPrefs, { browser = globalThis, actions = browser.wb.web.browserActions } = {}) {
    const token = {};
    owners.set(sec, token);
    sec.textContent = "";
    const n = { flash: true, toast: false, ...prefs.notify };
    let pending = false;
    const current = () => owners.get(sec) === token && browser.document.hidden !== true && sec.isConnected && !sec.closest?.("[hidden]");
    const el = (tag, cls, text3) => {
      const node = browser.document.createElement(tag);
      node.className = cls || "";
      if (text3 !== void 0) node.textContent = text3;
      return node;
    };
    const state = () => {
      try {
        return actions.notificationStatus();
      } catch {
        return "unavailable";
      }
    };
    const row = (key, label, hint) => {
      const r = el("div", "pg-row"), tx = el("span", "pg-tx");
      tx.append(el("b", "", label));
      if (hint) tx.append(el("small", "", hint));
      const button = el("button", "pg-sw" + (n[key] ? " on" : ""));
      button.type = "button";
      button.id = "notify-" + key;
      button.setAttribute("role", "switch");
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-checked", String(n[key]));
      r.append(tx, button);
      sec.append(r);
      return button;
    };
    sec.append(el("div", "pg-sub", "When an agent or terminal needs you and this tab isn't in front"));
    const toast = row("toast", "Show a browser notification", "One per CLI, with its name and where it runs. Never what's in the terminal.");
    const message = el("p", "wb-notification-message");
    message.setAttribute("role", "status");
    sec.append(message);
    const ask = el("section", "wb-notification-ask");
    ask.setAttribute("aria-label", "Browser notifications");
    ask.append(el("b", "", "Get a notification when an agent needs you?"), el("p", "", "Your browser will ask once. Notifications never include what's in a terminal."));
    const later = el("button", "wb-notification-dismiss", "Not now"), enable = el("button", "wb-notification-enable", "Turn on notifications");
    later.type = enable.type = "button";
    ask.append(later, enable);
    sec.append(ask);
    function paint() {
      const status = state(), secure = browser.isSecureContext === true;
      const on = status === "granted" && n.toast === true;
      toast.setAttribute("aria-checked", String(on));
      toast.classList.toggle("on", on);
      toast.disabled = pending || !secure || status === "denied" || status === "unavailable";
      enable.disabled = pending;
      ask.hidden = !secure || status !== "default";
      message.textContent = !secure ? HTTPS2 : status === "denied" ? BLOCKED2 : status === "unavailable" ? "Notifications aren't available in this browser." : "";
      message.hidden = !message.textContent;
    }
    async function turnOn() {
      if (pending || !current() || browser.isSecureContext !== true || !["default", "granted"].includes(state())) return;
      pending = true;
      paint();
      try {
        const status = state() === "granted" ? "granted" : await actions.requestNotifications();
        if (!current()) return;
        if (status === "granted") await setPrefs({ notify: { ...n, toast: true } });
      } catch {
      } finally {
        if (current()) {
          pending = false;
          paint();
        }
      }
    }
    toast.addEventListener("click", () => {
      if (!current() || toast.disabled) return;
      if (n.toast && state() === "granted") void setPrefs({ notify: { ...n, toast: false } });
      else void turnOn();
    });
    enable.addEventListener("click", turnOn);
    later.addEventListener("click", () => {
      ask.hidden = true;
    });
    paint();
    return { dispose() {
      if (owners.get(sec) === token) owners.delete(sec);
    } };
  }
  var owners, BLOCKED2, HTTPS2;
  var init_view3 = __esm({
    "src/renderer/web-notifications/view.js"() {
      init_globals();
      owners = /* @__PURE__ */ new WeakMap();
      BLOCKED2 = "Notifications are blocked for this site. Allow them in your browser's site settings, then reload.";
      HTTPS2 = "Notifications need a secure (https) address, and this one isn't. They can't be turned on here.";
    }
  });

  // web/handlers/notifications.js
  var require_notifications = __commonJS({
    "web/handlers/notifications.js"(exports, module) {
      "use strict";
      init_globals();
      var { renderBrowserNotifications: renderBrowserNotifications2, notificationSummary: notificationSummary2 } = (init_view3(), __toCommonJS(view_exports3));
      function register4(api, { browser = globalThis } = {}) {
        api.expose("notifications", Object.freeze({
          render: (sec, prefs, setPrefs) => renderBrowserNotifications2(sec, prefs, setPrefs, { browser }),
          summary: (notify) => {
            let status = "unavailable";
            try {
              status = browser.wb.web.browserActions.notificationStatus();
            } catch {
            }
            return notificationSummary2(notify, status);
          }
        }));
      }
      module.exports = { register: register4 };
    }
  });

  // vendors/claude-code/vendor.json
  var require_vendor = __commonJS({
    "vendors/claude-code/vendor.json"(exports, module) {
      module.exports = {
        id: "claude-code",
        label: "Claude Code",
        binary: "claude",
        mark: "claude",
        color: "#D97757",
        installUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
        install: {
          win32: "npm install -g @anthropic-ai/claude-code",
          darwin: "npm install -g @anthropic-ai/claude-code",
          linux: "npm install -g @anthropic-ai/claude-code"
        },
        seamVersion: 1,
        verifiedWith: "2.1",
        resumable: true,
        settings: {
          model: {
            type: "choice",
            label: "Default model",
            options: [
              "opus",
              "sonnet",
              "haiku"
            ],
            labels: [
              "Opus",
              "Sonnet",
              "Haiku"
            ],
            default: "opus",
            other: true
          },
          extraArgs: {
            type: "args",
            label: "Extra arguments",
            hint: "Added to every launch, like --verbose",
            default: ""
          }
        },
        prepare: true
      };
    }
  });

  // vendors/codex-cli/vendor.json
  var require_vendor2 = __commonJS({
    "vendors/codex-cli/vendor.json"(exports, module) {
      module.exports = {
        id: "codex-cli",
        label: "Codex CLI",
        binary: "codex",
        mark: "codex",
        color: "#10A37F",
        installUrl: "https://github.com/openai/codex",
        install: {
          win32: "npm install -g @openai/codex",
          darwin: "npm install -g @openai/codex",
          linux: "npm install -g @openai/codex"
        },
        seamVersion: 1,
        verifiedWith: "0.1",
        resumable: false,
        settings: {
          model: {
            type: "choice",
            label: "Default model",
            options: [
              "gpt-5"
            ],
            labels: [
              "GPT-5"
            ],
            default: "gpt-5",
            other: true
          },
          extraArgs: {
            type: "args",
            label: "Extra arguments",
            hint: "Added to every launch, like --verbose",
            default: ""
          }
        }
      };
    }
  });

  // vendors/gemini-cli/vendor.json
  var require_vendor3 = __commonJS({
    "vendors/gemini-cli/vendor.json"(exports, module) {
      module.exports = {
        id: "gemini-cli",
        label: "Gemini CLI",
        binary: "gemini",
        mark: "gemini",
        color: "#4285F4",
        installUrl: "https://github.com/google-gemini/gemini-cli",
        install: {
          win32: "npm install -g @google/gemini-cli",
          darwin: "npm install -g @google/gemini-cli",
          linux: "npm install -g @google/gemini-cli"
        },
        seamVersion: 1,
        verifiedWith: "0.1",
        resumable: false,
        settings: {
          model: {
            type: "choice",
            label: "Default model",
            options: [
              "gemini-2.5-pro",
              "gemini-2.5-flash"
            ],
            labels: [
              "2.5 Pro",
              "2.5 Flash"
            ],
            default: "gemini-2.5-pro",
            other: true
          },
          extraArgs: {
            type: "args",
            label: "Extra arguments",
            hint: "Added to every launch, like --verbose",
            default: ""
          }
        }
      };
    }
  });

  // vendors/ollama/vendor.json
  var require_vendor4 = __commonJS({
    "vendors/ollama/vendor.json"(exports, module) {
      module.exports = {
        id: "ollama",
        label: "Ollama",
        binary: "ollama",
        mark: "generic",
        color: "#6B6B6B",
        installUrl: "https://ollama.com/download",
        install: {
          win32: "winget install Ollama.Ollama",
          darwin: "brew install ollama",
          linux: "curl -fsSL https://ollama.com/install.sh | sh"
        },
        seamVersion: 1,
        verifiedWith: "0.5",
        resumable: false,
        settings: {
          model: {
            type: "choice",
            label: "Default model",
            options: [
              "llama3.2",
              "qwen2.5-coder"
            ],
            labels: [
              "Llama 3.2",
              "Qwen 2.5 Coder"
            ],
            default: "llama3.2",
            other: true
          },
          extraArgs: {
            type: "args",
            label: "Extra arguments",
            hint: "Added to every launch, like --verbose",
            default: ""
          }
        }
      };
    }
  });

  // vendors/shell/vendor.json
  var require_vendor5 = __commonJS({
    "vendors/shell/vendor.json"(exports, module) {
      module.exports = {
        id: "shell",
        label: "Shell",
        binary: "",
        mark: "generic",
        color: "#5F6368",
        installUrl: "",
        seamVersion: 1,
        verifiedWith: "",
        resumable: false,
        settings: {}
      };
    }
  });

  // web/handlers/prefs-programs.js
  var require_prefs_programs = __commonJS({
    "web/handlers/prefs-programs.js"(exports, module) {
      "use strict";
      init_globals();
      var SEAM = [
        require_vendor(),
        require_vendor2(),
        require_vendor3(),
        require_vendor4(),
        require_vendor5()
      ];
      var ORDER = ["claude-code", "codex-cli", "gemini-cli", "ollama", "shell"];
      var PREFS_KEY = "wb-web.prefs.v1";
      var PROGRAMS_KEY = "wb-web.programs.v1";
      var SHELL_MAX = 300;
      function makeStore(win = globalThis) {
        const mem = /* @__PURE__ */ new Map();
        const ls = () => {
          try {
            return win.localStorage || null;
          } catch (e) {
            return null;
          }
        };
        return {
          read(key) {
            const s = ls();
            try {
              const raw = mem.has(key) ? mem.get(key) : s ? s.getItem(key) : null;
              const v = raw ? JSON.parse(raw) : null;
              return v && typeof v === "object" && !Array.isArray(v) ? v : {};
            } catch (e) {
              return {};
            }
          },
          write(key, value) {
            const text3 = JSON.stringify(value);
            const s = ls();
            try {
              if (s) {
                s.setItem(key, text3);
                mem.delete(key);
              } else mem.set(key, text3);
            } catch (e) {
              mem.set(key, text3);
            }
          }
        };
      }
      function catalog() {
        return SEAM.slice().sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)).map((m) => ({
          id: String(m.id),
          label: String(m.label || m.id).slice(0, 60),
          binary: typeof m.binary === "string" ? m.binary : "",
          mark: typeof m.mark === "string" ? m.mark : "generic",
          color: typeof m.color === "string" ? m.color : "#5F6368",
          installUrl: typeof m.installUrl === "string" ? m.installUrl : "",
          install: m.install && typeof m.install === "object" ? m.install.linux || m.install.default || null : null,
          verifiedWith: String(m.verifiedWith || ""),
          resumable: m.resumable === true,
          settings: m.settings && typeof m.settings === "object" ? m.settings : {}
        }));
      }
      function register4(api) {
        const store = api.store || makeStore();
        const programs = catalog();
        const byId = (id) => programs.find((p) => p.id === id) || null;
        function prefs() {
          const saved = store.read(PREFS_KEY);
          return {
            notify: { flash: true, toast: false, ...saved.notify && typeof saved.notify === "object" ? { flash: !!saved.notify.flash, toast: !!saved.notify.toast } : {} },
            hints: saved.hints && typeof saved.hints === "object" ? { ...saved.hints } : {},
            shell: "",
            developer: saved.developer === true,
            conciergeRecipe: null,
            conciergeRemember: true,
            conciergeReload: false,
            conciergeReloadMin: 5,
            conciergeReloadPaused: false,
            conciergeScope: { accountId: null, selectionVersion: 0 }
          };
        }
        api.handle("prefs:get", async () => prefs());
        api.handle("prefs:set", async ([p]) => {
          if (!p || typeof p !== "object") return { error: "account-changed" };
          const saved = store.read(PREFS_KEY);
          if (p.notify && typeof p.notify === "object") saved.notify = { flash: !!p.notify.flash, toast: !!p.notify.toast };
          if (p.hints && typeof p.hints === "object") saved.hints = { ...saved.hints || {}, ...Object.fromEntries(Object.entries(p.hints).filter(([k, v]) => /^[A-Za-z0-9_.-]{1,60}$/.test(k) && typeof v === "boolean")) };
          if (typeof p.developer === "boolean") saved.developer = p.developer;
          store.write(PREFS_KEY, saved);
          const now = prefs();
          api.emit("prefs:changed", now);
          return now;
        });
        function list() {
          const saved = store.read(PROGRAMS_KEY);
          return programs.map((p) => {
            const c = saved[p.id] && typeof saved[p.id] === "object" ? saved[p.id] : {};
            const set = c.settings && typeof c.settings === "object" ? c.settings : {};
            const settings2 = {};
            for (const [k, f] of Object.entries(p.settings)) settings2[k] = set[k] !== void 0 && set[k] !== "" ? set[k] : f.default;
            return {
              id: p.id,
              label: p.label,
              mark: p.mark,
              color: p.color,
              shipped: true,
              error: null,
              enabled: p.id === "shell" ? true : typeof c.enabled === "boolean" ? c.enabled : true,
              resumable: p.resumable,
              resumeError: null,
              verifiedWith: p.verifiedWith,
              binary: p.binary,
              schema: p.settings,
              settings: settings2,
              detected: null,
              installUrl: p.installUrl,
              install: p.install,
              prepare: false
            };
          });
        }
        api.handle("programs:list", async () => list());
        api.handle("programs:set", async ([p]) => {
          if (!p || typeof p.id !== "string" || !byId(p.id)) return list();
          const saved = store.read(PROGRAMS_KEY);
          const c = saved[p.id] && typeof saved[p.id] === "object" ? saved[p.id] : {};
          if (typeof p.enabled === "boolean" && p.id !== "shell") c.enabled = p.enabled;
          if (p.settings && typeof p.settings === "object") {
            const allowed = Object.keys(byId(p.id).settings);
            const clean = {};
            for (const [k, v] of Object.entries(p.settings)) if (allowed.includes(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) clean[k] = typeof v === "string" ? v.slice(0, SHELL_MAX + 200) : v;
            c.settings = { ...c.settings || {}, ...clean };
          }
          saved[p.id] = c;
          store.write(PROGRAMS_KEY, saved);
          const now = list();
          api.emit("programs:changed", now);
          return now;
        });
      }
      module.exports = { register: register4, makeStore, catalog, PREFS_KEY, PROGRAMS_KEY };
    }
  });

  // src/recipe-parity.js
  var require_recipe_parity = __commonJS({
    "src/recipe-parity.js"(exports, module) {
      "use strict";
      init_globals();
      var EFFORTS = Object.freeze({
        "claude-code": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultracode"]),
        "codex-cli": Object.freeze(["low", "medium", "high", "xhigh", "max"])
      });
      function normalizeAgent(value) {
        return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "") || null : null;
      }
      function normalizeFont(value) {
        return Number.isInteger(value) && value >= 8 && value <= 32 ? value : null;
      }
      function worktreeOf(recipe) {
        return recipe.worktree !== void 0 ? recipe.worktree : recipe.importWorktree === "auto" ? "auto" : "never";
      }
      function validateParity(recipe) {
        if (!["auto", "never"].includes(worktreeOf(recipe))) return "This worktree option is not available yet.";
        if (recipe.fontSize != null && normalizeFont(recipe.fontSize) === null) return "Choose a terminal font size from 8 to 32, or use the default.";
        if (recipe.agent != null && typeof recipe.agent !== "string") return "Enter an agent slug.";
        const effort = recipe.options?.effort;
        if (effort != null && effort !== "" && !(EFFORTS[recipe.programId] || []).includes(effort)) return "Choose an effort supported by this program.";
        return null;
      }
      module.exports = { EFFORTS, normalizeAgent, normalizeFont, worktreeOf, validateParity };
    }
  });

  // src/recipe-import-image.js
  var require_recipe_import_image = __commonJS({
    "src/recipe-import-image.js"(exports, module) {
      "use strict";
      init_globals();
      function validRaster(value) {
        if (value == null || value === "") return null;
        if (typeof value !== "string" || value.length > 35e4 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)) throw Error("That recipe picture is not valid.");
        let binary;
        try {
          binary = atob(value.slice(22));
        } catch {
          throw Error("That recipe picture is not valid.");
        }
        const b = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (b.length < 24 || b.length > 262144 || signature.some((v, i) => b[i] !== v) || String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") throw Error("That recipe picture is too large or is not PNG.");
        const header = new DataView(b.buffer, b.byteOffset, b.byteLength), width = header.getUint32(16), height = header.getUint32(20);
        if (width < 1 || height < 1 || width > 256 || height > 256) throw Error("That recipe picture is too large or is not PNG.");
        return value;
      }
      module.exports = { validRaster };
    }
  });

  // src/recipes.js
  var require_recipes = __commonJS({
    "src/recipes.js"(exports, module) {
      "use strict";
      init_globals();
      var crypto2 = require_crypto();
      var { normalizeAgent, normalizeFont, worktreeOf, validateParity } = require_recipe_parity();
      var { validRaster } = require_recipe_import_image();
      var raster = (value) => {
        try {
          return validRaster(value);
        } catch {
          return null;
        }
      };
      var NAME_MAX = 60;
      var FOLDER_MAX = 300;
      var ARGS_MAX = 500;
      function normalizeFolder(raw) {
        let f = String(raw == null ? "" : raw).trim();
        f = f.replace(/^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+:/, "");
        f = f.replace(/[\\/]+$/, "");
        if (f === "" || f === "~") {
          return "~";
        }
        return f.slice(0, FOLDER_MAX);
      }
      function nameFromFolder(folder) {
        const f = normalizeFolder(folder);
        if (f === "~") {
          return "home";
        }
        const seg = f.split(/[\\/]/).filter(Boolean).pop();
        return (seg || "home").slice(0, NAME_MAX);
      }
      function uniqueName(want, taken) {
        const base = String(want || "").trim().slice(0, NAME_MAX) || "recipe";
        const has = new Set(taken.map((n) => String(n).toLowerCase()));
        if (!has.has(base.toLowerCase())) {
          return base;
        }
        for (let n = 2; n < 1e3; n++) {
          const cand = `${base} ${n}`;
          if (!has.has(cand.toLowerCase())) {
            return cand;
          }
        }
        return `${base} ${Date.now()}`;
      }
      function cleanOptions(o) {
        const out = {};
        for (const [k, v] of Object.entries(o && typeof o === "object" ? o : {})) {
          if (/^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
            out[k] = typeof v === "string" ? v.slice(0, ARGS_MAX) : v;
          }
        }
        return out;
      }
      function cleanColor(c) {
        if (c === "auto" || c == null || c === "") {
          return "auto";
        }
        const n = Number(c);
        return Number.isFinite(n) ? (Math.round(n) % 360 + 360) % 360 : "auto";
      }
      function normalize(r) {
        if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.loginId !== "string") {
          return null;
        }
        return {
          id: r.id,
          accountId: r.loginId === "local" ? null : typeof r.accountId === "string" ? r.accountId : null,
          name: String(r.name || "").slice(0, NAME_MAX),
          loginId: r.loginId,
          serverId: typeof r.serverId === "string" ? r.serverId : null,
          folder: normalizeFolder(r.folder),
          programId: typeof r.programId === "string" ? r.programId : "shell",
          // 0.12.1 (decided 2026-10-19, the lead , replacing ): a recipe on This machine
          // (loginId 'local'), and "Custom command…" (programId 'custom') with the line the person typed
          runsOn: r.loginId === "local" ? "local" : "server",
          command: typeof r.command === "string" ? r.command.trim().slice(0, ARGS_MAX) : "",
          // the words as they were when saved ("server · your account", "Claude Code"): for a row whose server or
          // program is gone; resolution always goes by the ids
          where: typeof r.where === "string" ? r.where.slice(0, 80) : "",
          programLabel: typeof r.programLabel === "string" ? r.programLabel.slice(0, 60) : "",
          options: cleanOptions(r.options),
          color: cleanColor(r.color),
          logo: raster(r.logo),
          agent: normalizeAgent(r.agent),
          fontSize: normalizeFont(r.fontSize),
          // Preserve unsupported explicit metadata for a refusal, never relabel Always as Auto.
          worktree: worktreeOf(r),
          vendorArgs: Array.isArray(r.vendorArgs) ? r.vendorArgs.filter((x) => typeof x === "string").slice(0, 32).map((x) => x.slice(0, 500)) : null,
          vendorFlags: Array.isArray(r.vendorFlags) ? r.vendorFlags.filter((x) => typeof x === "string").slice(0, 32).map((x) => x.slice(0, 80)) : [],
          unavailableTarget: typeof r.unavailableTarget === "string" ? r.unavailableTarget.slice(0, 100) : null,
          importColor: /^#[0-9a-f]{6}$/i.test(r.importColor || "") ? r.importColor : null,
          importWorktree: r.importWorktree === "auto" ? "auto" : "never",
          createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
          updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
          rev: Number.isFinite(r.rev) ? r.rev : 0
        };
      }
      function createRecipes({ config, persist, onChange, accountId = void 0, parityEnabled = false }) {
        const owns = (r) => accountId === void 0 || r.loginId === "local" || !!accountId && r.accountId === accountId;
        const visible = () => all().filter(owns);
        let hooks = {};
        const all = () => {
          if (!Array.isArray(config.recipes)) {
            config.recipes = [];
          }
          const clean = config.recipes.map(normalize).filter(Boolean);
          if (clean.length !== config.recipes.length) {
            config.recipes = clean;
          }
          return config.recipes;
        };
        const changed2 = () => {
          persist();
          if (onChange) {
            onChange(list());
          }
        };
        function list() {
          return visible().slice().sort((a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base" }) || a.createdAt - b.createdAt);
        }
        function byId(id) {
          return visible().find((r) => r.id === id) || null;
        }
        function save(input) {
          const p = input && typeof input === "object" ? input : {};
          const existing = typeof p.id === "string" ? byId(p.id) : null;
          if (typeof p.id === "string" && !existing) {
            return { error: "That recipe is gone." };
          }
          const loginId = typeof p.loginId === "string" && p.loginId ? p.loginId : existing && existing.loginId;
          if (!loginId) {
            return { error: "Choose where it runs first." };
          }
          if (loginId !== "local" && accountId === null) {
            return { error: "Sign in to save a server recipe." };
          }
          const programId = typeof p.programId === "string" && p.programId ? p.programId : existing && existing.programId;
          if (!programId) {
            return { error: "Choose what to run." };
          }
          const command = typeof p.command === "string" ? p.command : existing ? existing.command : "";
          if (programId === "custom" && !String(command || "").trim()) {
            return { error: "Type the command to run." };
          }
          const parityKeys = ["agent", "fontSize", "worktree"];
          if (parityEnabled !== true && parityKeys.some((k) => Object.hasOwn(p, k) && p[k] !== existing?.[k])) return { error: "Recipe options are not available in this build yet." };
          const parity = { ...existing, ...p, programId, options: p.options != null ? p.options : existing?.options };
          if (parityEnabled === true) {
            const error2 = validateParity(parity);
            if (error2) return { error: error2 };
          }
          const folder = normalizeFolder(p.folder != null ? p.folder : existing ? existing.folder : "~");
          const wanted = String(p.name == null ? existing ? existing.name : "" : p.name).trim() || nameFromFolder(folder);
          const others = visible().filter((r) => !existing || r.id !== existing.id).map((r) => r.name);
          const name2 = existing && wanted.toLowerCase() === existing.name.toLowerCase() ? existing.name : uniqueName(wanted, others);
          const now = Date.now();
          const rec = normalize({
            id: existing ? existing.id : crypto2.randomUUID(),
            accountId: loginId === "local" ? null : accountId,
            name: name2,
            loginId,
            serverId: typeof p.serverId === "string" ? p.serverId : existing ? existing.serverId : null,
            folder,
            programId,
            where: typeof p.where === "string" ? p.where : existing ? existing.where : "",
            programLabel: typeof p.programLabel === "string" ? p.programLabel : existing ? existing.programLabel : "",
            command,
            options: p.options != null ? p.options : existing ? existing.options : {},
            color: p.color != null ? p.color : existing ? existing.color : "auto",
            logo: Object.hasOwn(p, "logo") ? p.logo : existing?.logo,
            agent: Object.hasOwn(p, "agent") ? p.agent : existing?.agent,
            fontSize: Object.hasOwn(p, "fontSize") ? p.fontSize : existing?.fontSize,
            worktree: Object.hasOwn(p, "worktree") ? p.worktree : existing?.worktree,
            vendorFlags: p.vendorFlags ?? existing?.vendorFlags,
            vendorArgs: Object.hasOwn(p, "vendorArgs") ? p.vendorArgs : existing && p.options?.extraArgs !== void 0 && p.options.extraArgs !== existing.options?.extraArgs ? null : existing?.vendorArgs,
            unavailableTarget: Object.hasOwn(p, "unavailableTarget") ? p.unavailableTarget : existing?.unavailableTarget,
            importWorktree: p.importWorktree ?? existing?.importWorktree,
            importColor: Object.hasOwn(p, "importColor") ? p.importColor : existing && p.color != null && p.color !== existing.color ? null : existing?.importColor,
            createdAt: existing ? existing.createdAt : now,
            updatedAt: now,
            rev: existing ? existing.rev : 0
          });
          const rows = all();
          const i = existing ? rows.findIndex((r) => r.id === existing.id && owns(r)) : -1;
          if (i >= 0) {
            rows[i] = rec;
          } else {
            rows.push(rec);
          }
          changed2();
          if (hooks.saved) {
            hooks.saved(rec);
          }
          return rec;
        }
        function importNew(inputs) {
          if (!Array.isArray(inputs) || inputs.length > 200 || inputs.some((p) => !p || p.id)) return { error: "This recipe import is not valid." };
          const shadow = { recipes: all().slice() }, temp = createRecipes({ config: shadow, accountId, parityEnabled, persist() {
          } }), added = [];
          for (const input of inputs) {
            const row = temp.save(input);
            if (row.error) return row;
            added.push(row);
          }
          if (added.length) {
            config.recipes = shadow.recipes;
            changed2();
            for (const row of added) hooks.saved?.(row);
          }
          return added;
        }
        function remove(id) {
          const rows = all();
          const i = rows.findIndex((r) => r.id === id && owns(r));
          if (i < 0) {
            return { error: "That recipe is gone." };
          }
          const [gone] = rows.splice(i, 1);
          changed2();
          if (hooks.removed) {
            hooks.removed(gone);
          }
          return gone;
        }
        function putQuiet(r) {
          if (accountId !== void 0 && (r.loginId === "local" || !accountId || byId(r.id) && byId(r.id).loginId === "local")) {
            return null;
          }
          const rec = normalize({ ...r, ...accountId === void 0 ? {} : { accountId } });
          if (!rec) {
            return null;
          }
          const rows = all();
          const i = rows.findIndex((x) => x.id === rec.id && owns(x));
          if (i >= 0) {
            rows[i] = rec;
          } else {
            rows.push(rec);
          }
          return rec;
        }
        function removeQuiet(id) {
          const rows = all();
          const i = rows.findIndex((x) => x.id === id && owns(x) && (accountId === void 0 || x.loginId !== "local"));
          if (i >= 0) {
            rows.splice(i, 1);
          }
        }
        function duplicate(id) {
          const src = byId(id);
          if (!src) {
            return { error: "That recipe is gone." };
          }
          const now = Date.now();
          const rec = normalize({ ...src, id: crypto2.randomUUID(), name: uniqueName(`${src.name} copy`, visible().map((r) => r.name)), createdAt: now, updatedAt: now, rev: 0 });
          all().push(rec);
          changed2();
          if (hooks.saved) {
            hooks.saved(rec);
          }
          return rec;
        }
        return { importNew, list, byId, save, remove, duplicate, putQuiet, removeQuiet, setHooks: (h) => hooks = h || {} };
      }
      module.exports = { createRecipes, normalizeFolder, nameFromFolder, uniqueName, normalize };
    }
  });

  // src/recipe-import.js
  var require_recipe_import = __commonJS({
    "src/recipe-import.js"(exports, module) {
      "use strict";
      init_globals();
      var { uniqueName } = require_recipes();
      var { validRaster } = require_recipe_import_image();
      var MAX_BYTES = 2 * 1024 * 1024;
      var MAX_ROWS = 200;
      var allowed = /* @__PURE__ */ new Set(["id", "name", "target", "projectDir", "vendor", "model", "effort", "vendorArgs", "vendorFlags", "color", "logo", "worktree", "changes", "runClaude"]);
      var reason = "Needs a server connection, which this version does not have";
      var PERMISSION_FLAGS = Object.freeze({ "network": { label: "Network access in the sandbox", widensPermissions: true }, "auto-review": { label: "Auto-review approvals", widensPermissions: true } });
      var MODELS = { "claude-code": ["opus", "sonnet", "fable"], "codex-cli": ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"], "gemini-cli": ["pro", "flash", "flash-lite"] };
      var EFFORTS = { "claude-code": ["low", "medium", "high", "xhigh", "max", "ultracode"], "codex-cli": ["low", "medium", "high", "xhigh", "max"] };
      var vendors = /* @__PURE__ */ new Set(["cli-manager", "claude-code", "codex-cli", "gemini-cli", "ollama"]);
      var clean = (s, n = 300) => typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, "").slice(0, n) : "";
      function fail2() {
        throw Error("This isn't a recipes file Agent Workbench can read.");
      }
      function findSecrets(obj, path = "", depth = 0, out = []) {
        if (depth > 8) fail2();
        for (const [k, v] of Object.entries(obj || {})) {
          const field = (path ? path + "." : "") + clean(k, 60);
          if (/token|password|secret|api.?key|authorization/i.test(k)) out.push({ field, trigger: "name" });
          if (typeof v === "string" && /(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|(?:password|token|api[_-]?key)\s*=)/i.test(v)) out.push({ field, trigger: "value" });
          if (v && typeof v === "object") findSecrets(v, field, depth + 1, out);
        }
        return [...new Map(out.map((f) => [f.field + "|" + f.trigger, f])).values()].slice(0, 80);
      }
      function secrets(obj) {
        return [...new Set(findSecrets(obj).map((f) => f.field))].slice(0, 40);
      }
      function isLocalFolder(folder, platform = import_process.default.platform) {
        if (!folder || folder === "~") return true;
        if (/^(?:\\\\|\/\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(folder)) return false;
        return platform !== "win32" || /^[A-Za-z]:[\\/]/.test(folder);
      }
      function args(value) {
        if (value == null) return [];
        if (!Array.isArray(value) || value.length > 32 || value.some((x) => typeof x !== "string" || x.length > 500)) fail2();
        return value.map((x) => clean(x, 500));
      }
      function parsePack(text3, options) {
        return parsePackDocument(text3, options).rows;
      }
      function parsePackDocument(text3, { platform = "win32", folderExists = () => false, names = [] } = {}) {
        if (typeof text3 !== "string") fail2();
        if (import_buffer.Buffer.byteLength(text3) > MAX_BYTES) throw Error("This file is too large to import. The limit is 2 MB.");
        const json2 = text3.startsWith("\uFEFF") ? text3.slice(1) : text3;
        if (json2.includes("\uFEFF")) fail2();
        let pack;
        try {
          pack = JSON.parse(json2);
        } catch {
          fail2();
        }
        if (pack?.version > 1) throw Error("This file is from a newer version of Agent Workbench. Update, then try again.");
        if (!pack || pack.version !== 1 || !Array.isArray(pack.recipes)) fail2();
        if (pack.recipes.length > MAX_ROWS) throw Error("This file has more than 200 recipes. Split it, then try again.");
        const topFindings = findSecrets(Object.fromEntries(Object.entries(pack).filter(([k]) => k !== "recipes"))).map((f) => ({ ...f, field: "file." + f.field }));
        const topSecrets = topFindings.map((f) => f.field);
        const taken = [...names];
        const rows = pack.recipes.map((raw, index) => {
          if (!raw || Array.isArray(raw) || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name.trim() || !vendors.has(raw.vendor) || typeof raw.target !== "string" || raw.target.length > 100) fail2();
          for (const key of ["projectDir", "model", "effort"]) if (raw[key] != null && typeof raw[key] !== "string") fail2();
          const changes = Object.keys(raw).filter((k) => !allowed.has(k)).map((k) => "Dropped " + clean(k, 60));
          if (raw.changes != null) {
            if (!Array.isArray(raw.changes) || raw.changes.length > 80 || raw.changes.some((x) => typeof x !== "string" || x.length > 300)) fail2();
            changes.push(...raw.changes.map((x) => clean(x)));
          }
          const originalName = clean(raw.name.trim(), 60), name2 = uniqueName(originalName, taken);
          taken.push(name2);
          if (name2 !== originalName) changes.push("Renamed to " + name2);
          const sourceTarget = clean(raw.target, 100), local = sourceTarget === "local";
          if (!local) changes.push(reason);
          let folder = clean(raw.projectDir);
          if (folder && (!isLocalFolder(folder, platform) || !folderExists(folder))) {
            changes.push("Starting folder cleared; choose a folder or use home");
            folder = "";
          }
          const vendorFlags = args(raw.vendorFlags), rawArgs = args(raw.vendorArgs), vendorArgs = raw.vendor === "cli-manager" ? [] : rawArgs;
          if (raw.vendor === "cli-manager" && rawArgs.length) changes.push("Dropped vendorArgs");
          if (vendorFlags.some((x) => raw.vendor !== "codex-cli" || !Object.hasOwn(PERMISSION_FLAGS, x))) throw Error("This recipe uses a program option this version does not support.");
          if (vendorFlags.some((x) => x.length > 80) || vendorArgs.map((a) => JSON.stringify(a)).join(" ").length > 500) fail2();
          let logoRaw = null;
          if (raw.logo != null) {
            if (typeof raw.logo === "string" && import_buffer.Buffer.byteLength(raw.logo) <= 65536) {
              try {
                const logo = JSON.parse(raw.logo);
                if (logo && typeof logo === "object" && (typeof logo.svg === "string" || typeof logo.dataUrl === "string")) logoRaw = raw.logo;
                else changes.push("Dropped unsupported logo");
              } catch {
                changes.push("Dropped invalid logo");
              }
            } else changes.push("Dropped oversized logo");
          }
          const model = (MODELS[raw.vendor] || []).includes(raw.model) ? raw.model : "";
          const effort = (EFFORTS[raw.vendor] || []).includes(raw.effort) ? raw.effort : "";
          if (raw.model && !model) changes.push("Dropped unsupported model");
          if (raw.effort && !effort) changes.push("Dropped unsupported effort");
          const worktree = ["auto", "never"].includes(raw.worktree) ? raw.worktree : "never";
          if (raw.worktree && !["auto", "never"].includes(raw.worktree)) changes.push("Dropped unsupported worktree mode");
          const fields = secrets(raw), argumentPreview = rawArgs.map((arg, i) => fields.includes("vendorArgs." + i) ? "(hidden)" : arg).join(" ");
          const launchOptions = [];
          if (raw.vendor === "cli-manager" && (rawArgs.length || raw.initCmd || raw.changes?.includes("initCmd"))) launchOptions.push("Not copied: program arguments, setup command. Shell recipes don't take those from a file.");
          else if (rawArgs.length) launchOptions.push("This recipe passes options to the program: " + argumentPreview + ". Check them before you add it.");
          const settings2 = [];
          if (model) settings2.push("model " + model);
          if (effort) settings2.push("effort " + effort);
          if (raw.worktree && ["auto", "never"].includes(raw.worktree)) settings2.push("worktree " + (worktree === "auto" ? "automatic" : "never"));
          if (settings2.length) launchOptions.push("Settings kept: " + settings2.join(", ") + ".");
          if (vendorFlags.length) launchOptions.push("Permission options kept: " + vendorFlags.map((f) => PERMISSION_FLAGS[f].label).join(", ") + ".");
          if (raw.initCmd) changes.push("A start command written for another machine will not run on this server.");
          return { index, name: name2, originalName, sourceTarget, folder, programId: raw.vendor === "cli-manager" ? "shell" : raw.vendor, programLabel: { "cli-manager": "Shell", "claude-code": "Claude Code", "codex-cli": "Codex", "gemini-cli": "Gemini", "ollama": "Ollama" }[raw.vendor], model, effort, vendorFlags, vendorArgs, logoRaw, color: typeof raw.color === "string" ? clean(raw.color, 40) : null, worktree, changes, secretFields: [...topSecrets, ...secrets(raw)], secretFindings: [...topFindings, ...findSecrets(raw)], argumentPreview, launchOptions, requiresOptionsAck: rawArgs.length > 0, permissionFlags: vendorFlags.filter((f) => PERMISSION_FLAGS[f]?.widensPermissions), permissionLabels: vendorFlags.filter((f) => PERMISSION_FLAGS[f]?.widensPermissions).map((f) => PERMISSION_FLAGS[f].label), selected: local && !raw.initCmd && !rawArgs.length };
        });
        const droppedFields = Array.isArray(pack.dropped) ? pack.dropped.slice(0, 80).map((x) => typeof x?.field === "string" ? x.field.replace(/[\u0000-\u001f]/g, "").slice(0, 60) : "").filter(Boolean) : [];
        return { rows, droppedFields };
      }
      function colorHue(hex) {
        if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return "auto";
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
        if (!d) return 0;
        return Math.round((hi === r ? (g - b) / d + (g < b ? 6 : 0) : hi === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 % 360);
      }
      function blockedReason(recipe) {
        return recipe?.unavailableTarget ? `${recipe.name || "This recipe"} needs a server connection, which this version does not have, so it can't start.` : null;
      }
      function commitSelection(rows, selections, { folderExists = () => false, platform = import_process.default.platform, acceptSecrets = false, acceptPermissions = false } = {}) {
        if (!Array.isArray(selections) || selections.length > MAX_ROWS || selections.some((s) => !s || typeof s !== "object" || Array.isArray(s) || typeof s.selected !== "boolean" || !Number.isInteger(s.index) || !rows[s.index]) || new Set(selections.map((s) => s.index)).size !== selections.length) fail2();
        const seen = /* @__PURE__ */ new Set();
        return selections.filter((s) => s?.selected === true).map((s) => {
          if (!Number.isInteger(s.index) || !rows[s.index] || seen.has(s.index)) fail2();
          seen.add(s.index);
          const row = rows[s.index];
          if (row.requiresOptionsAck && s.acceptOptions !== true) throw Error("Review the program options before importing this recipe.");
          if (row.permissionFlags.length && !acceptPermissions) throw Error("Review the Codex permission options before importing.");
          if (row.secretFields.length && !acceptSecrets) throw Error("Review the secret-field warning before importing.");
          if (!["local", "keep"].includes(s.target)) fail2();
          const unavailableTarget = s.target === "keep" && row.sourceTarget !== "local" ? row.sourceTarget : null;
          if (unavailableTarget && !s.acceptUnavailable) throw Error("Confirm that this server recipe will not start.");
          if (typeof s.folder !== "string" || s.folder.length > 300) fail2();
          const folder = s.folder.trim();
          if (folder && folder !== "~" && (!isLocalFolder(folder, platform) || !folderExists(folder))) throw Error("Choose an existing folder or leave it empty to use home.");
          const logo = validRaster(s.logo);
          return { name: row.name, loginId: "local", serverId: "local", where: unavailableTarget || "This computer", folder: folder || "~", programId: row.programId, programLabel: row.programLabel, command: "", options: { model: row.model, effort: row.effort, extraArgs: row.vendorArgs.map((a) => JSON.stringify(a)).join(" ") }, vendorFlags: row.vendorFlags, vendorArgs: row.vendorArgs, unavailableTarget, logo, color: colorHue(row.color), importColor: row.color, importWorktree: row.worktree };
        });
      }
      function recipeArgs(r, split, includeFlags = false) {
        const args2 = Array.isArray(r.vendorArgs) ? r.vendorArgs.slice() : split(r.options?.extraArgs || "");
        if (!includeFlags || r.programId !== "codex-cli") return args2;
        const flags = [];
        if (r.vendorFlags?.includes("network")) flags.push("-c", "sandbox_workspace_write.network_access=true");
        if (r.vendorFlags?.includes("auto-review")) flags.push("-c", 'approvals_reviewer="auto_review"');
        return flags.concat(args2);
      }
      module.exports = { isLocalFolder, PERMISSION_FLAGS, recipeArgs, parsePack, parsePackDocument, commitSelection, blockedReason, validRaster, MAX_BYTES, MAX_ROWS };
    }
  });

  // src/renderer/web-recipe-import/controller.js
  function createRecipeImport({ importSelected, checkFolder = async () => false }) {
    if (typeof importSelected !== "function" || typeof checkFolder !== "function") throw error("invalid-adapter");
    let epoch = 0, rows = null, busy = false, finished = false, disposed = false, abort = null;
    const alive = (token) => {
      if (disposed) throw error("disposed");
      if (token !== epoch) throw error("stale-operation");
    };
    function cancel() {
      epoch++;
      rows = null;
      abort?.abort();
    }
    async function open(file, { names = [] } = {}) {
      if (disposed) throw error("disposed");
      if (busy) throw error("busy");
      const token = ++epoch;
      rows = null;
      finished = false;
      if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.text !== "function") throw error("invalid-file");
      if (file.size > import_recipe_import.default.MAX_BYTES) throw error("file-too-large");
      const text3 = await file.text();
      alive(token);
      const preview = import_recipe_import.default.parsePackDocument(text3, { platform: "linux", folderExists: () => false, names });
      rows = preview.rows.map((row) => ({ ...row, folder: "", autoApprove: "follow" }));
      return clone({ ...preview, rows });
    }
    async function commit(selections, acknowledgements = {}) {
      if (disposed) throw error("disposed");
      if (busy) throw error("busy");
      if (finished) throw error("operation-finished");
      if (!rows) throw error("no-preview");
      const token = epoch;
      busy = true;
      const saved = [];
      let attempted = false;
      try {
        const chosen = clone(selections);
        const recipes = import_recipe_import.default.commitSelection(rows, chosen.map((s) => ({ ...s, target: "local", folder: "" })), {
          platform: "linux",
          folderExists: () => false,
          acceptSecrets: acknowledgements.acceptSecrets === true,
          acceptPermissions: acknowledgements.acceptPermissions === true
        });
        const selected = chosen.filter((s) => s.selected);
        for (let i = 0; i < selected.length; i++) {
          const raw = selected[i].folder;
          if (typeof raw !== "string" || raw.length > 300) throw error("folder-unavailable");
          const folder = raw.trim();
          if (folder && folder !== "~") {
            if (!folder.startsWith("/") || folder.startsWith("//") || /[\u0000-\u001f]/.test(folder)) throw error("folder-unavailable");
            const found = await checkFolder(folder);
            alive(token);
            if (found !== true) throw error("folder-unavailable");
          }
          recipes[i].folder = folder || "~";
          recipes[i].autoApprove = "follow";
        }
        alive(token);
        attempted = true;
        finished = true;
        abort = new AbortController();
        let results;
        try {
          results = await importSelected(clone(recipes), { signal: abort.signal });
        } catch {
          return { status: "unconfirmed", saved };
        }
        if (!Array.isArray(results) || results.length > recipes.length) return { status: "unconfirmed", saved };
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result?.index !== void 0 && result.index !== i) return { status: "unconfirmed", saved };
          const kind = result?.status || (result?.ok === true ? "saved" : result?.ok === false ? result.unconfirmed === true ? "unconfirmed" : "refused" : null);
          if (kind === "saved" && typeof result.id === "string" && result.id) saved.push(selected[i].index);
          else if (kind === "not-sent" && (token !== epoch || disposed)) return { status: "cancelled", saved };
          else if (kind === "refused") return { status: "refused", saved, index: selected[i].index };
          else return { status: "unconfirmed", saved, index: selected[i].index };
        }
        if (token !== epoch || disposed) return { status: "cancelled", saved };
        if (results.length !== recipes.length) return { status: "unconfirmed", saved };
        return { status: "complete", saved };
      } finally {
        busy = false;
        abort = null;
        if (attempted) rows = null;
      }
    }
    return Object.freeze({ open, commit, cancel, dispose() {
      disposed = true;
      cancel();
    } });
  }
  var import_recipe_import, error, clone;
  var init_controller = __esm({
    "src/renderer/web-recipe-import/controller.js"() {
      init_globals();
      import_recipe_import = __toESM(require_recipe_import());
      error = (code) => Object.assign(new Error(code), { code });
      clone = (value) => JSON.parse(JSON.stringify(value));
    }
  });

  // src/renderer/web-recipe-import/api.js
  var api_exports = {};
  __export(api_exports, {
    createRecipeImportApi: () => createRecipeImportApi
  });
  function createRecipeImportApi({ chooseFile, pickFolder, checkFolder, importSelected, names = () => [], randomId = () => crypto.randomUUID() }) {
    let current = null, disposed = false;
    function cancel() {
      current?.chooserAbort.abort();
      current?.controller.dispose();
      current = null;
    }
    function owned(id) {
      return !disposed && current && current.id === id ? current : null;
    }
    async function open() {
      if (disposed) return { ok: false, error: "Import is no longer open." };
      cancel();
      const op = { id: randomId(), controller: createRecipeImport({ checkFolder, importSelected }), preview: null, chooserAbort: new AbortController() };
      current = op;
      try {
        const file = await chooseFile({ signal: op.chooserAbort.signal });
        if (!owned(op.id)) return { ok: true, value: null };
        if (!file) {
          cancel();
          return { ok: true, value: null };
        }
        op.preview = await op.controller.open(file, { names: await names() });
        if (!owned(op.id)) return { ok: true, value: null };
        return { ok: true, value: { ...op.preview, operationId: op.id, fileName: String(file.name || "recipes.json").slice(0, 200) } };
      } catch {
        if (owned(op.id)) cancel();
        return { ok: false, error: "Couldn't read that recipes file. Check the file and try again." };
      }
    }
    async function folder(id) {
      const op = owned(id);
      if (!op) return { ok: false, error: "Choose the recipes file again." };
      try {
        const value = await pickFolder({ signal: op.chooserAbort.signal });
        if (!owned(id)) return { ok: false, error: "Import is no longer open." };
        return { ok: true, value };
      } catch {
        return { ok: false, error: "Couldn't open the server folder picker. Try again." };
      }
    }
    async function commit(input) {
      const op = owned(input?.operationId);
      if (!op) return { ok: false, finished: true, error: "Choose the recipes file again." };
      try {
        const result = await op.controller.commit(input.selections, input);
        const added = result.saved.map((index) => ({ name: op.preview.rows[index].name }));
        if (result.status === "complete") {
          if (owned(op.id)) cancel();
          return { ok: true, value: { added, skipped: [] } };
        }
        const prefix = added.length ? `Imported ${added.length} ${added.length === 1 ? "recipe" : "recipes"}. ` : "";
        return { ok: false, finished: true, unconfirmed: result.status === "unconfirmed", error: prefix + (result.status === "refused" ? "The next recipe couldn't be imported. Check your recipes before starting another import." : "Import could not be confirmed. Check your recipes before trying again.") };
      } catch (e) {
        if (e.code === "folder-unavailable") return { ok: false, error: "Folder not found on this server. Choose another folder." };
        if (e.code === "operation-finished") return { ok: false, finished: true, error: "Check your recipes before starting another import." };
        return { ok: false, error: "Review the selected recipes and their warnings before importing." };
      }
    }
    return Object.freeze({ open, folder, commit, cancel(id) {
      if (!id || owned(id)) cancel();
      return { ok: true };
    }, dispose() {
      disposed = true;
      cancel();
    } });
  }
  var init_api = __esm({
    "src/renderer/web-recipe-import/api.js"() {
      init_globals();
      init_controller();
    }
  });

  // src/renderer/web-recipe-import/file-picker.js
  var file_picker_exports = {};
  __export(file_picker_exports, {
    chooseRecipeFile: () => chooseRecipeFile
  });
  async function chooseRecipeFile(browser = window, { signal } = {}) {
    if (signal?.aborted) return null;
    if (browser.navigator?.userActivation?.isActive !== true) throw Object.assign(new Error("user-gesture-required"), { code: "user-gesture-required" });
    return new Promise((resolve, reject) => {
      const input = browser.document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.multiple = false;
      input.hidden = true;
      let settled = false;
      const finish = (value, error2) => {
        if (settled) return;
        settled = true;
        input.removeEventListener("change", changed2);
        input.removeEventListener("cancel", cancelled);
        signal?.removeEventListener("abort", cancelled);
        input.remove();
        if (error2) reject(error2);
        else resolve(value);
      };
      const changed2 = () => finish(input.files?.[0] || null), cancelled = () => finish(null);
      input.addEventListener("change", changed2);
      input.addEventListener("cancel", cancelled);
      signal?.addEventListener("abort", cancelled, { once: true });
      try {
        browser.document.body.append(input);
        input.click();
      } catch {
        finish(null, Object.assign(new Error("file-picker-unavailable"), { code: "file-picker-unavailable" }));
      }
    });
  }
  var init_file_picker = __esm({
    "src/renderer/web-recipe-import/file-picker.js"() {
      init_globals();
    }
  });

  // web/handlers/recipe-import.js
  var require_recipe_import2 = __commonJS({
    "web/handlers/recipe-import.js"(exports, module) {
      "use strict";
      init_globals();
      var { createRecipeImportApi: createRecipeImportApi2 } = (init_api(), __toCommonJS(api_exports));
      var { chooseRecipeFile: chooseRecipeFile2 } = (init_file_picker(), __toCommonJS(file_picker_exports));
      function register4(api, { browser = globalThis, chooseFile } = {}) {
        let bridge, disposed = false;
        const web2 = () => browser.wb?.web;
        const ready = () => typeof web2()?.recipes?.importSelected === "function" && typeof web2()?.files?.chooseFolder === "function" && typeof web2()?.files?.directoryLoader === "function";
        const create = () => createRecipeImportApi2({
          chooseFile: (options) => (chooseFile || ((opts) => chooseRecipeFile2(browser, opts)))(options),
          randomId: () => browser.crypto.randomUUID(),
          names: async () => {
            const rows = await browser.wb.recipesList();
            if (!Array.isArray(rows)) throw Error("unavailable");
            return rows.map((r) => r.name).filter((n) => typeof n === "string");
          },
          importSelected: (list, options) => web2().recipes.importSelected(list, options),
          pickFolder: async (options) => {
            const result = await web2().files.chooseFolder(options);
            if (result?.ok === true && typeof result.path === "string") return result.path;
            if (["cancelled", "changed"].includes(result?.code)) return null;
            throw Error("unavailable");
          },
          checkFolder: async (path) => {
            const load = web2().files.directoryLoader({ current: () => !disposed });
            const result = await load(path);
            return result?.ok === true;
          }
        });
        bridge = create();
        const facade = Object.freeze({
          open: () => ready() ? bridge.open() : Promise.resolve({ ok: false, error: "Recipe importing is not ready on this server yet." }),
          folder: (id) => bridge.folder(id),
          commit: (input) => bridge.commit(input),
          cancel: (id) => bridge.cancel(id)
        });
        api.expose("recipeImport", facade);
        api.handle("recipes:import-open", () => facade.open());
        api.handle("recipes:import-folder", ([input]) => facade.folder(input?.operationId));
        api.handle("recipes:import-cancel", ([input]) => facade.cancel(input?.operationId));
        api.handle("recipes:import-commit", ([input]) => facade.commit(input));
        const hide = () => bridge.dispose();
        const show = (event) => {
          if (!disposed && event.persisted) bridge = create();
        };
        browser.addEventListener("pagehide", hide);
        browser.addEventListener("pageshow", show);
        return () => {
          disposed = true;
          bridge.dispose();
          browser.removeEventListener("pagehide", hide);
          browser.removeEventListener("pageshow", show);
        };
      }
      module.exports = { register: register4 };
    }
  });

  // web/lib/recipe-map.js
  var require_recipe_map = __commonJS({
    "web/lib/recipe-map.js"(exports, module) {
      "use strict";
      init_globals();
      var VENDORS = ["claude-code", "cli-manager", "gemini-cli", "codex-cli", "ollama"];
      var PROGRAM_OF = { "cli-manager": "shell", "claude-code": "claude-code", "codex-cli": "codex-cli", "gemini-cli": "gemini-cli", ollama: "ollama" };
      var VENDOR_OF = { shell: "cli-manager", custom: "cli-manager", "claude-code": "claude-code", "codex-cli": "codex-cli", "gemini-cli": "gemini-cli", ollama: "ollama" };
      var LABEL = { "cli-manager": "Shell", "claude-code": "Claude Code", "codex-cli": "Codex", "gemini-cli": "Gemini", ollama: "Ollama" };
      var AUTO_APPROVE = ["follow", "on", "off"];
      var HEX = /^#[0-9a-f]{6}$/i;
      var NAME_MAX = 60;
      var ARGS_MAX = 500;
      var LOGO_MAX = 65536;
      var ENGINE_ONLY = ["fg", "bg", "watermark", "resume", "resumeName", "closeOnCleanExit", "statusPath"];
      var isStr = (v) => typeof v === "string";
      var refuse = (field, message) => ({ ok: false, field, message });
      function projectDirOf(folder) {
        const f = String(folder == null ? "" : folder).trim().replace(/[\\/]+$/, "");
        return f === "" || f === "~" ? null : f.slice(0, 300);
      }
      function toEngine(r, opts = {}) {
        if (!r || typeof r !== "object") return refuse("recipe", "There is no recipe to save.");
        const { targetId, imported = false, existing = null } = opts;
        if (!isStr(targetId) || !targetId) return refuse("target", "This server has no place to run a program yet.");
        const name2 = String(r.name == null ? "" : r.name).trim().slice(0, NAME_MAX);
        if (!name2) return refuse("name", "Give the recipe a name.");
        const programId = isStr(r.programId) && r.programId ? r.programId : "shell";
        const vendor = VENDOR_OF[programId];
        if (!vendor) return refuse("programId", "This server cannot run " + JSON.stringify(programId.slice(0, 40)) + ".");
        const body = { name: name2, target: targetId, vendor, projectDir: projectDirOf(r.folder) };
        if (isStr(r.id) && r.id && !imported) body.id = r.id;
        if (isStr(r.agent) && r.agent.trim()) body.agent = r.agent.trim().slice(0, 80);
        const options = r.options && typeof r.options === "object" ? r.options : {};
        if (isStr(options.model) && options.model.trim()) body.model = options.model.trim().slice(0, 80);
        if (isStr(options.effort) && options.effort.trim()) body.effort = options.effort.trim();
        if (Array.isArray(r.vendorArgs)) body.vendorArgs = r.vendorArgs.filter(isStr).slice(0, 32).map((x) => x.slice(0, ARGS_MAX));
        if (Array.isArray(r.vendorFlags)) body.vendorFlags = r.vendorFlags.filter(isStr).slice(0, 32).map((x) => x.slice(0, 80));
        if (programId === "custom" && isStr(r.command) && r.command.trim()) body.initCmd = r.command.trim().slice(0, ARGS_MAX);
        const color = HEX.test(r.importColor || "") ? r.importColor : HEX.test(r.color || "") ? r.color : null;
        if (color) body.color = color.toLowerCase();
        if (typeof r.fontSize === "number" && Number.isFinite(r.fontSize)) body.fontSize = r.fontSize;
        if (r.worktree === "auto" || r.worktree === "never") body.worktree = r.worktree;
        else if (r.importWorktree === "auto" || r.importWorktree === "never") body.worktree = r.importWorktree;
        if (isStr(r.logo) && r.logo.length <= LOGO_MAX) body.logo = r.logo;
        if (imported) body.autoApprove = "follow";
        else if (AUTO_APPROVE.includes(r.autoApprove)) {
          body.autoApprove = r.autoApprove;
          if (r.autoApprove === "on" && r.disclosed === true) body.disclosed = true;
        }
        if (existing && typeof existing === "object" && !imported) {
          for (const k of ENGINE_ONLY) if (body[k] === void 0 && existing[k] !== void 0 && existing[k] !== null) body[k] = existing[k];
          if (body.model === void 0 && !r.options && isStr(existing.model) && existing.model) body.model = existing.model;
        }
        return { ok: true, body };
      }
      function fromEngine(row) {
        if (!row || typeof row !== "object" || !isStr(row.id)) return null;
        const vendor = VENDORS.includes(row.vendor) ? row.vendor : row.runClaude === 0 ? "cli-manager" : "claude-code";
        const custom = vendor === "cli-manager" && isStr(row.initCmd) && row.initCmd.trim();
        const out = {
          id: row.id,
          accountId: null,
          name: String(row.name || "").slice(0, NAME_MAX),
          loginId: "local",
          serverId: "local",
          folder: isStr(row.projectDir) && row.projectDir ? row.projectDir : "~",
          programId: custom ? "custom" : PROGRAM_OF[vendor],
          runsOn: "local",
          command: custom ? row.initCmd.trim() : "",
          where: "This server",
          programLabel: custom ? "Custom command" : LABEL[vendor],
          options: { ...isStr(row.model) && row.model ? { model: row.model } : {}, ...isStr(row.effort) && row.effort ? { effort: row.effort } : {} },
          color: "auto",
          importColor: HEX.test(row.color || "") ? row.color.toLowerCase() : null,
          logo: isStr(row.logo) && row.logo ? row.logo : null,
          agent: isStr(row.agent) && row.agent ? row.agent : null,
          fontSize: typeof row.fontSize === "number" ? row.fontSize : null,
          worktree: row.worktree === "never" ? "never" : "auto",
          vendorArgs: Array.isArray(row.vendorArgs) ? row.vendorArgs.filter(isStr) : null,
          vendorFlags: Array.isArray(row.vendorFlags) ? row.vendorFlags.filter(isStr) : [],
          unavailableTarget: null,
          importWorktree: "never",
          createdAt: Number.isFinite(row.created_at) ? row.created_at : 0,
          updatedAt: Number.isFinite(row.updated_at) ? row.updated_at : 0,
          rev: Number.isFinite(row.updated_at) ? row.updated_at : 0
        };
        if (AUTO_APPROVE.includes(row.autoApprove)) out.autoApprove = row.autoApprove;
        if (row.autoApproveEffective === "on" || row.autoApproveEffective === "off") out.autoApproveEffective = row.autoApproveEffective;
        if (row.autoApproveSource === "recipe" || row.autoApproveSource === "default") out.autoApproveSource = row.autoApproveSource;
        return out;
      }
      module.exports = { toEngine, fromEngine, projectDirOf, VENDORS, VENDOR_OF, PROGRAM_OF, ENGINE_ONLY };
    }
  });

  // web/handlers/recipes.js
  var require_recipes2 = __commonJS({
    "web/handlers/recipes.js"(exports, module) {
      "use strict";
      init_globals();
      var { toEngine, fromEngine } = require_recipe_map();
      var NAME_MAX = 60;
      var FORM_ID = /^[\w.:-]{1,64}$/;
      var CONTEXTS = ["general", "concierge"];
      var TOKEN_TTL_MS = 10 * 60 * 1e3;
      var hex = () => {
        const b = new Uint8Array(16);
        const c = globalThis.crypto;
        if (c && c.getRandomValues) c.getRandomValues(b);
        else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
        return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      };
      function copyName(name2, taken) {
        const have = new Set(taken.map((n) => String(n).toLowerCase()));
        const base = (String(name2).slice(0, NAME_MAX - 5) + " copy").trim();
        if (!have.has(base.toLowerCase())) return base;
        for (let n = 2; n < 1e3; n++) {
          const c = base + " " + n;
          if (!have.has(c.toLowerCase())) return c;
        }
        return base + " " + Date.now();
      }
      function register4(api) {
        const rows = /* @__PURE__ */ new Map();
        let targetId = null;
        const note = (name2, extra) => api.cause ? api.cause(name2, extra) : void 0;
        async function json2(path, init) {
          let res;
          try {
            res = await api.engine.fetch(path, init);
          } catch (e) {
            throw Object.assign(new Error("Couldn't reach the server."), { code: "unreachable", cause: e });
          }
          let body = null;
          try {
            body = await res.json();
          } catch (e) {
            body = null;
          }
          return { status: res.status, ok: res.ok, body };
        }
        const reason = (r, fallback) => r.body && typeof r.body.error === "string" && r.body.error ? r.body.error : fallback;
        async function target() {
          if (targetId) return targetId;
          const r = await json2("/api/targets");
          const list = r.ok && r.body && Array.isArray(r.body.targets) ? r.body.targets : [];
          const pick = list.find((t) => t && t.id === "local") || list[0];
          if (!pick || typeof pick.id !== "string") return null;
          targetId = pick.id;
          return targetId;
        }
        async function load() {
          const r = await json2("/api/recipes");
          if (!r.ok || !r.body || !Array.isArray(r.body.recipes)) throw Object.assign(new Error(reason(r, "Couldn't read the recipes.")), { code: "http", status: r.status });
          rows.clear();
          for (const row of r.body.recipes) if (row && typeof row.id === "string") rows.set(row.id, row);
          return [...rows.values()].map(fromEngine).filter(Boolean);
        }
        const changed2 = async () => {
          try {
            api.emit("recipes:changed", await load());
          } catch (e) {
          }
        };
        async function post(body, { signal } = {}) {
          let res;
          try {
            res = await api.engine.fetch("/api/recipes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
          } catch (e) {
            return { ok: false, unconfirmed: true, error: signal && signal.aborted ? "Cancelled." : "Couldn't confirm the save. Check the recipe list before trying again." };
          }
          let data = null;
          try {
            data = await res.json();
          } catch (e) {
            data = null;
          }
          if (res.ok && !(data && data.recipe && typeof data.recipe.id === "string")) {
            return { ok: false, unconfirmed: true, status: res.status, error: "Couldn't confirm the save. Check the recipe list before trying again." };
          }
          if (!res.ok) {
            return { ok: false, status: res.status, error: data && typeof data.error === "string" && data.error || "The server refused the recipe.", field: data && data.field, allowed: data && data.allowed };
          }
          rows.set(data.recipe.id, data.recipe);
          return { ok: true, record: fromEngine(data.recipe), ...data.warning ? { warning: data.warning } : {} };
        }
        const forms = /* @__PURE__ */ new Set();
        const held = /* @__PURE__ */ new Map();
        const now = api.now || Date.now;
        api.handle("recipes:folder-form", async ([a]) => {
          if (!a || typeof a !== "object" || !FORM_ID.test(String(a.formId || "")) || !CONTEXTS.includes(a.context)) return { ok: false };
          if (a.recipeId != null && (typeof a.recipeId !== "string" || a.recipeId.length > 128)) return { ok: false };
          forms.add(a.formId);
          if (forms.size > 50) forms.delete(forms.values().next().value);
          return { ok: true };
        });
        api.handle("recipes:pick-folder", async ([a]) => {
          if (!a || typeof a !== "object" || !["choose", "create"].includes(a.mode) || !forms.has(String(a.formId || ""))) return { ok: false, why: "invalid" };
          const files = globalThis.wb && globalThis.wb.web && globalThis.wb.web.files;
          if (!files || typeof files.chooseFolder !== "function") return { ok: false, why: "unavailable" };
          let r;
          try {
            r = await files.chooseFolder({ mode: a.mode });
          } catch (e) {
            return { ok: false, why: "unreadable" };
          }
          if (!r || r.ok === false || r.canceled || typeof r.path !== "string" || !r.path) return { ok: false, why: "cancel" };
          const st = await json2("/api/fs/dirs?path=" + encodeURIComponent(r.path) + "&hidden=0").catch(() => null);
          if (!st || !st.ok) return { ok: false, why: "unreadable" };
          const token = hex();
          held.set(token, { path: String(st.body.path || r.path), formId: a.formId, until: now() + TOKEN_TTL_MS });
          if (held.size > 20) held.delete(held.keys().next().value);
          return { ok: true, token, path: held.get(token).path };
        });
        function claim(p) {
          if (!p || typeof p !== "object") return { ok: true, payload: p, spend() {
          } };
          const { folderToken, formId, ...rest } = p;
          if (typeof folderToken !== "string") return { ok: true, payload: rest, spend() {
          } };
          const h = held.get(folderToken);
          if (!h || now() > h.until || h.formId !== formId) return { ok: false, error: "That folder choice is no longer valid. Choose the folder again." };
          return { ok: true, payload: { ...rest, folder: h.path }, spend: () => held.delete(folderToken) };
        }
        api.handle("recipes:list", async () => load());
        api.handle("recipes:save", async ([raw]) => {
          const picked = claim(raw);
          if (!picked.ok) return { error: picked.error };
          const p = picked.payload;
          const t = await target();
          if (!t) return { error: "This server has no place to run a program yet." };
          if (!rows.size) await load().catch(() => {
          });
          const existing = p && typeof p.id === "string" ? rows.get(p.id) || null : null;
          const m = toEngine(p, { targetId: t, existing });
          if (!m.ok) return { error: m.message, field: m.field };
          const r = await post(m.body);
          if (!r.ok) return { error: r.error, ...r.status ? { status: r.status } : {}, ...r.unconfirmed ? { unconfirmed: true } : {}, ...r.field ? { field: r.field } : {}, ...r.allowed ? { allowed: r.allowed } : {} };
          picked.spend();
          note("recipe-saved", { id: r.record.id, program: r.record.programId, isNew: !m.body.id });
          void changed2();
          return r.warning ? { ...r.record, warning: r.warning } : r.record;
        });
        api.handle("recipes:delete", async ([id]) => {
          const rid = String(id || "");
          if (!rid) return { error: "Choose a recipe to delete." };
          const r = await json2("/api/recipes/" + encodeURIComponent(rid), { method: "DELETE" });
          if (r.status === 409) return { error: reason(r, "A seat in a room still starts from this recipe. Remove the seat first.") };
          if (!r.ok) return { error: reason(r, "Couldn't delete the recipe.") };
          rows.delete(rid);
          note("recipe-deleted", { id: rid });
          void changed2();
          return { id: rid };
        });
        api.handle("recipes:duplicate", async ([id]) => {
          const t = await target();
          if (!t) return { error: "This server has no place to run a program yet." };
          if (!rows.size) await load().catch(() => {
          });
          const src = rows.get(String(id || ""));
          if (!src) return { error: "That recipe is gone." };
          const rec = fromEngine(src);
          const m = toEngine({ ...rec, id: void 0, name: copyName(rec.name, [...rows.values()].map((x) => x.name)), autoApprove: void 0 }, { targetId: t, existing: src });
          if (!m.ok) return { error: m.message, field: m.field };
          delete m.body.id;
          const r = await post(m.body);
          if (!r.ok) return { error: r.error, ...r.status ? { status: r.status } : {}, ...r.unconfirmed ? { unconfirmed: true } : {} };
          void changed2();
          return r.record;
        });
        api.handle("recipes:sync", async () => ({ ok: true }));
        api.handle("recipes:check-folder", async ([a]) => {
          const folder = a && typeof a.folder === "string" ? a.folder.trim() : "";
          const home = folder === "" || folder === "~";
          const r = await json2("/api/fs/dirs?path=" + encodeURIComponent(home ? "" : folder) + "&hidden=0").catch(() => null);
          if (!r) return { ok: false, why: "error", message: "Couldn't ask the server." };
          if (r.ok && r.body) return { ok: true, path: String(r.body.path || folder || "~"), exists: true, dir: true };
          const code = r.body && r.body.error;
          if (r.status === 404 && code === "not-found") return { ok: true, path: folder || "~", exists: false, dir: false };
          if (code === "outside-root") return { ok: false, why: "outside-root" };
          if (code === "unreadable") return { ok: false, why: "unreadable" };
          return { ok: false, why: "error", message: reason(r, "The server couldn't check that folder.") };
        });
        async function importSelected(list, { signal } = {}) {
          const out = [];
          const items = Array.isArray(list) ? list : [];
          const t = await target().catch(() => null);
          let stopped = false;
          for (let i = 0; i < items.length; i++) {
            if (stopped || signal && signal.aborted) {
              out.push({ index: i, status: "not-sent" });
              stopped = true;
              continue;
            }
            if (!t) {
              out.push({ index: i, status: "refused", error: "This server has no place to run a program yet.", field: "target" });
              stopped = true;
              continue;
            }
            const m = toEngine(items[i], { targetId: t, imported: true });
            if (!m.ok) {
              out.push({ index: i, status: "refused", error: m.message, field: m.field });
              stopped = true;
              continue;
            }
            const r = await post(m.body, { signal });
            if (r.ok) {
              out.push({ index: i, status: "saved", id: r.record.id, record: r.record, ...r.warning ? { warning: r.warning } : {} });
              continue;
            }
            out.push({ index: i, status: r.unconfirmed ? "unconfirmed" : "refused", error: r.error, ...r.status ? { httpStatus: r.status } : {}, ...r.field ? { field: r.field } : {} });
            stopped = true;
          }
          if (out.some((x) => x.status === "saved")) void changed2();
          return out;
        }
        async function writeApproval(id, patch, { signal, current } = {}) {
          const alive = () => !(signal && signal.aborted) && (typeof current !== "function" || current() !== false);
          const rid = typeof id === "string" ? id : "";
          const want = patch && typeof patch === "object" ? patch.autoApprove : null;
          if (!rid) return { ok: false, field: "id", error: "Choose a recipe." };
          if (!["follow", "on", "off"].includes(want)) return { ok: false, field: "autoApprove", error: "Choose follow, on or off." };
          if (!alive()) return { ok: false, stale: true, error: "Cancelled." };
          const t = await target().catch(() => null);
          if (!t) return { ok: false, field: "target", error: "This server has no place to run a program yet." };
          let list;
          try {
            list = await load();
          } catch (e) {
            return { ok: false, error: "Couldn't read the recipe." };
          }
          const row = rows.get(rid);
          const rec = list.find((r2) => r2.id === rid);
          if (!row || !rec) return { ok: false, status: 404, field: "id", error: "That recipe is gone." };
          const m = toEngine({ ...rec, autoApprove: want, ...want === "on" && patch.disclosed === true ? { disclosed: true } : {} }, { targetId: t, existing: row });
          if (!m.ok) return { ok: false, field: m.field, error: m.message };
          if (!alive()) return { ok: false, stale: true, error: "Cancelled." };
          const r = await post(m.body, { signal });
          if (!r.ok) return { ok: false, error: r.error, ...r.status ? { status: r.status } : {}, ...r.unconfirmed ? { unconfirmed: true } : {}, ...r.field ? { field: r.field } : {} };
          void changed2();
          return { ok: true, record: r.record };
        }
        api.expose("recipes", { importSelected, writeApproval });
      }
      module.exports = { register: register4, copyName };
    }
  });

  // src/renderer/rooms/seat-recipes.js
  var seat_recipes_exports = {};
  __export(seat_recipes_exports, {
    SEAT_VENDORS: () => SEAT_VENDORS,
    WORDS: () => WORDS,
    applies: () => applies,
    programName: () => programName,
    refusal: () => refusal,
    seatRecipes: () => seatRecipes
  });
  var SEAT_VENDORS, web, WORDS, seatRecipes, programName, refusal, applies;
  var init_seat_recipes = __esm({
    "src/renderer/rooms/seat-recipes.js"() {
      init_globals();
      SEAT_VENDORS = Object.freeze(["claude-code", "codex-cli"]);
      web = () => !!(globalThis.wb && globalThis.wb.web);
      WORDS = Object.freeze({
        rule: "Claude Code and Codex can join a room. Gemini opens as a terminal.",
        noClaude: "No Claude agent yet.",
        terminalOnly: "Opens as a terminal. It can't join a room.",
        programsLine: "Opens as a terminal.",
        programsRoomLine: "Opens in a room or as a terminal."
      });
      seatRecipes = (list) => (Array.isArray(list) ? list : []).filter((rc) => !web() || rc && SEAT_VENDORS.includes(rc.vendor));
      programName = (rc) => ({ "codex-cli": "Codex", "gemini-cli": "Gemini", ollama: "Ollama", "cli-manager": "Shell" })[rc && rc.vendor] || rc && rc.name || "That program";
      refusal = (rc) => web() && rc && !SEAT_VENDORS.includes(rc.vendor) ? programName(rc) + " can't join a room yet. Open it from Terminals instead." : null;
      applies = web;
    }
  });

  // web/handlers/seat-rule.js
  var require_seat_rule = __commonJS({
    "web/handlers/seat-rule.js"(exports, module) {
      "use strict";
      init_globals();
      var rule = (init_seat_recipes(), __toCommonJS(seat_recipes_exports));
      function register4(api) {
        api.expose("seat", Object.freeze({ seatRecipes: rule.seatRecipes, refusal: rule.refusal, applies: rule.applies, programName: rule.programName, WORDS: rule.WORDS, SEAT_VENDORS: rule.SEAT_VENDORS }));
      }
      module.exports = { register: register4 };
    }
  });

  // web/lib/pty-link.js
  var require_pty_link = __commonJS({
    "web/lib/pty-link.js"(exports, module) {
      "use strict";
      init_globals();
      var PING_MS = 1e4;
      var DEAD_MS = 3e4;
      var RECONNECT_MS = 1e3;
      var QUEUEABLE = /* @__PURE__ */ new Set(["attach", "resize", "attention.ack", "ping"]);
      function createLink({ url, WebSocketImpl = globalThis.WebSocket, timers, onFrame = () => {
      }, onStatus = () => {
      } }) {
        const T = timers || { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (t) => globalThis.clearTimeout(t), setInterval: (f, ms) => globalThis.setInterval(f, ms), clearInterval: (t) => globalThis.clearInterval(t), now: () => Date.now() };
        let ws = null;
        let status = "connecting";
        let stopped = false;
        let beat = null;
        let retry = null;
        let lastInbound = 0;
        const outbox = [];
        const setStatus = (s) => {
          if (s !== status) {
            status = s;
            onStatus(s);
          }
        };
        const OPEN = WebSocketImpl && WebSocketImpl.OPEN || 1;
        function stopBeat() {
          if (beat) {
            T.clearInterval(beat);
            beat = null;
          }
        }
        function startBeat() {
          stopBeat();
          lastInbound = T.now();
          beat = T.setInterval(() => {
            if (!ws || ws.readyState !== OPEN) return;
            if (T.now() - lastInbound > DEAD_MS) {
              try {
                ws.close();
              } catch (e) {
              }
              return;
            }
            try {
              ws.send(JSON.stringify({ type: "ping" }));
            } catch (e) {
            }
          }, PING_MS);
        }
        function connect() {
          if (stopped) return;
          let s;
          try {
            s = new WebSocketImpl(typeof url === "function" ? url() : url);
          } catch (e) {
            retry = T.setTimeout(connect, RECONNECT_MS);
            setStatus("closed");
            return;
          }
          ws = s;
          s.onopen = () => {
            if (ws !== s) return;
            startBeat();
            setStatus("open");
            while (outbox.length && ws.readyState === OPEN) ws.send(JSON.stringify(outbox.shift()));
          };
          s.onclose = () => {
            if (ws !== s) return;
            ws = null;
            stopBeat();
            setStatus("closed");
            if (!stopped) retry = T.setTimeout(connect, RECONNECT_MS);
          };
          s.onerror = () => {
            try {
              s.close();
            } catch (e) {
            }
          };
          s.onmessage = (ev) => {
            if (ws !== s) return;
            lastInbound = T.now();
            let msg = null;
            try {
              msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
            } catch (e) {
              return;
            }
            if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.type !== "string" || msg.type === "pong") return;
            try {
              onFrame(msg);
            } catch (e) {
            }
          };
        }
        connect();
        return {
          /** true: sent now. false: not open (only a queueable frame is kept for when it opens). */
          send(frame) {
            if (ws && ws.readyState === OPEN) {
              ws.send(JSON.stringify(frame));
              return true;
            }
            if (frame && QUEUEABLE.has(frame.type)) {
              for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].type === frame.type && outbox[i].paneid === frame.paneid) outbox.splice(i, 1);
              outbox.push(frame);
            }
            return false;
          },
          get status() {
            return status;
          },
          get open() {
            return !!ws && ws.readyState === OPEN;
          },
          close() {
            stopped = true;
            stopBeat();
            if (retry) T.clearTimeout(retry);
            try {
              if (ws) ws.close();
            } catch (e) {
            }
            ws = null;
          },
          _outbox: outbox
        };
      }
      module.exports = { createLink, PING_MS, DEAD_MS, RECONNECT_MS };
    }
  });

  // web/handlers/session.js
  var require_session = __commonJS({
    "web/handlers/session.js"(exports, module) {
      "use strict";
      init_globals();
      var { createLink } = require_pty_link();
      var PERMIT_MS = 6e4;
      var TAB_KEY = "wb-web.tab.v1";
      var HUE = 215;
      var hueOf = (name2) => {
        let h = 0;
        for (const c of String(name2 || "")) h = h * 31 + c.charCodeAt(0) >>> 0;
        return name2 ? h % 360 : HUE;
      };
      var TAKE_MS = 2500;
      var ID2 = /^[A-Za-z0-9._:#%-]{1,160}$/;
      function tabLabel(win = globalThis) {
        let id = null;
        try {
          id = win.sessionStorage && win.sessionStorage.getItem(TAB_KEY);
        } catch (e) {
          id = null;
        }
        if (!id || !/^[0-9a-f]{6}$/.test(id)) {
          id = hex().slice(0, 6);
          try {
            if (win.sessionStorage) win.sessionStorage.setItem(TAB_KEY, id);
          } catch (e) {
          }
        }
        return "Web " + id;
      }
      var hex = () => {
        const b = new Uint8Array(12);
        const c = globalThis.crypto;
        if (c && c.getRandomValues) c.getRandomValues(b);
        else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
        return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      };
      function register4(api) {
        const handlers = /* @__PURE__ */ new Map();
        const handle = (chan, fn) => {
          handlers.set(chan, fn);
          api.handle(chan, fn);
        };
        const opts = api.sessionOptions || {};
        const sessions = /* @__PURE__ */ new Map();
        const byPane = /* @__PURE__ */ new Map();
        const permits = /* @__PURE__ */ new Map();
        let nextSid = 1;
        let startupUsed = false;
        let startupTerminal = false;
        let link = null;
        let shellId = null;
        let targetId = null;
        const now = opts.now || Date.now;
        let labelCache = opts.label || null;
        const label = () => labelCache = labelCache || tabLabel();
        const defer = opts.defer || ((f) => setTimeout(f, 0));
        const emit = (c, p) => api.emit(c, p);
        const controlFns = /* @__PURE__ */ new Set();
        const controlState = (s) => s.term ? null : !s.ready ? "away" : s.controlling ? "typing" : "watching";
        const control = (s, extra) => {
          const st = controlState(s);
          if (st === null) return;
          const m = { sid: s.sid, state: st, ...extra || {} };
          for (const fn of [...controlFns]) {
            try {
              fn(m);
            } catch (e) {
            }
          }
        };
        const ptyUrl = () => opts.url || (globalThis.location && globalThis.location.protocol === "https:" ? "wss" : "ws") + "://" + globalThis.location.host + "/pty";
        const row = (s) => ({
          sid: s.sid,
          wid: 1,
          title: s.title,
          name: s.name,
          hue: s.hue,
          hidden: false,
          flowing: s.flowing,
          needsYou: null,
          place: "This server",
          login: "",
          folder: s.folder || "~",
          recipeId: s.recipeId || null,
          accountId: null,
          accountLabel: null,
          realmName: null,
          lastUsed: s.lastInput || s.created,
          launchWord: null,
          keepsRunning: !s.term,
          termOf: s.termOf || null,
          serverId: "local",
          bsid: s.paneid,
          launchDone: !!(s.route && (s.route.state === "finished" || s.route.state === "stopped")),
          resumable: false,
          stopped: null,
          launchAt: s.route && s.route.since ? s.route.since : null
        });
        const list = () => [...sessions.values()].map(row);
        const broadcast = () => emit("sessions:update", list());
        const routeOf = (s, patch) => {
          s.route = { ...s.route, ...patch };
          emit("session:route", { sid: s.sid, ...s.route });
        };
        async function json2(path, init) {
          const res = await api.engine.fetch(path, init);
          let body = null;
          try {
            body = await res.json();
          } catch (e) {
            body = null;
          }
          return { status: res.status, ok: res.ok, body };
        }
        const post = (path, body) => json2(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
        function ensureLink() {
          if (link) return link;
          link = createLink({ url: ptyUrl, WebSocketImpl: opts.WebSocketImpl, timers: opts.timers, onFrame, onStatus });
          return link;
        }
        let opened = false;
        function onStatus(st) {
          if (st === "closed") {
            for (const s of sessions.values()) {
              if (s.ready) {
                s.ready = false;
                routeOf(s, { state: "reconnecting" });
                control(s);
              }
            }
          } else if (st === "open") {
            if (opened) {
              for (const s of sessions.values()) if (!s.ended) reattach(s);
            }
            opened = true;
          }
        }
        const attachFrame = (s, extra) => ({ type: "attach", paneid: s.paneid, label: label(), ...extra });
        function reattach(s) {
          link.send(attachFrame(s, { intent: s.term && !s.controlOnOpen ? "view" : "reclaim", reattachOnly: true }));
        }
        function bind(s) {
          if (!byPane.has(s.paneid)) byPane.set(s.paneid, /* @__PURE__ */ new Set());
          byPane.get(s.paneid).add(s.sid);
        }
        function unbind(s) {
          const set = byPane.get(s.paneid);
          if (set) {
            set.delete(s.sid);
            if (!set.size) byPane.delete(s.paneid);
          }
        }
        function deliver(s, data) {
          if (s.holding) {
            s.queue.push(data);
            return;
          }
          emit("session:data", { sid: s.sid, data });
        }
        function release(s) {
          if (!s.holding) return;
          s.holding = false;
          const q = s.queue;
          s.queue = [];
          for (const d of q) emit("session:data", { sid: s.sid, data: d });
        }
        function finish(s, code) {
          s.ended = true;
          s.ready = false;
          if (s.shell) {
            emit("session:exit", { sid: s.sid });
            sessions.delete(s.sid);
            unbind(s);
            broadcast();
            return;
          }
          routeOf(s, { state: s.term ? "term-closed" : "finished", code: Number.isInteger(code) ? code : null, since: now() });
          broadcast();
        }
        function onFrame(m) {
          const set = m && typeof m.paneid === "string" ? byPane.get(m.paneid) : null;
          if (!set) return;
          for (const sid of [...set]) {
            const s = sessions.get(sid);
            if (!s) continue;
            switch (m.type) {
              case "pane.control": {
                const had = s.controlling;
                s.controlling = m.controlling === true;
                if (s.ready && had !== s.controlling) control(s);
                if (s.term && s.ready) routeOf(s, { state: s.controlling ? "controlling" : "viewing" });
                if (s.controlling && s.takeWaiters) {
                  for (const f of s.takeWaiters.splice(0)) f(true);
                }
                break;
              }
              case "pane.control-lost": {
                const had = s.controlling;
                s.controlling = false;
                if (s.term && s.ready) routeOf(s, { state: "viewing" });
                else if (s.ready) control(s, { lost: had === true });
                break;
              }
              case "pane.control-denied":
                break;
              // the watching strip says it; the generic "typing paused" is for a lost connection only
              case "pane.ready":
                s.ready = true;
                s.ended = false;
                s.expectReplay = m.reattached === true;
                if (typeof m.title === "string" && m.title) s.title = m.title.slice(0, 120);
                if (m.prefs && typeof m.prefs.friendlyName === "string" && m.prefs.friendlyName) {
                  s.name = m.prefs.friendlyName.slice(0, 60);
                  s.hue = hueOf(s.name);
                }
                routeOf(s, { state: s.term ? s.controlling ? "controlling" : "viewing" : "up" });
                control(s);
                if (s.cols > 0 && s.rows > 0) link.send({ type: "resize", paneid: s.paneid, cols: s.cols, rows: s.rows });
                broadcast();
                break;
              case "pane.data":
                if (s.expectReplay) {
                  s.expectReplay = false;
                  emit("session:gap", { sid: s.sid, replay: String(m.data || "") });
                } else deliver(s, String(m.data == null ? "" : m.data));
                break;
              case "pane.reattached":
                s.expectReplay = false;
                break;
              case "pane.exit":
                finish(s, m.code);
                break;
              case "pane.needs-launch":
                s.ended = true;
                s.ready = false;
                routeOf(s, { state: "finished", code: null, message: String(m.message || "").slice(0, 200), since: now() });
                broadcast();
                break;
              case "pane.error":
                s.ended = true;
                s.ready = false;
                routeOf(s, { state: "spawn-failed", message: String(m.message || "The server could not start this.").slice(0, 200) });
                broadcast();
                break;
              case "pane.title":
                if (typeof m.title === "string" && m.title) {
                  s.title = m.title.slice(0, 120);
                  broadcast();
                }
                break;
              case "pane.state": {
                const f = m.state === "streaming";
                if (f !== s.flowing) {
                  s.flowing = f;
                  broadcast();
                }
                break;
              }
              default:
                break;
            }
          }
        }
        async function target() {
          if (targetId) return targetId;
          const r = await json2("/api/targets");
          const t = r.ok && r.body && Array.isArray(r.body.targets) ? r.body.targets.find((x) => x && x.id === "local") || r.body.targets[0] : null;
          targetId = t && typeof t.id === "string" ? t.id : null;
          return targetId;
        }
        let recipeNames = null, recipeNamesAt = 0;
        async function recipeName(id) {
          if (!recipeNames || now() - recipeNamesAt > 3e4) {
            const r = await json2("/api/recipes").catch(() => null);
            recipeNames = new Map((r && r.ok && r.body && r.body.recipes || []).map((x) => [x.id, x.name]));
            recipeNamesAt = now();
          }
          return recipeNames.get(id) || null;
        }
        async function paneName(paneid) {
          const r = await json2("/api/table");
          const row2 = r.ok && r.body && Array.isArray(r.body.sessions) ? r.body.sessions.find((x) => x && x.paneid === paneid) : null;
          if (row2 && row2.friendlyName) return String(row2.friendlyName).slice(0, 60);
          const m = /^recipe:([^#]+)/.exec(paneid);
          return m && await recipeName(m[1]) || "";
        }
        async function shellRecipe() {
          if (shellId) return shellId;
          const r = await json2("/api/recipes");
          const rows = r.ok && r.body && Array.isArray(r.body.recipes) ? r.body.recipes : [];
          const have = rows.find((x) => x && x.vendor === "cli-manager" && x.name === "Shell");
          if (have) {
            shellId = have.id;
            return shellId;
          }
          const t = await target();
          if (!t) return null;
          const made = await post("/api/recipes", { name: "Shell", target: t, vendor: "cli-manager", projectDir: null });
          shellId = made.ok && made.body && made.body.recipe ? made.body.recipe.id : null;
          return shellId;
        }
        async function liveShellPane(rid) {
          const r = await json2("/api/table");
          const rows = r.ok && r.body && Array.isArray(r.body.sessions) ? r.body.sessions : [];
          const mine = rows.find((x) => x && typeof x.paneid === "string" && x.paneid.startsWith("recipe:" + rid) && x.state === "live");
          return mine && ID2.test(mine.paneid) ? mine.paneid : null;
        }
        async function launchRecipe(rid, extra) {
          const r = await post("/api/recipes/" + encodeURIComponent(rid) + "/launch", { target: "tab", ...extra });
          if (!r.ok || !r.body || typeof r.body.paneid !== "string") {
            const why = r.body && typeof r.body.error === "string" ? r.body.error : "The server would not start it.";
            return { error: r.status === 409 ? why : why };
          }
          return { paneid: r.body.paneid };
        }
        async function seatPane(room, seat) {
          const r = await json2("/api/rooms/" + encodeURIComponent(String(room)) + "?art=ref");
          const seats = r.ok && r.body && Array.isArray(r.body.seats) ? r.body.seats : [];
          const st = seats.find((x) => x && String(x.id) === String(seat));
          const id = st && st.occupant && typeof st.occupant.id === "string" ? st.occupant.id : null;
          return id && ID2.test(id) ? id : null;
        }
        const permitOk = (token) => {
          for (const [k, exp] of permits) if (exp < now()) permits.delete(k);
          if (typeof token !== "string" || !permits.has(token)) return false;
          permits.delete(token);
          return true;
        };
        handle("session:permit", async () => {
          const t = hex();
          permits.set(t, now() + PERMIT_MS);
          if (permits.size > 50) permits.delete(permits.keys().next().value);
          return t;
        });
        async function adoptRunning() {
          let rows = [];
          try {
            const r = await json2("/api/table");
            rows = r.ok && r.body && Array.isArray(r.body.sessions) ? r.body.sessions : [];
          } catch (e) {
            return;
          }
          for (const x of rows) {
            if (!x || typeof x.paneid !== "string" || x.state !== "live" || !/^recipe:[A-Za-z0-9._-]+$/.test(x.paneid) || byPane.has(x.paneid)) continue;
            const s = {
              sid: nextSid++,
              paneid: x.paneid,
              title: String(x.friendlyName || x.agent || "Terminal").slice(0, 120),
              name: String(x.friendlyName || "").slice(0, 60),
              hue: hueOf(x.friendlyName),
              folder: typeof x.project === "string" ? x.project : "~",
              recipeId: x.paneid.slice("recipe:".length),
              term: false,
              termOf: null,
              shell: false,
              controlOnOpen: false,
              launchRecipe: x.paneid.slice("recipe:".length),
              ready: false,
              ended: false,
              controlling: false,
              flowing: false,
              holding: true,
              queue: [],
              cols: 0,
              rows: 0,
              created: now(),
              lastInput: 0,
              expectReplay: false,
              takeWaiters: [],
              route: null
            };
            s.route = { state: "connecting", route: "broker", serverId: "local", serverName: "the server", login: "", since: now(), recipeId: s.recipeId };
            sessions.set(s.sid, s);
            bind(s);
            ensureLink().send(attachFrame(s, { intent: "reclaim", reattachOnly: true }));
            emit("session:adopt", { sid: s.sid, title: s.title, name: s.name, hue: s.hue, snapshot: null, dropX: null });
          }
          broadcast();
        }
        handle("session:create", async ([a]) => {
          const cols = a && Number.isInteger(a.cols) ? a.cols : 0;
          const rows = a && Number.isInteger(a.rows) ? a.rows : 0;
          const spec = a && a.spec && typeof a.spec === "object" ? a.spec : {};
          const term = spec.route === "term";
          const attachOnly = spec.attachOnly === true && typeof spec.bsid === "string";
          const s = {
            sid: 0,
            paneid: "",
            title: "Terminal",
            name: "",
            hue: HUE,
            folder: typeof spec.folder === "string" ? spec.folder : "~",
            recipeId: null,
            term,
            termOf: null,
            shell: false,
            controlOnOpen: false,
            ready: false,
            ended: false,
            controlling: false,
            flowing: false,
            holding: true,
            queue: [],
            cols,
            rows,
            created: now(),
            lastInput: 0,
            expectReplay: false,
            takeWaiters: [],
            route: null
          };
          let frame;
          if (term) {
            if (!spec.room || !spec.seat) return { error: "Choose a seat to watch." };
            const paneid = await seatPane(spec.room, spec.seat).catch(() => null);
            if (!paneid) return { error: "That seat isn't running." };
            s.paneid = paneid;
            s.controlOnOpen = spec.controlOnOpen === true;
            s.termOf = { roomId: String(spec.room), seatId: String(spec.seat), handle: String(spec.handle || ""), roomName: String(spec.roomName || "") };
            frame = attachFrame(s, { intent: s.controlOnOpen ? "reclaim" : "view", reattachOnly: true });
          } else if (spec.spawnPane && typeof spec.spawnPane.paneid === "string") {
            if (!permitOk(a && a.permit)) return { error: "a CLI starts only from an explicit launch" };
            const pid = spec.spawnPane.paneid, rid = typeof spec.spawnPane.recipe === "string" ? spec.spawnPane.recipe : "";
            if (!ID2.test(pid) || !/^[A-Za-z0-9_-]{1,80}$/.test(rid)) return { error: "Choose a seat to start." };
            const have = byPane.get(pid);
            if (have && have.size) {
              const sid0 = [...have][0];
              const e0 = sessions.get(sid0);
              if (e0 && !e0.ended) return { sid: sid0, title: e0.title, name: e0.name, hue: e0.hue, route: e0.route };
            }
            s.paneid = pid;
            s.recipeId = rid;
            s.launchRecipe = rid;
            s.name = await recipeName(rid).catch(() => null) || "";
            s.hue = hueOf(s.name);
            frame = attachFrame(s, { recipe: rid, spawn: true });
          } else if (attachOnly) {
            if (!ID2.test(spec.bsid)) return { error: "Choose a session to open." };
            s.paneid = spec.bsid;
            s.name = await paneName(s.paneid).catch(() => "");
            s.hue = hueOf(s.name);
            frame = attachFrame(s, { intent: "reclaim", reattachOnly: true });
          } else {
            const startup = !(a && a.permit) && a && a.why === "startup" && !startupUsed && !spec.recipeId;
            if (startup) {
              startupUsed = true;
              startupTerminal = true;
            } else if (!permitOk(a && a.permit)) return { error: "a CLI starts only from an explicit launch" };
            let rid = typeof spec.recipeId === "string" && spec.recipeId ? spec.recipeId : null;
            if (!rid) {
              rid = await shellRecipe().catch(() => null);
              s.shell = true;
            }
            if (!rid) return { error: "This server has no shell to start yet." };
            s.recipeId = s.shell ? null : rid;
            s.launchRecipe = rid;
            s.name = await recipeName(rid).catch(() => null) || (s.shell ? "Shell" : "");
            s.hue = hueOf(s.name);
            const running = startup ? await liveShellPane(rid).catch(() => null) : null;
            if (running) {
              s.paneid = running;
              frame = attachFrame(s, { intent: "reclaim", reattachOnly: true });
            } else {
              const extra = {};
              if (typeof spec.resumeSessionId === "string") extra.resumeSessionId = spec.resumeSessionId;
              const l = await launchRecipe(rid, extra).catch(() => ({ error: "Couldn't reach the server." }));
              if (l.error) return { error: l.error };
              s.paneid = l.paneid;
              frame = attachFrame(s, { recipe: rid, spawn: true });
            }
          }
          s.sid = nextSid++;
          s.route = { state: "connecting", route: term ? "term" : "broker", serverId: "local", serverName: "the server", login: "", since: now(), ...s.recipeId ? { recipeId: s.recipeId } : {}, ...term ? { handle: s.termOf.handle, roomName: s.termOf.roomName } : {} };
          sessions.set(s.sid, s);
          bind(s);
          ensureLink().send(frame);
          if (cols > 0 && rows > 0) link.send({ type: "resize", paneid: s.paneid, cols, rows });
          broadcast();
          defer(() => release(s));
          if (startupTerminal) {
            startupTerminal = false;
            void adoptRunning();
          }
          return { sid: s.sid, title: s.title, name: s.name, hue: s.hue, route: s.route };
        });
        const of = (sid) => sessions.get(sid) || null;
        api.on("session:input", ([a]) => {
          const s = a && of(a.sid);
          if (!s || typeof a.data !== "string") return;
          s.lastInput = now();
          if (s.ready && !s.controlling && !s.term) return;
          if (!s.ready || !s.controlling || !link || !link.send({ type: "input", paneid: s.paneid, data: a.data })) {
            if (!s.term) emit("session:typing-paused", { sid: s.sid });
          }
        });
        api.on("session:resize", ([a]) => {
          const s = a && of(a.sid);
          if (!s || !(a.cols > 0) || !(a.rows > 0)) return;
          s.cols = Math.floor(a.cols);
          s.rows = Math.floor(a.rows);
          if (link && s.ready && s.controlling) link.send({ type: "resize", paneid: s.paneid, cols: s.cols, rows: s.rows });
        });
        api.on("session:attached", ([a]) => {
          const s = a && of(a.sid);
          if (!s) return;
          if (a.cols > 0 && a.rows > 0) {
            s.cols = a.cols;
            s.rows = a.rows;
            if (link && s.ready && s.controlling) link.send({ type: "resize", paneid: s.paneid, cols: s.cols, rows: s.rows });
          }
          release(s);
        });
        api.on("session:close", ([sid]) => {
          const s = of(sid);
          if (!s) return;
          sessions.delete(s.sid);
          unbind(s);
          if (!s.term && !s.ended) void post("/api/sessions/" + encodeURIComponent(s.paneid) + "/end", {}).catch(() => {
          });
          broadcast();
        });
        api.on("session:title", ([a]) => {
          const s = a && of(a.sid);
          if (s && typeof a.title === "string" && a.title) {
            s.title = a.title.slice(0, 120);
            broadcast();
          }
        });
        api.on("session:meta", ([a]) => {
          const s = a && of(a.sid);
          if (!s) return;
          s.name = String(a.name || "").slice(0, 60);
          const h = Math.round(Number(a.hue));
          if (!Number.isNaN(h)) s.hue = Math.max(0, Math.min(360, h));
          broadcast();
        });
        api.on("session:seen", ([a]) => {
          const s = a && of(a.sid);
          if (s && link && s.ready && typeof a.how === "string") link.send({ type: "attention.ack", paneid: s.paneid, how: a.how.slice(0, 20) });
        });
        api.on("session:open", () => {
        });
        api.on("session:retry", ([a]) => {
          void retry(a).catch(() => {
          });
        });
        async function retry(a) {
          const s = a && of(a.sid);
          if (!s || s.term) return;
          if (permitOk(a.permit) && s.launchRecipe) {
            const l = await launchRecipe(s.launchRecipe, a.fresh === true ? { fresh: true } : {}).catch(() => ({ error: "Couldn't reach the server." }));
            if (l.error) {
              routeOf(s, { state: "spawn-failed", message: l.error });
              return;
            }
            unbind(s);
            s.paneid = l.paneid;
            bind(s);
            s.ended = false;
            s.holding = false;
            routeOf(s, { state: "connecting", since: now() });
            ensureLink().send(attachFrame(s, { recipe: s.launchRecipe, spawn: true }));
            return;
          }
          if (link && !s.ended) reattach(s);
        }
        handle("session:term-control", async ([a]) => {
          const s = a && of(a.sid);
          if (!s || !s.term || !link) return false;
          if (a.take !== true) return false;
          if (s.controlling) return true;
          return new Promise((resolve) => {
            const t = setTimeout(() => {
              s.takeWaiters = s.takeWaiters.filter((f) => f !== done);
              resolve(false);
            }, TAKE_MS);
            const done = (v) => {
              clearTimeout(t);
              resolve(v);
            };
            s.takeWaiters.push(done);
            link.send({ type: "takeControl", paneid: s.paneid, label: label(), id: hex() });
          });
        });
        function take(s) {
          if (!s || s.term || !link) return Promise.resolve(false);
          if (s.controlling) return Promise.resolve(true);
          return new Promise((resolve) => {
            const t = setTimeout(() => {
              s.takeWaiters = s.takeWaiters.filter((f) => f !== done);
              resolve(false);
            }, TAKE_MS);
            const done = (v) => {
              clearTimeout(t);
              resolve(v);
            };
            s.takeWaiters.push(done);
            link.send({ type: "takeControl", paneid: s.paneid, label: label(), id: hex() });
          });
        }
        api.expose("terminal", {
          onControl(fn) {
            controlFns.add(fn);
            for (const s of sessions.values()) if (s.ready) control(s);
            return () => controlFns.delete(fn);
          },
          state: (sid) => {
            const s = sessions.get(sid);
            return s ? controlState(s) : null;
          },
          takeControl: (sid) => take(sessions.get(sid))
        });
        const create = async (spec, { cols = 100, rows = 30, why = "launch" } = {}) => handlers.get("session:create")([{ cols, rows, spec, permit: await handlers.get("session:permit")([], {}), why }], {});
        api.expose("sessions", {
          // a hosted room seat's Start: spawn the seat's pane through this page's /pty link and keep it attached; {sid, route} or {error}
          spawnSeat: (paneid, recipeId, opts2) => typeof paneid === "string" && paneid && typeof recipeId === "string" && recipeId ? create({ route: "local", spawnPane: { paneid, recipe: recipeId } }, opts2) : Promise.resolve({ error: "Choose a seat to start." }),
          // lets go of this page's record of a session WITHOUT ending the pane (session:close ends a pane the person started)
          release(sid) {
            const s = sessions.get(sid);
            if (!s) return false;
            sessions.delete(s.sid);
            unbind(s);
            broadcast();
            return true;
          }
        });
        return { dispose() {
          if (link) link.close();
          link = null;
          sessions.clear();
          byPane.clear();
        } };
      }
      module.exports = { register: register4, PERMIT_MS, tabLabel };
    }
  });

  // web/handlers/sessions-broker.js
  var require_sessions_broker = __commonJS({
    "web/handlers/sessions-broker.js"(exports, module) {
      "use strict";
      init_globals();
      var POLL_MS = 15e3;
      var PANE = /^[A-Za-z0-9._:#%-]{1,120}$/;
      var scopeOf = (s) => s && typeof s === "object" && Number.isSafeInteger(s.selectionVersion) ? { accountId: typeof s.accountId === "string" ? s.accountId : null, selectionVersion: s.selectionVersion } : { accountId: null, selectionVersion: 0 };
      var offerView = (s) => ({ ...scopeOf(s), offer: null, recent: [] });
      function groupFrom(panes) {
        const rows = panes.filter((p) => p && typeof p.paneid === "string").map((p) => ({
          bsid: p.paneid,
          name: String(p.name || "Terminal").slice(0, 80),
          folder: typeof p.folder === "string" && p.folder ? p.folder : "~",
          startedOn: "This server",
          recipeId: typeof p.recipeId === "string" ? p.recipeId : null,
          hue: null,
          alive: p.alive !== false,
          endedAt: Number.isFinite(p.endedAt) ? p.endedAt : null,
          exitCode: Number.isInteger(p.exitCode) ? p.exitCode : null,
          createdAt: Number.isFinite(p.startedAt) ? p.startedAt : 0,
          openSid: null,
          openWid: null
        }));
        return { serverId: "local", serverName: "This server", login: "", ok: true, state: "live", protocol: null, live: rows.filter((r) => r.alive).length, cap: null, draining: false, graceUntil: 0, rows };
      }
      function register4(api) {
        const timers = api.timers || { setInterval: (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: (t) => globalThis.clearInterval(t) };
        let poll = null;
        let last = "";
        async function groups() {
          let res;
          try {
            res = await api.engine.fetch("/api/sessions");
          } catch (e) {
            return [];
          }
          if (!res.ok) return [];
          let body = null;
          try {
            body = await res.json();
          } catch (e) {
            body = null;
          }
          const panes = body && Array.isArray(body.sessions) ? body.sessions : Array.isArray(body) ? body : [];
          return [groupFrom(panes)];
        }
        async function refresh() {
          const g = await groups();
          const text3 = JSON.stringify(g);
          if (text3 !== last) {
            last = text3;
            api.emit("broker:groups", { ...scopeOf(null), groups: g, keptRunning: 0 });
          }
          return g;
        }
        const hidden = () => !!(globalThis.document && globalThis.document.hidden);
        function startPoll() {
          if (poll) return;
          poll = timers.setInterval(() => {
            if (!hidden()) void refresh();
          }, POLL_MS);
          if (poll && poll.unref) poll.unref();
        }
        api.handle("sessions:offer", async () => offerView());
        api.handle("sessions:dismiss", async ([scope]) => {
          try {
            await api.engine.fetch("/api/interrupted/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          } catch (e) {
          }
          return offerView(scope);
        });
        api.handle("sessions:remove", async ([, scope]) => offerView(scope));
        api.handle("sessions:restore-spec", async () => null);
        api.handle("broker:groups", async () => {
          startPoll();
          const g = await refresh();
          return g;
        });
        api.handle("broker:end", async ([a]) => {
          const pane = a && typeof a.bsid === "string" ? a.bsid : "";
          if (!PANE.test(pane)) return { ok: false, error: "Choose a session to end." };
          let res;
          try {
            res = await api.engine.fetch("/api/sessions/" + encodeURIComponent(pane) + "/end", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          } catch (e) {
            return { ok: false, error: "Couldn't reach the server." };
          }
          if (res.status === 404) return { ok: false, error: "That session is already gone." };
          if (!res.ok) return { ok: false, error: "The server wouldn't end that session." };
          setTimeout(() => void refresh(), 600);
          return { ok: true };
        });
      }
      module.exports = { register: register4, groupFrom, offerView, POLL_MS };
    }
  });

  // web/handlers/setup-settings.js
  var require_setup_settings = __commonJS({
    "web/handlers/setup-settings.js"(exports, module) {
      "use strict";
      init_globals();
      module.exports = { register: (init_setup_settings(), __toCommonJS(setup_settings_exports)).register };
    }
  });

  // web/handlers/storage.js
  var require_storage = __commonJS({
    "web/handlers/storage.js"(exports, module) {
      "use strict";
      init_globals();
      function register4(api) {
        const held = globalThis.__wbPersonStorage;
        delete globalThis.__wbPersonStorage;
        api.expose("storage", Object.freeze({ clear: () => {
          if (held) held.clear();
        } }));
      }
      module.exports = { register: register4 };
    }
  });

  // wb-web-entry.js
  init_globals();
  var probe = require_session_probe();
  var answer = probe.askEngine();
  globalThis.__wbPersonStorage = require_person_storage().install({ answer });
  probe.syncMarker({ answer, fs: require_fs() });
  require_preload();
  var rt2 = require_runtime();
  rt2.boot([require_platform().register, require_rooms2().register, require_agents().register, require_browser_actions().register, require_capabilities().register, require_files().register, (init_modules(), __toCommonJS(modules_exports)).register, require_notifications().register, require_prefs_programs().register, require_recipe_import2().register, require_recipes2().register, require_seat_rule().register, require_session().register, require_sessions_broker().register, require_setup_settings().register, require_storage().register]);
})();
