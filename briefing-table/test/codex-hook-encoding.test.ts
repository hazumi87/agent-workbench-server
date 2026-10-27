/**
 * The Codex hook command, EXECUTED (the design notes §3 item 5).
 * A fresh pane id carries `#`; unencoded it became a URL fragment curl never
 * sent, so the engine heard `recipe:<id>` and the hook did nothing. This runs
 * the GENERATED command, exactly as written into .codex/hooks.json, under every
 * POSIX shell present (sh, bash, dash), with the hook's JSON on stdin, against a
 * local receiver, and proves the receiver gets the FULL pane id and the JSON
 * body byte for byte. Then the engine's own route logic (handleAgentHook) banks
 * the session id on that exact pane. Ephemeral port; no engine; no network.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { hookCommand, mergeHooks } from '../src/engine/codex-hooks.ts';
import { handleAgentHook } from '../src/engine/agent-hook.ts';

let checks = 0;
let failed = 0;
const ok = (c: unknown, m: string) => {
  checks++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
};

const got: Array<{ url: string; body: string }> = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    got.push({ url: req.url ?? '', body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
const cmd = hookCommand(port);

const PANE = 'recipe:hosted-builder--codex#3f9a0c1e';
const payload = JSON.stringify({ session_id: '019a-codex-session-0001', hook_event_name: 'SessionStart', cwd: '/home/kid/dev/code/hello-world', note: 'quotes " and \\ and # survive' });

const shells = ['sh', 'bash', 'dash'].filter((s) => spawnSync('sh', ['-c', `command -v ${s}`]).status === 0);
ok(shells.includes('sh'), `shells found: ${shells.join(', ')}`);

function run(shell: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(shell, ['-c', cmd], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
    p.stdin.end(payload);
    p.on('exit', (code) => resolve(code ?? -1));
  });
}

for (const sh of shells) {
  console.log(`\n[${sh}]`);
  got.length = 0;
  const code = await run(sh, { HARBOR_WB_PANEID: PANE });
  ok(code === 0, `${sh}: the command exits 0 (it never fails a hook)`);
  ok(got.length === 1, `${sh}: exactly one POST reached the receiver`);
  const u = new URL(got[0]?.url ?? '/', 'http://x');
  ok(u.pathname === '/api/agent-hook' && u.searchParams.get('vendor') === 'codex-cli', `${sh}: the engine's hook route, vendor codex-cli`);
  ok(u.searchParams.get('paneid') === PANE, `${sh}: the FULL pane id arrives, # included (${u.searchParams.get('paneid')})`);
  ok(got[0]?.body === payload, `${sh}: the hook's JSON body arrives unchanged`);
}

console.log('\n[a primary pane id, with no #, is unchanged]');
got.length = 0;
await run('sh', { HARBOR_WB_PANEID: 'recipe:hosted-builder' });
ok(new URL(got[0]?.url ?? '/', 'http://x').searchParams.get('paneid') === 'recipe:hosted-builder', 'recipe:hosted-builder arrives as is');

console.log('\n[the engine banks the session on THAT pane]');
const rows = new Map<string, { vendor: string; state: string; session_id: string | null }>([
  ['recipe:hosted-builder--codex', { vendor: 'codex-cli', state: 'live', session_id: null }],
  [PANE, { vendor: 'codex-cli', state: 'live', session_id: null }],
]);
const banked: Array<[string, string]> = [];
const quiet = () => {};
got.length = 0;
await run('sh', { HARBOR_WB_PANEID: PANE });
const sent = new URL(got[0].url, 'http://x').searchParams.get('paneid');
banked.length = 0;
handleAgentHook({ vendor: 'codex-cli', paneid: sent }, JSON.parse(got[0].body), {
  get: (id) => rows.get(id),
  adoptSessionId: (id, sid) => banked.push([id, sid]),
  activity: { onTurnStart: quiet, onResponseDone: quiet, onQuestion: quiet },
  log: quiet,
} as any);
ok(banked.length === 1 && banked[0][0] === PANE && banked[0][1] === '019a-codex-session-0001', `the session id is banked on ${PANE}, not on the recipe's primary pane`);

console.log('\n[regeneration keeps a person\'s own hooks]');
const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] } };
const merged = mergeHooks(theirs, port) as any;
ok(merged.hooks.Stop.some((g: any) => g.hooks.some((h: any) => h.command === 'notify-send done')), 'a foreign Stop hook survives');
ok(merged.hooks.Stop.some((g: any) => g.hooks.some((h: any) => h.command === cmd)), 'and ours is the encoded command');

server.close();
console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
