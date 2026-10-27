/**
 * agent-fs.test — the window agent as the engine's FILE READER, end to end
 * against a REAL engine.
 *
 * THE BUG THIS COVERS (Owner, 2026-09-18): the "Briefing Table" recipe is
 * `target:'local'`, broker-resident on the VRPC, and the engine runs on the
 * server. Yesterday's polarity fix answered `unreachable` for it — correct, and
 * useless: the Resume picker read "no resume history" for a project with months
 * of transcripts on the VRPC, and no ssh alias exists from svc-ops into
 * winuser's Windows account. The window agent already runs there, as that
 * account. This file plays it.
 *
 * THE STUB AGENT IMPLEMENTS `encodeProjectDir` ITSELF, FROM THE CONTRACT, and
 * that is deliberately the most important assertion in the file. The engine
 * sends the RAW project dir; if the two sides' encodings disagree by one
 * character the listing comes back empty and everything downstream reports "no
 * sessions" in silence — which is precisely the Kiosk trailing-slash failure
 * of 2026-09-13, one host further away. A shared helper would have hidden that;
 * a second independent implementation is what proves the rule is writable from
 * the spec.
 *
 * SAFETY: scratch port, scratch db + fixture transcripts in a temp dir, no
 * broker, no window host, `HARBOR_WB_DESKTOP=agent` so nothing local is ever
 * spawned. Never touches the live engine (:7420), the brokers, or :8200.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import {
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(16); // scratch engine — port table in test/_scratch.mjs
/* Told to the engine as its broker; NOTHING may listen there (no PTY is
 * spawned in this file), so assertFree checks it too. */
const DEAD_BROKER_PORT = P(17);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TEST_TOKEN = 'test-token-do-not-ship';
const WA_TOKEN = 'test-window-agent-credential';
const AGENT_TIMEOUT_MS = 900; // short, so the timeout path costs under a second
/** Deliberately a WINDOWS path, reached from a (notionally) Linux engine — the
 *  whole point is that the engine never resolves it, only names it. */
const PROJECT_DIR = 'C:\\code\\briefing-table';
/** Small, so a fixture of a few KB still forces the two-slice (head+tail) read
 *  path instead of the single-read shortcut. */
const HEAD_BYTES = 512;
const TAIL_BYTES = 512;

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (String(input).startsWith(BASE) && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${TEST_TOKEN}`);
  }
  return realFetch(input, { ...init, headers });
};
async function api(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

/* ---- the agent's half of the contract, written from the spec --------------
 * §5b: "the agent resolves root:"claude-projects" to ITS OWN
 * ~/.claude/projects/<encodeProjectDir(dir)>. Strip trailing separators (unless
 * that would empty the string), then replace every character outside [A-Za-z0-9]
 * with '-'. Case is PRESERVED."
 * Not imported from the engine. See the file header for why.               */
function encodeProjectDir(cwd) {
  const trimmed = cwd.replace(/[/\\]+$/, '') || cwd;
  return trimmed.replace(/[^A-Za-z0-9]/g, '-');
}

/** The window agent: registers, and answers `fs.*` out of a fixture tree that
 *  stands in for `~/.claude/projects`. */
function windowAgent(fixtureRoot, { capabilities = ['window', 'focus', 'fs'], answerFs = true } = {}) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/window-agent`, {
    headers: { authorization: `Bearer ${WA_TOKEN}` },
  });
  ws.on('error', () => {});
  const log = [];
  const waiters = [];
  let mode = answerFs ? 'serve' : 'silent';

  function resolveDir(dir) {
    return join(fixtureRoot, encodeProjectDir(dir));
  }
  /** Nothing outside the root is ever served — the agent's own guard, and the
   *  reason the engine may only ever name a project dir and a bare file name. */
  function safeName(name) {
    return typeof name === 'string' && name.length > 0 && !/[\\/]/.test(name) && !name.includes('..');
  }
  function handleFs(msg) {
    if (msg.root !== 'claude-projects') {
      return { ok: false, error: 'EROOT' };
    }
    const dir = resolveDir(msg.dir);
    if (msg.type === 'fs.list') {
      if (!existsSync(dir)) {
        return { ok: false, error: 'ENOENT' };
      }
      const entries = readdirSync(dir)
        .filter((n) => (msg.glob === '*.jsonl' ? n.endsWith('.jsonl') : true))
        .map((n) => {
          const st = statSync(join(dir, n));
          return { name: n, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
        });
      return { ok: true, entries };
    }
    if (msg.type === 'fs.read') {
      if (!safeName(msg.name)) {
        return { ok: false, error: 'EBADNAME' };
      }
      const p = join(dir, msg.name);
      if (!existsSync(p)) {
        return { ok: false, error: 'ENOENT' };
      }
      const size = statSync(p).size;
      const offset = Math.max(0, Number(msg.offset ?? 0));
      const limit = Math.max(1, Math.min(Number(msg.limit ?? 65536), 1024 * 1024));
      const buf = Buffer.alloc(limit);
      const fd = openSync(p, 'r');
      const n = readSync(fd, buf, 0, limit, offset);
      closeSync(fd);
      return { ok: true, data: buf.subarray(0, n).toString('utf8'), size, eof: offset + n >= size };
    }
    if (msg.type === 'fs.grep') {
      if (!existsSync(dir)) {
        return { ok: false, error: 'ENOENT' };
      }
      const max = Number(msg.maxMatches ?? 3);
      const matches = [];
      for (const n of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
        let hits = 0;
        for (const line of readFileSync(join(dir, n), 'utf8').split('\n')) {
          if (hits >= max) {
            break;
          }
          if (line.includes(msg.pattern)) {
            matches.push({ name: n, line });
            hits++;
          }
        }
      }
      return { ok: true, matches };
    }
    return { ok: false, error: 'EUNKNOWN' };
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    log.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
    if (typeof msg.req !== 'string') {
      return;
    }
    if (String(msg.type).startsWith('window.')) {
      ws.send(JSON.stringify({ type: 'window.result', req: msg.req, ok: true }));
      return;
    }
    if (String(msg.type).startsWith('fs.')) {
      if (mode === 'silent') {
        return; // the engine must time out and say UNKNOWN, never "empty"
      }
      ws.send(JSON.stringify({ type: 'fs.result', req: msg.req, ...handleFs(msg) }));
    }
  });
  return {
    open: () => new Promise((r) => ws.once('open', r)),
    register: (host = 'vrpc') =>
      ws.send(
        JSON.stringify({
          type: 'register',
          host,
          agent: 'cli-manager',
          capabilities,
          version: '0.2.0',
          base: 'http://host.example.ts.net:7420',
        }),
      ),
    setMode: (m) => {
      mode = m;
    },
    await: (pred, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const hit = log.find(pred);
        if (hit) {
          return resolve(hit);
        }
        const t = setTimeout(() => reject(new Error('timeout waiting for an agent frame')), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      }),
    close: () => ws.close(),
    log,
  };
}

/* ---- fixtures -------------------------------------------------------------
 * Real-shaped CC 2.1.x transcript lines: the fields the parser reads, in the
 * places it reads them from (titles at the END, the headless marker and the
 * slash command at the START).                                             */
const IDS = {
  named: '11111111-1111-4111-8111-111111111111',
  auto: '22222222-2222-4222-8222-222222222222',
  headless: '33333333-3333-4333-8333-333333333333',
};

function writeFixtures(root) {
  const dir = join(root, encodeProjectDir(PROJECT_DIR));
  mkdirSync(dir, { recursive: true });

  /* BIG ENOUGH TO FORCE THE SPLIT READ (> HEAD+TAIL), with the title in the
     tail and the command in the head — i.e. the exact layout the two-slice
     strategy is betting on. */
  const filler = Array.from({ length: 40 }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: IDS.named,
      gitBranch: 'main',
      message: { content: `filler line ${i} ${'x'.repeat(60)}` },
    }),
  ).join('\n');
  const named = [
    JSON.stringify({
      type: 'user',
      sessionId: IDS.named,
      entrypoint: 'cli',
      gitBranch: 'main',
      message: { content: '<command-name>/rename</command-name>' },
    }),
    filler,
    JSON.stringify({
      type: 'summary',
      sessionId: IDS.named,
      customTitle: 'Engine \u21c4 Auriga',
      lastPrompt: 'wire the fs frames',
      gitBranch: 'agent/fs-librarian',
    }),
  ].join('\n');
  writeFileSync(join(dir, `${IDS.named}.jsonl`), named);
  ok(named.length > HEAD_BYTES + TAIL_BYTES, 'fixture is large enough to force a split read');

  const auto = [
    JSON.stringify({ type: 'user', sessionId: IDS.auto, entrypoint: 'cli', message: { content: 'hello' } }),
    JSON.stringify({ type: 'summary', sessionId: IDS.auto, aiTitle: 'Broker rebind', lastPrompt: 'restart it', gitBranch: 'main' }),
  ].join('\n');
  writeFileSync(join(dir, `${IDS.auto}.jsonl`), auto);

  /* Dispatched/headless — native /resume hides these and so must we. */
  const headless = [
    JSON.stringify({ type: 'user', sessionId: IDS.headless, entrypoint: 'sdk-cli', message: { content: 'dispatched' } }),
    JSON.stringify({ type: 'summary', sessionId: IDS.headless, customTitle: 'MUST NOT APPEAR' }),
  ].join('\n');
  writeFileSync(join(dir, `${IDS.headless}.jsonl`), headless);

  // Deterministic newest-first order: named > auto > headless.
  const now = Date.now() / 1000;
  utimesSync(join(dir, `${IDS.named}.jsonl`), now, now);
  utimesSync(join(dir, `${IDS.auto}.jsonl`), now - 600, now - 600);
  utimesSync(join(dir, `${IDS.headless}.jsonl`), now - 1200, now - 1200);
  return dir;
}

/* ---- targets --------------------------------------------------------------
 * The engine's node is `homebase` (the default). `vrpc-resident` is the shape of the
 * real "Briefing Table" recipe: kind LOCAL (a shell on that broker's host),
 * broker `vrpc`, NO ssh alias — the target that had no way in. `orphan` names a
 * host no agent will ever connect for.                                     */
const TARGETS = JSON.stringify({
  targets: [
    { id: 'vrpc-resident', label: 'VRPC (broker-resident)', kind: 'local', broker: 'vrpc' },
    { id: 'orphan', label: 'Nowhere', kind: 'local', broker: 'elsewhere' },
  ],
});

async function run() {
  try {
    const stale = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
    if (stale) {
      console.log(`\n✗ port ${PORT} is already serving an engine (stale/orphan). Kill it first.\n`);
      process.exit(2);
    }
  } catch {
    /* connection refused = port free = good */
  }
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'agent-fs.test.mjs');
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-afs-'));
  const fixtureRoot = join(tmpDir, 'agent-home-claude-projects');
  writeFixtures(fixtureRoot);

  let engineLog = '';
  const tsxLoader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const engine = spawn(
    process.execPath,
    ['--import', `file://${tsxLoader.replace(/\\/g, '/')}`, 'src/server/index.ts'],
    {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
        HARBOR_WB_TOKEN: TEST_TOKEN,
        HARBOR_WB_WINDOW_AGENT_TOKEN: WA_TOKEN,
        HARBOR_WB_DESKTOP: 'agent',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_NODE: 'homebase', // explicit: this engine is NOT the VRPC
        HARBOR_WB_AGENT_TIMEOUT_MS: String(AGENT_TIMEOUT_MS),
        HARBOR_WB_AGENTFS_TIMEOUT_MS: String(AGENT_TIMEOUT_MS),
        HARBOR_WB_AGENTFS_HEAD_BYTES: String(HEAD_BYTES),
        HARBOR_WB_AGENTFS_TAIL_BYTES: String(TAIL_BYTES),
        /* The engine's OWN transcript root must stay empty: if the agent path
           ever silently fell back to local disk, this is what would make it
           obvious instead of accidentally correct. */
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'engine-local-projects'),
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), // scratch, nothing listening: no PTY is spawned here
        HARBOR_WB_BROKERS: '{}',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));

  let agent = null;
  let plain = null;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try {
        up = (await (await fetch(BASE + '/health')).json()).status === 'ok';
      } catch {
        /* not yet */
      }
      if (!up) {
        await sleep(250);
      }
    }
    if (!up) {
      throw new Error(`engine did not come up.\n--- engine log ---\n${engineLog}`);
    }

    console.log('\n[no agent yet: the foreign-broker target is UNREACHABLE, exactly as before]');
    const created = await api('/api/recipes', {
      name: 'Briefing Table',
      target: 'vrpc-resident',
      projectDir: PROJECT_DIR,
      runClaude: true,
    });
    const recipe = created.recipe;
    ok(!!recipe?.id, 'probe recipe created');
    ok(
      typeof created.warning === 'string' && created.warning.includes('fs-capable window agent'),
      `the save warning names the missing agent, not a missing folder (got ${JSON.stringify(created.warning)})`,
    );
    const noAgent = await (await fetch(`${BASE}/api/recipes/${recipe.id}/sessions`)).json();
    eq(noAgent.sessions.length, 0, 'and the resume picker is honestly empty');

    console.log('\n[an agent WITHOUT the "fs" capability changes nothing]');
    plain = windowAgent(fixtureRoot, { capabilities: ['window', 'focus'] });
    await plain.open();
    plain.register('vrpc');
    await plain.await((m) => m.type === 'registered');
    const stillNone = await (await fetch(`${BASE}/api/recipes/${recipe.id}/sessions`)).json();
    eq(stillNone.sessions.length, 0, 'a window-only agent is not a file reader');
    ok(
      plain.log.every((m) => !String(m.type).startsWith('fs.')),
      'and the engine never even asks it — capability is a gate, not a hint',
    );
    plain.close();
    await sleep(200);

    console.log('\n[an fs-capable agent: the Resume picker comes back]');
    agent = windowAgent(fixtureRoot);
    await agent.open();
    agent.register('vrpc');
    await agent.await((m) => m.type === 'registered');
    const listed = await (await fetch(`${BASE}/api/recipes/${recipe.id}/sessions`)).json();
    eq(listed.sessions.length, 2, 'two interactive sessions listed');
    eq(listed.sessions[0].sessionId, IDS.named, 'newest first');
    eq(listed.sessions[0].title, 'Engine \u21c4 Auriga', 'customTitle read out of the TAIL slice');
    eq(listed.sessions[0].lastPrompt, 'wire the fs frames', 'last prompt too');
    eq(listed.sessions[0].branch, 'agent/fs-librarian', 'and the branch');
    eq(listed.sessions[0].firstCommand, '/rename', 'firstCommand read out of the HEAD slice');
    eq(listed.sessions[1].title, 'Broker rebind', 'aiTitle is the fallback title');
    ok(
      !listed.sessions.some((s) => s.sessionId === IDS.headless),
      'the headless (sdk-cli) transcript is excluded, as native /resume excludes it',
    );

    console.log('\n[the frames are the contract, and nothing but the project dir crosses]');
    const fsFrames = agent.log.filter((m) => String(m.type).startsWith('fs.'));
    ok(fsFrames.length > 0, `the engine asked (${fsFrames.length} fs.* frames)`);
    ok(fsFrames.every((m) => m.root === 'claude-projects'), 'every frame names the one legal root');
    ok(fsFrames.every((m) => m.dir === PROJECT_DIR), 'and the RAW project dir — the agent does the encoding');
    ok(
      fsFrames.every((m) => typeof m.req === 'string' && m.req.length > 0),
      'and carries a req to answer on',
    );
    ok(
      fsFrames.filter((m) => m.type === 'fs.read').every((m) => !/[\\/]/.test(m.name) && !m.name.includes('..')),
      'a read names a bare file, never a path — nothing outside the root is reachable',
    );
    const listFrame = fsFrames.find((m) => m.type === 'fs.list');
    eq(listFrame.glob, '*.jsonl', 'the list frame asks for transcripts only');
    const reads = fsFrames.filter((m) => m.type === 'fs.read' && m.name === `${IDS.named}.jsonl`);
    eq(reads.length, 2, 'the oversized transcript was fetched as TWO slices, not whole');
    ok(reads.some((m) => m.offset === 0), 'a head slice from 0');
    ok(reads.some((m) => m.offset > 0), 'and a tail slice at a computed offset');
    ok(reads.every((m) => m.limit <= HEAD_BYTES + TAIL_BYTES), 'each within its budget');

    console.log('\n[(mtime,size) caching: an unchanged transcript is never re-read]');
    const before = agent.log.filter((m) => m.type === 'fs.read').length;
    const again = await (await fetch(`${BASE}/api/recipes/${recipe.id}/sessions`)).json();
    eq(again.sessions.length, 2, 'the second listing is identical');
    eq(
      agent.log.filter((m) => m.type === 'fs.read').length,
      before,
      'and cost ZERO further reads — the key is self-invalidating, so there is no TTL to get wrong',
    );
    ok(
      agent.log.filter((m) => m.type === 'fs.list').length >= 2,
      'the cheap listing is still re-fetched, so a NEW transcript is seen immediately',
    );

    console.log('\n[dir check, three outcomes — and never a false "missing"]');
    const good = await api('/api/recipes', {
      id: recipe.id,
      name: 'Briefing Table',
      target: 'vrpc-resident',
      projectDir: PROJECT_DIR,
      runClaude: true,
    });
    eq(good.warning, undefined, 'a dir the agent holds transcripts for saves clean → exists TRUE');

    const missing = await api('/api/recipes', {
      name: 'Nowhere Project',
      target: 'vrpc-resident',
      projectDir: 'C:\\code\\does-not-exist',
      runClaude: true,
    });
    ok(
      typeof missing.warning === 'string' && /no claude transcript dir on vrpc/.test(missing.warning),
      `ENOENT → exists FALSE, and the warning says what was actually checked (got ${JSON.stringify(missing.warning)})`,
    );

    agent.setMode('silent');
    const t0 = Date.now();
    const timedOut = await api('/api/recipes', {
      name: 'Silent Desktop',
      target: 'vrpc-resident',
      projectDir: PROJECT_DIR,
      runClaude: true,
    });
    const elapsed = Date.now() - t0;
    ok(!!timedOut.recipe?.id, 'a silent desktop NEVER refuses a save');
    ok(
      typeof timedOut.warning === 'string' && /could not reach the vrpc window agent/.test(timedOut.warning),
      `a timeout is the UNKNOWN outcome, not "missing" (got ${JSON.stringify(timedOut.warning)})`,
    );
    ok(!/no claude transcript dir/.test(timedOut.warning), 'and is never reported as a missing directory');
    ok(elapsed >= AGENT_TIMEOUT_MS && elapsed < AGENT_TIMEOUT_MS + 4000, `it waited the timeout and no longer (${elapsed}ms)`);

    console.log('\n[a silent desktop yields an empty LISTING, which is a different question]');
    const silentList = await (await fetch(`${BASE}/api/recipes/${recipe.id}/sessions`)).json();
    ok(Array.isArray(silentList.sessions), 'the picker still answers rather than erroring');
    agent.setMode('serve');

    console.log('\n[a host with no agent at all stays unreachable — the agent is per HOST]');
    const orphan = await api('/api/recipes', {
      name: 'Orphan Project',
      target: 'orphan',
      projectDir: PROJECT_DIR,
      runClaude: true,
    });
    ok(
      typeof orphan.warning === 'string' && orphan.warning.includes('"elsewhere"'),
      `the warning names the host we have no way into (got ${JSON.stringify(orphan.warning)})`,
    );
    const orphanList = await (await fetch(`${BASE}/api/recipes/${orphan.recipe.id}/sessions`)).json();
    eq(orphanList.sessions.length, 0, 'and its picker is empty — the vrpc agent is NOT asked for it');
    ok(
      !agent.log.some((m) => m.type === 'fs.list' && m.dir === PROJECT_DIR && m.host === 'elsewhere'),
      'nothing leaked across hosts',
    );

    console.log('\n[the agent going away restores the old behaviour exactly]');
    agent.close();
    await sleep(300);
    const gone = await api('/api/recipes', {
      id: recipe.id,
      name: 'Briefing Table',
      target: 'vrpc-resident',
      projectDir: PROJECT_DIR,
      runClaude: true,
    });
    ok(
      typeof gone.warning === 'string' && gone.warning.includes('fs-capable window agent'),
      'a dropped socket is not a cached capability — the check is live',
    );
    agent = null;

    console.log('\n[/pty and /window-agent are both unaffected]');
    const pty = new WebSocket(`ws://${HOST}:${PORT}/pty`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const ptyUp = await new Promise((r) => {
      pty.on('error', () => r(false));
      pty.on('open', () => {
        pty.close();
        r(true);
      });
    });
    ok(ptyUp, 'the pty channel still upgrades');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack || e));
    console.log(`\n✗ ${e?.message || e}`);
  } finally {
    try {
      agent?.close();
      plain?.close();
    } catch {
      /* already gone */
    }
    engine.kill();
    await sleep(400);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the db handle briefly — a temp dir, not ours to fight */
    }
  }

  console.log('\n========================================');
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failed > 0) {
    console.log('\nfailures:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    console.log(`\n--- engine log ---\n${engineLog}`);
    process.exit(1);
  }
  console.log('all green');
}

run();
