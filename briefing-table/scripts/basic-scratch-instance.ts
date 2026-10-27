/**
 * A SCRATCH BASIC INSTANCE (ticket, Owner [ref]): the hosted Workbench exactly as the hosted server runs it, on any machine,
 * for tests. No VPS, no sudo, no real vendor accounts.
 *
 *   npx tsx scripts/basic-scratch-instance.ts [--keep] [--no-fake-vendors]      boots one, prints its address, waits for Ctrl-C
 *   import { startScratchBasic } from './basic-scratch-instance.ts'               for a test: await start, use, await stop
 *
 * What it does (the same steps runtime's add-hosted-user takes, minus the Linux user):
 *   1. provisions an instance with the REAL scripts/hosted-workbench.ts into a temp home (edition basic, strict
 *      accounts, no desktop, Fabric/NATS off, a LOCAL broker with its bearer, target shell /bin/bash, data dir under
 *      <home>/.workbench);
 *   2. starts that instance's pty-broker and engine from ITS env files, through the shared code (read-only: the repo
 *      is never written; test/hosted-instance.test.mjs proves that);
 *   3. puts FAKE `claude` and `codex` programs first on the instance's PATH (unless --no-fake-vendors), so a switch,
 *      a restore or a quota-less launch can be tested with no model and no login;
 *   4. waits for /health, and tears everything down (process groups killed, ports freed, temp home removed).
 * Ports come from the shared scratch table (test/_scratch.mjs slots 500/501), never 7420/7430/8201, and the child env is
 * scrubbed of every PTY_BROKER_* / HARBOR_WB_* key from the caller, with Fabric and NATS pinned off.
 * Additive: it edits no engine code and does not touch hosted-workbench.ts or launch.ts.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-expect-error: a plain .mjs helper shared with the test suites
import { P, assertFree, childEnv } from '../test/_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

/** Scratch slots in test/_scratch.mjs's port table (engine, broker). */
export const SCRATCH_ENGINE_SLOT = 500;
export const SCRATCH_BROKER_SLOT = 501;

/** An authenticated browser-equivalent client for one scratch instance (the person's session cookie). */
export interface ScratchClient {
  cookie: string;
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, json?: unknown): Promise<{ status: number; body: any }>;
}

/** A password that passes the identity policy (the same shape test/identity-engine.test.mjs uses). */
export const SCRATCH_PASSWORD = 'Correct-Horse-Battery-9!';

export interface ScratchBasic {
  user: string;
  home: string;
  dataDir: string;
  port: number;
  brokerPort: number;
  base: string;
  /** the instance's own env (workbench.env parsed), for tests that want to read a setting */
  env: Record<string, string>;
  /** the one-time password hosted-workbench.ts printed for the account */
  tempPassword: string;
  enginePid: number;
  brokerPid: number;
  /** SIGKILL the engine (a crash: the broker and its sessions stay) and start it again from the same env, plus
   *  `extraEnv` (a key set to null is removed). Resolves when /health answers with the broker up. */
  restartEngine(extraEnv?: Record<string, string | null>): Promise<void>;
  engineLog(): string;
  brokerLog(): string;
  /** Sign in as the instance's account like the person does (the one-time password, then the forced change) and
   *  return a client that speaks for the USER on the room routes. Cached: a second call returns the same client. */
  signIn(): Promise<ScratchClient>;
  /** kill both process groups, wait for the ports to free, remove the home unless `keep` */
  stop(opts?: { keep?: boolean }): Promise<void>;
}

/* FIRST-RUN REALISM (Owner [ref], ticket): a fake `claude` that behaves like the REAL one on a user's first launch, so the
 * problems a person meets on day one fail here, on the server, instead of on their phone:
 *  - a folder with no `hasTrustDialogAccepted` in ~/.claude.json gets the real "Accessing workspace / Quick safety check"
 *    trust dialog whose default selection is "No, exit" (the design notes F7): Enter alone EXITS, "1" accepts, arrows
 *    move, anything else (typing the word "yes") is ignored;
 *  - ~/.fake-vendors/needs-login present = "Not logged in · Please run /login" with the logged-out composer footer;
 *  - every raw input chunk is appended to ~/.fake-vendors/claude-input.log (bounded) so a test can see EXACTLY what reached
 *    the program (a runaway "y" flood, a stuck key) without trusting the engine's own counters.
 * IT IS A SMALL COMPILED PROGRAM, NOT A SCRIPT, on purpose: the engine decides "does an interactive claude own this pane's
 * terminal?" from /proc (src/engine/proc-classifier.ts) and fails CLOSED: the process name (comm) must be `claude` and every
 * word of its command line after the name must be a flag or a flag's value. A node/bash script has a script path in argv and
 * comm of node/bash, so the engine would hold every line with `no-claude`, which the real program never causes. A binary
 * named `claude` has neither problem. Needs `cc` (gcc) on the machine. */
const FAKE_CLAUDE_C = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <termios.h>
#include <sys/stat.h>

static char home[512], cwd[1024], logpath[600], needlogin[600], sid[200];
static int logged = 0;
/* one JSON string, quotes and backslashes flattened (a transcript is evidence, not a record of every byte) */
static void q(FILE *f, const char *s) {
  fputc(34, f);
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == 34) c = 39; else if (c == 92) c = 47; else if (c < 32) c = 32;
    fputc(c, f);
  }
  fputc(34, f);
}
/* the real program's transcript, minimally: ~/.claude/projects/<cwd, non-alphanumerics as '-'>/<session>.jsonl, one
   user line per message heard, so the engine's read-only "did it take the handover?" check has something real to read */
static void transcript(const char *line) {
  if (!sid[0]) return;
  char enc[1100];
  size_t L = strlen(cwd), k = 0;
  while (L > 1 && cwd[L - 1] == '/') L--;
  for (size_t i = 0; i < L && k < sizeof enc - 1; i++) {
    char c = cwd[i];
    enc[k++] = ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) ? c : '-';
  }
  enc[k] = 0;
  char p[1800];
  snprintf(p, sizeof p, "%s/.claude", home); mkdir(p, 0755);
  snprintf(p, sizeof p, "%s/.claude/projects", home); mkdir(p, 0755);
  snprintf(p, sizeof p, "%s/.claude/projects/%s", home, enc); mkdir(p, 0755);
  snprintf(p, sizeof p, "%s/.claude/projects/%s/%s.jsonl", home, enc, sid);
  FILE *f = fopen(p, "a");
  if (!f) return;
  fputc(123, f); q(f, "type"); fputc(58, f); q(f, "user"); fputc(44, f); q(f, "sessionId"); fputc(58, f); q(f, sid);
  fputc(44, f); q(f, "message"); fputc(58, f); fputc(123, f); q(f, "role"); fputc(58, f); q(f, "user"); fputc(44, f);
  q(f, "content"); fputc(58, f); q(f, line); fputc(125, f); fputc(125, f); fputc(10, f);
  fclose(f);
}
static void note(const char *buf, int n) {
  if (logged >= 4000) return;
  logged++;
  FILE *f = fopen(logpath, "a");
  if (!f) return;
  fputc('"', f);
  for (int i = 0; i < n; i++) {
    unsigned char c = (unsigned char)buf[i];
    if (c == '"' || c == 92) { fputc(92, f); fputc(c, f); }
    else if (c < 32 || c > 126) fprintf(f, "x%02x", c);
    else fputc(c, f);
  }
  fputs("\\n", f);
  fclose(f);
}
static int trusted(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/.claude.json", home);
  FILE *f = fopen(path, "r");
  if (!f) return 0;
  static char doc[1 << 16];
  size_t n = fread(doc, 1, sizeof doc - 1, f);
  fclose(f);
  doc[n] = 0;
  char key[1100];
  snprintf(key, sizeof key, "\\"%s\\"", cwd);
  char *p = strstr(doc, key);
  if (!p) return 0;
  char *end = strchr(p, '}');
  char *t = strstr(p, "hasTrustDialogAccepted");
  if (!t || (end && t > end)) return 0;
  char *colon = strchr(t, ':');
  return colon && strstr(colon, "true") && (!end || strstr(colon, "true") < end);
}
static void composer(int loggedin) { puts(loggedin ? "  ? for shortcuts" : "  Not logged in \\xc2\\xb7 Run /login"); fflush(stdout); }
static void draw(int sel) {
  printf("Accessing workspace:\\n\\n %s\\n\\n Quick safety check: Is this a project you created or one you trust?\\n\\n %c 1. Yes, I trust this folder\\n %c 2. No, exit\\n\\n Enter to confirm \\xc2\\xb7 Esc to cancel\\n", cwd, sel == 1 ? '>' : ' ', sel == 2 ? '>' : ' ');
  fflush(stdout);
}
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { puts("2.1.0 (Claude Code, fake)"); return 0; }
  const char *h = getenv("HOME");
  snprintf(home, sizeof home, "%s", h ? h : "/");
  /* the switch's sign-in probe: \`claude auth status\` (the real command's output shape is unverified) */
  if (argc > 2 && strcmp(argv[1], "auth") == 0 && strcmp(argv[2], "status") == 0) {
    char nl[600];
    snprintf(nl, sizeof nl, "%s/.fake-vendors/needs-login", home);
    if (access(nl, F_OK) == 0) { puts("Not logged in"); return 1; }
    puts("Logged in (fake account)");
    return 0;
  }
  for (int i = 1; i + 1 < argc; i++) {
    if (strcmp(argv[i], "--session-id") == 0 || strcmp(argv[i], "--resume") == 0) snprintf(sid, sizeof sid, "%s", argv[i + 1]);
  }
  if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, "/");
  char dir[600];
  snprintf(dir, sizeof dir, "%s/.fake-vendors", home);
  mkdir(dir, 0755);
  snprintf(logpath, sizeof logpath, "%s/claude-input.log", dir);
  snprintf(needlogin, sizeof needlogin, "%s/needs-login", dir);
  int loggedin = access(needlogin, F_OK) != 0;
  /* the real program takes a second or two to draw anything. The engine judges "is this output the claude, or the shell that
     started it?" by comparing the output's time with the process's start time (10 ms granularity), so an instant fake gets its
     first footer set aside as the shell's and the line stays held forever, which the real program never does. */
  usleep(900000);
  struct termios t0, t;
  int raw = tcgetattr(0, &t0) == 0;
  if (raw) { t = t0; t.c_lflag &= ~(ICANON | ECHO); t.c_cc[VMIN] = 1; t.c_cc[VTIME] = 0; tcsetattr(0, TCSANOW, &t); }
  char b[256];
  int n;
  if (!trusted()) {
    int sel = 2;
    draw(sel);
    for (;;) {
      n = read(0, b, sizeof b);
      if (n <= 0) return 1;
      note(b, n);
      if (n == 3 && b[0] == 27 && b[1] == '[' && b[2] == 'A') { sel = 1; draw(sel); continue; }
      if (n == 3 && b[0] == 27 && b[1] == '[' && b[2] == 'B') { sel = 2; draw(sel); continue; }
      if (n == 1 && b[0] == '1') break;
      if (n == 1 && (b[0] == '2' || b[0] == 27)) return 1;
      if (n == 1 && (b[0] == 13 || b[0] == 10)) { if (sel == 1) break; return 1; }
    }
  }
  /* the real REPL clears the dialog and draws a welcome panel of several hundred characters before its footer; the engine's
     startup gate treats a footer that close behind prompt text as part of the PROMPT's frame (VETO_CHARS), so a faithful
     fake must separate them the way the real program does */
  puts("\\n\\n\\n");
  printf("Claude Code v2.1.0 (fake) in %s\\n", cwd);
  puts("  Welcome back! This is a stand-in for the real welcome panel: tips for getting started, recent activity,");
  puts("  and what is new in this version. Type a request below; this fake only echoes what it hears so a test");
  puts("  can prove exactly what reached the program. Nothing here calls a model or needs a login of any kind.");
  puts("  Tip: run /help to see commands. Tip: use @ to mention files. Tip: press shift+tab to change the mode.");
  if (!loggedin) puts("  \\xe2\\x8e\\xbf Not logged in \\xc2\\xb7 Please run /login");
  composer(loggedin);
  char line[1024];
  int len = 0;
  while ((n = read(0, b, sizeof b)) > 0) {
    note(b, n);
    for (int i = 0; i < n; i++) {
      if (b[i] == 13 || b[i] == 10) { line[len] = 0; transcript(line); printf("fake-claude heard: %s\\n", line); len = 0; composer(loggedin); }
      else if (len < (int)sizeof line - 1) line[len++] = b[i];
    }
  }
  if (raw) tcsetattr(0, TCSANOW, &t0);
  return 0;
}
`;

/* A FAKE `codex` (switch spec §3 item 6) with the startup behaviour the switch must survive, chosen by files in
 * ~/.fake-vendors so a test can flip them between launches:
 *  - `codex login status`: "Logged in using ChatGPT" (exit 0), or "Not logged in" (exit 1) with codex-needs-login;
 *  - codex-needs-login: paints the OBSERVED login screen (test/fixtures/codex-screens/login.txt) and waits there;
 *  - the trust dialog (fixtures trust.txt) unless the launch carries the exact-folder trust override for this folder,
 *    or always with codex-force-trust; the key "1" accepts it, nothing else does (the engine never answers it);
 *  - like the real program it reads the terminal RAW: a bracketed paste is one message (a newline inside it is not a
 *    submit) and Tab or Enter submits it (room-typer types Codex lines as paste + Tab);
 *  - the HOOKS the engine wrote (<project>/.codex/hooks.json) fire like the real program's: SessionStart with a session
 *    id, then UserPromptSubmit / Stop per message (codex-no-hooks turns them off: "never names its conversation");
 *  - `codex resume <id>` keeps that id;
 *  - every message it heard is appended to ~/.fake-vendors/codex-heard.log (a record that outlives an engine restart,
 *    whose screen replay starts at adoption).
 * Plain CommonJS with no backslash anywhere (control characters come from String.fromCharCode), so nothing in the
 * template below is an escape. __NODE__ / __SCREENS__ are filled in when the instance writes it. */
const FAKE_CODEX = `#!__NODE__
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const C = (n) => String.fromCharCode(n);
const NL = C(10), CR = C(13), TAB = C(9), ESC = C(27);
const PASTE_ON = ESC + '[200~', PASTE_OFF = ESC + '[201~';
const FV = path.join(process.env.HOME || '/', '.fake-vendors');
const has = (n) => fs.existsSync(path.join(FV, n));
const args = process.argv.slice(2);
const say = (t) => process.stdout.write(String(t).split(NL).join(CR + NL));
if (args[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
if (args[0] === '--help') { console.log('--no-alt-screen --dangerously-bypass-hook-trust --model --config'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  if (has('codex-needs-login')) { console.log('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
const cwd = process.env.PWD || process.cwd();
let sid = args[0] === 'resume' && args[1] ? args[1] : '';
function hook(ev, text) {
  if (has('codex-no-hooks')) return;
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.codex', 'hooks.json'), 'utf8')); } catch { return; }
  const payload = { session_id: sid, hook_event_name: ev, cwd };
  if (ev === 'UserPromptSubmit') payload.prompt = text;
  if (ev === 'Stop') payload.last_assistant_message = text;
  for (const g of (cfg && cfg.hooks && cfg.hooks[ev]) || []) {
    for (const h of (g && g.hooks) || []) {
      if (h && h.type === 'command' && typeof h.command === 'string') {
        cp.spawnSync('sh', ['-c', h.command], { input: JSON.stringify(payload), stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000, cwd });
      }
    }
  }
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
if (has('codex-needs-login')) {
  say(fs.readFileSync(path.join('__SCREENS__', 'login.txt'), 'utf8'));
  process.stdin.on('data', (d) => { if (d.includes(C(3))) process.exit(130); });
  return;
}
const want = 'projects."' + cwd + '".trust_level="trusted"';
let phase = has('codex-force-trust') || !args.includes(want) ? 'trust' : 'ready';
function ready() {
  phase = 'ready';
  if (!sid) sid = crypto.randomUUID();
  hook('SessionStart', '');
  say('OpenAI Codex (fake) ready (args: ' + args.join(' ') + ')' + NL);
}
if (phase === 'trust') {
  say(fs.readFileSync(path.join('__SCREENS__', 'trust.txt'), 'utf8').split('<absolute project path>').join(cwd));
} else {
  ready();
}
let buf = '';
let inPaste = false;
function submit() {
  const line = buf.trim();
  buf = '';
  if (!line) return;
  hook('UserPromptSubmit', line);
  try { fs.appendFileSync(path.join(FV, 'codex-heard.log'), line + NL); } catch {}
  say('fake-codex heard: ' + line + NL);
  hook('Stop', 'fake-codex heard: ' + line);
}
process.stdin.on('data', (d) => {
  for (const ch of d) {
    if (ch === C(3)) process.exit(130);
    if (phase === 'trust') { if (ch === '1') ready(); continue; }
    buf += ch;
    if (buf.endsWith(PASTE_ON)) { buf = buf.slice(0, -PASTE_ON.length); inPaste = true; continue; }
    if (buf.endsWith(PASTE_OFF)) { buf = buf.slice(0, -PASTE_OFF.length); inPaste = false; continue; }
    if (ch === CR || ch === NL || ch === TAB) {
      buf = buf.slice(0, -1);
      if (inPaste) { buf += ' '; continue; }
      submit();
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (l && !l.startsWith('#') && l.includes('=')) {
      out[l.slice(0, l.indexOf('='))] = l.slice(l.indexOf('=') + 1);
    }
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function killGroup(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

function jar(res: Response, into: Map<string, string>): void {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) into.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

/** The person's first sign-in: temp password, forced change, the re-issued cookie. */
async function signInOnce(base: string, user: string, tempPassword: string): Promise<ScratchClient> {
  const cookies = new Map<string, string>();
  const header = (): string => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (path: string, init: { method?: string; json?: unknown } = {}): Promise<{ res: Response; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
      headers: { ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookies.size ? { cookie: header() } : {}) },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      redirect: 'manual',
    });
    jar(res, cookies);
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { res, body };
  };
  const login = await call('/login', { json: { username: user, password: tempPassword } });
  if (login.res.status !== 200) throw new Error(`scratch sign-in refused (${login.res.status}): ${JSON.stringify(login.body).slice(0, 200)}`);
  if (login.body?.mustChangePassword) {
    const ch = await call('/account/password', { json: { current: tempPassword, next: SCRATCH_PASSWORD } });
    if (ch.res.status !== 200) throw new Error(`scratch password change refused (${ch.res.status}): ${JSON.stringify(ch.body).slice(0, 200)}`);
  }
  return {
    get cookie() { return header(); },
    get: async (path) => { const r = await call(path); return { status: r.res.status, body: r.body }; },
    post: async (path, json) => { const r = await call(path, { method: 'POST', json: json ?? {} }); return { status: r.res.status, body: r.body }; },
  };
}

export async function startScratchBasic(opts: { user?: string; fakeVendors?: boolean; needsLogin?: boolean; engineEnv?: Record<string, string | null> } = {}): Promise<ScratchBasic> {
  const user = opts.user ?? 'scratch';
  const port: number = P(SCRATCH_ENGINE_SLOT);
  const brokerPort: number = P(SCRATCH_BROKER_SLOT);
  for (const p of [port, brokerPort]) {
    await assertFree(p, 'basic-scratch-instance');
  }
  const home = mkdtempSync(join(tmpdir(), 'wb-basic-scratch-'));
  const dataDir = join(home, '.workbench');
  /* a NONEMPTY git repo (spec §3 item 6): Codex skips its trust dialog for an empty folder, so an empty one would hide it */
  const project = join(home, 'dev', 'code', 'hello-world');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# hello-world\n\nA scratch project.\n');
  spawnSync('git', ['init', '-q'], { cwd: project });
  spawnSync('git', ['add', 'README.md'], { cwd: project });
  spawnSync('git', ['-c', 'user.name=scratch', '-c', 'user.email=noreply@example.com', 'commit', '-qm', 'init'], { cwd: project });
  let engine: ChildProcess | null = null;
  let broker: ChildProcess | null = null;
  let engineLog = '';
  let brokerLog = '';
  let client: Promise<ScratchClient> | null = null;
  const cleanup = (): void => {
    killGroup(engine);
    killGroup(broker);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    // 1. provision with the REAL script
    const prov = spawnSync(process.execPath, [TSX_CLI, join('scripts', 'hosted-workbench.ts'), user, '--home', home, '--port', String(port), '--broker-port', String(brokerPort)], {
      cwd: REPO_ROOT,
      env: childEnv({ HARBOR_WB_DATA_DIR: null, HARBOR_WB_TABLE: null, HARBOR_WB_IDENTITY_DB: null }),
      encoding: 'utf8',
    });
    if (prov.status !== 0) {
      throw new Error(`hosted-workbench.ts failed (${prov.status}): ${prov.stderr.slice(0, 400)}`);
    }
    const tempPassword = /password {2}(\S+)/.exec(prov.stdout)?.[1] ?? '';

    // 2. fake vendors first on the instance's PATH (the env files already put ~/.local/bin first)
    if (opts.fakeVendors !== false) {
      const bin = join(home, '.local', 'bin');
      mkdirSync(bin, { recursive: true });
      const src = join(home, '.local', 'share', 'fake-vendors');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'fake-claude.c'), FAKE_CLAUDE_C);
      const cc = spawnSync('cc', ['-O1', '-o', join(bin, 'claude'), join(src, 'fake-claude.c')], { encoding: 'utf8' });
      if (cc.status !== 0) {
        throw new Error(`the fake claude needs a C compiler (cc): ${cc.stderr.slice(0, 300) || cc.error?.message}`);
      }
      const fakeCodex = FAKE_CODEX.split('__SCREENS__').join(join(REPO_ROOT, 'test', 'fixtures', 'codex-screens')).split('__NODE__').join(process.execPath);
      writeFileSync(join(bin, 'codex'), fakeCodex);
      chmodSync(join(bin, 'codex'), 0o755);
      if (opts.needsLogin) {
        mkdirSync(join(home, '.fake-vendors'), { recursive: true });
        writeFileSync(join(home, '.fake-vendors', 'needs-login'), 'logged out\n');
      }
    }

    // 3. the instance's broker, then its engine, each from ITS env file
    const brokerEnv = parseEnvFile(join(dataDir, 'pty-broker.env'));
    broker = spawn(process.execPath, [TSX_CLI, join('node_modules', 'pty-broker', 'src', 'main.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({ ...brokerEnv, HOME: home }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    broker.stdout!.on('data', (d) => (brokerLog += d));
    broker.stderr!.on('data', (d) => (brokerLog += d));
    const env = parseEnvFile(join(dataDir, 'workbench.env'));
    let engineEnv: Record<string, string | null> = { ...(opts.engineEnv ?? {}) };
    const bootEngine = async (): Promise<void> => {
      const e = spawn(process.execPath, ['--import', TSX_LOADER, join('src', 'server', 'index.ts')], {
        cwd: REPO_ROOT,
        env: childEnv({ ...env, HOME: home, HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_TOKEN: null, HARBOR_WB_TABLE: null, HARBOR_WB_IDENTITY_DB: null, HARBOR_WB_CHANNELS_DIR: null, ...engineEnv }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      engine = e;
      e.stdout!.on('data', (d) => (engineLog += d));
      e.stderr!.on('data', (d) => (engineLog += d));

      // 4. ready = /health answers AND the local broker link is up
      let health: { edition?: string; brokers?: Record<string, string> } | null = null;
      for (let i = 0; i < 160; i++) {
        if (e.exitCode !== null) throw new Error(`the scratch engine exited (${e.exitCode}): ${engineLog.slice(-400)}`);
        health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (health && health.brokers?.local === 'up') break;
        await sleep(250);
      }
      if (!health || health.brokers?.local !== 'up') {
        throw new Error(`the scratch instance did not come up (health ${JSON.stringify(health)}): ${engineLog.slice(-400)} ${brokerLog.slice(-300)}`);
      }
    };
    await bootEngine();
    const brokerPid = broker.pid as number;
    return {
      user, home, dataDir, port, brokerPort, base: `http://127.0.0.1:${port}`, env, tempPassword, brokerPid,
      get enginePid() {
        return (engine?.pid ?? 0) as number;
      },
      async restartEngine(extraEnv = {}) {
        const old = engine;
        const pid = old?.pid ?? 0;
        killGroup(old);
        for (let i = 0; i < 50 && pid && alive(pid); i++) await sleep(100);
        for (let i = 0; ; i++) {
          try {
            await assertFree(port, 'basic-scratch-instance restart');
            break;
          } catch (e) {
            if (i >= 30) throw e;
            await sleep(200);
          }
        }
        engineEnv = { ...engineEnv, ...extraEnv };
        await bootEngine();
      },
      engineLog: () => engineLog,
      brokerLog: () => brokerLog,
      signIn: () => (client ??= signInOnce(`http://127.0.0.1:${port}`, user, tempPassword)),
      async stop(o = {}) {
        const enginePid = engine?.pid ?? 0;
        killGroup(engine);
        killGroup(broker);
        for (let i = 0; i < 40 && ((enginePid && alive(enginePid)) || alive(brokerPid)); i++) await sleep(100);
        if (!o.keep) {
          try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const keep = process.argv.includes('--keep');
  const inst = await startScratchBasic({ fakeVendors: !process.argv.includes('--no-fake-vendors') });
  process.stdout.write(`${JSON.stringify({ base: inst.base, port: inst.port, brokerPort: inst.brokerPort, home: inst.home, user: inst.user, tempPassword: inst.tempPassword, enginePid: inst.enginePid, brokerPid: inst.brokerPid }, null, 2)}\n`);
  process.stderr.write('scratch Basic instance is up; Ctrl-C stops it' + (keep ? ' (and KEEPS its home)' : ' and removes its home') + '\n');
  const done = async (): Promise<void> => {
    await inst.stop({ keep });
    process.exit(0);
  };
  process.on('SIGINT', done);
  process.on('SIGTERM', done);
  await new Promise(() => {});
}
