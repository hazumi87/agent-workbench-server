/**
 * E1 wiring: the launch line (buildLaunch extraArgs), the codex env token, the welcome text by tools, the roster field and the once-only room fact.
 * A scratch table; nothing listens and no CLI is launched.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-btint-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_PANE_TOKENS = '1';
process.env.HARBOR_WB_BT_MCP = '1';
process.env.HARBOR_WB_SEAT_WELCOME = '0';
process.env.HARBOR_WB_TOOLS_SECS = '1';
process.env.HARBOR_WB_TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local' }] });

const { table } = await import('../src/table/endpoint.ts');
const { buildLaunch, loadTargets } = await import('../src/engine/launch.ts');
const paneTokens = await import('../src/engine/pane-tokens.ts');
const btTools = await import('../src/engine/bt-tools.ts');
const welcome = await import('../src/engine/seat-welcome.ts');
const rooms = await import('../src/server/rooms.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

const target: any = loadTargets().find((t) => t.id === 'local');
const recipe = (id: string, vendor: string): any => ({ id, name: id, target: 'local', projectDir: join(dir, id), vendor, agent: id, runClaude: vendor === 'claude-code' ? 1 : 0, model: null, resume: 0, resumeName: null,
  initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null, effort: null, vendorArgs: null, vendorFlags: null, worktree: null });

console.log('\n[buildLaunch carries the extra args on every claude path]');
const EXTRA = '--mcp-config /x/p.bt.json --allowedTools mcp__bt__room_post';
const fresh = buildLaunch(recipe('c1', 'claude-code'), target, null, null, { paneid: 'recipe:c1', extraArgs: EXTRA });
ok(!!fresh.inject && fresh.inject.includes(EXTRA), 'a fresh claude line has them');
const resumed = buildLaunch(recipe('c1', 'claude-code'), target, '11111111-2222-3333-4444-555555555555', null, { paneid: 'recipe:c1', extraArgs: EXTRA });
ok(!!resumed.inject && resumed.inject.includes('--resume') && resumed.inject.includes(EXTRA), 'a resumed/restored line has them too');
const plain = buildLaunch(recipe('c1', 'claude-code'), target, null, null, { paneid: 'recipe:c1' });
ok(!!plain.inject && !plain.inject.includes('mcp__bt'), 'without extraArgs the line is unchanged');
const withChan = buildLaunch(recipe('c1', 'claude-code'), target, null, null, { paneid: 'recipe:c1', channelConfig: '/x/chan.json', extraArgs: 'mcp__bt__room_list_mine,mcp__bt__room_read' });
const wc = withChan.inject ?? '';
ok((wc.match(/--mcp-config/g) ?? []).length === 1 && (wc.match(/--allowedTools/g) ?? []).length === 1 && wc.includes('--allowedTools mcp__fabric,mcp__bt__room_list_mine,mcp__bt__room_read'), 'a channel pane with bt: ONE --mcp-config and ONE --allowedTools, the bt tools continuing the fabric list (no repeated flag)');
const shell = buildLaunch({ ...recipe('s1', 'cli-manager'), runClaude: 0 }, target, null, null, { paneid: 'recipe:s1', extraArgs: EXTRA });
ok(!(shell.inject ?? '').includes('mcp__bt'), 'a shell never gets them');

console.log('\n[two-account pane (token in env only): hosted direct spawn carries the secret-free config inline]');
{
  const { writeFileSync, chmodSync, existsSync } = await import('node:fs');
  const bl = await import('../src/engine/bt-launch.ts');
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'claude'), 0o755);
  const saved = { PATH: process.env.PATH, HOSTED: process.env.HARBOR_WB_HOSTED };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.HARBOR_WB_HOSTED = '1';
  try {
    const plan = bl.planBt({ enabled: true, vendor: 'claude-code', runsHere: true, port: 51234, paneid: 'recipe:c1', tokenFile: paneTokens.tokenFileFor('recipe:c1'), tokenInEnv: true });
    if (!plan.on) throw new Error('not planned');
    const w = bl.writeBtConfig(plan);
    ok(!existsSync(w.configPath), 'no <pane>.bt.json under the engine config dir');
    const spec = buildLaunch(recipe('c1', 'claude-code'), target, null, null, { paneid: 'recipe:c1', extraArgs: w.claudeArgs });
    const args = spec.descriptor.args ?? [];
    const i = args.indexOf('--mcp-config');
    ok(i >= 0 && args[i + 1].startsWith('{') && JSON.parse(args[i + 1]).mcpServers.bt.headersHelper.includes('$HARBOR_WB_PANE_TOKEN'), 'the argv carries --mcp-config <inline json> whose helper reads the env var');
    ok(args.includes('--allowedTools') && !args.some((a) => a.includes('.bt.json')), '...and no file path');
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.HOSTED === undefined) delete process.env.HARBOR_WB_HOSTED; else process.env.HARBOR_WB_HOSTED = saved.HOSTED;
  }
}

console.log('\n[the codex env token (D-E1-1)]');
table.upsert({ paneid: 'recipe:x', recipe_id: 'x', server: 'local', vendor: 'codex-cli', agent: 'x', session_id: null, state: 'live', generation: 1 } as never);
const mintCodex = paneTokens.mint('recipe:x', 1, 'file', { alsoEnv: true });
ok(!!mintCodex && !!mintCodex.env[paneTokens.TOKEN_ENV] && !!mintCodex.env[paneTokens.TOKEN_FILE_ENV], 'codex: the env carries the token AND the file path');
ok(readFileSync(mintCodex!.env[paneTokens.TOKEN_FILE_ENV], 'utf8') === mintCodex!.env[paneTokens.TOKEN_ENV], '...the same token');
const mintClaude = paneTokens.mint('recipe:x', 1, 'file');
ok(!!mintClaude && !(paneTokens.TOKEN_ENV in mintClaude.env) && !!mintClaude.env[paneTokens.TOKEN_FILE_ENV], 'claude (and the default): the file path only, never the token in the env');

console.log('\n[welcome text, by tools]');
const R = table.createRoom({ name: 'Alpha', alias: 'alpha' }, { actor: 'user' }).result;
table.upsertRecipe(recipe('c1', 'claude-code'));
table.upsert({ paneid: 'recipe:c1', recipe_id: 'c1', server: 'local', vendor: 'claude-code', agent: 'c1', session_id: null, state: 'live', generation: 1 } as never);
const seat = table.addSeat(R.id, { recipe_id: 'c1', handle: 'steward' }, { actor: 'user' }).result;
table.startSeat(R.id, seat.id, 'recipe:c1', { actor: 'user', mode: 'rehydrate' } as never);
const seatNow = table.getSeat(seat.id)!;
btTools.notPlanned('recipe:c1', 'off');
let w = welcome.welcomeText(R, seatNow);
ok(w.includes('ToolSearch') && w.includes('mcp__fabric__room_post'), 'no bt tools: today\'s text (the ToolSearch step)');
process.env.HARBOR_WB_MODE = 'local';
w = welcome.welcomeText(R, seatNow);
ok(w.includes('Post and read') && !w.includes('ToolSearch') && !w.includes('mcp__fabric__room_post'), 'a LOCAL pane with no bt tools: points at the guide\'s "Post and read" lines, never at the fabric room_post (there is no fabric locally)');
delete process.env.HARBOR_WB_MODE;
btTools.plan('recipe:c1');
w = welcome.welcomeText(R, seatNow);
ok(w.includes('room_post tool') && w.includes('mcp__bt__room_post') && !w.includes('ToolSearch'), 'with bt tools: the tool is named and the ToolSearch step is gone');
const ctx = welcome.seatContextText(R, seatNow);
ok(ctx.includes('@steward') && ctx.includes('"Alpha"') && ctx.includes('mcp__bt__room_post'), 'the seat context names the seat, the room and the tool');

console.log('\n[roster tools field and the once-only fact]');
async function roster(): Promise<any> {
  const tok = (() => { const m = paneTokens.mint('recipe:c1', 1, 'file'); return readFileSync(m!.env[paneTokens.TOKEN_FILE_ENV], 'utf8'); })();
  const bt = await import('../src/server/bt-mcp.ts');
  const { Readable } = await import('node:stream');
  const q = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'room_roster', arguments: {} } }))]) as any;
  q.method = 'POST'; q.url = '/mcp'; q.headers = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  const out: any = { raw: '' };
  await bt.handle(q, { writeHead() {}, setHeader() {}, end(x: unknown) { out.raw = String(x ?? ''); } } as any, { projector: async () => (x: any) => x, log: () => {} });
  return JSON.parse(JSON.parse(out.raw).result.content[0].text);
}
btTools.plan('recipe:c1', Date.now() - 60_000);
ok(rooms.toolsSweep(() => {}) === 1, 'a planned pane that never connected: the sweep says so in the room (1 fact)');
ok(rooms.toolsSweep(() => {}) === 0, '...and only once');
const facts = table.searchLines(R.id, ['room', 'tools'], 20).filter((e: any) => /has no room tools: never-connected/.test(e.body || ''));
ok(facts.length === 1 && /@steward/.test(facts[0].body), 'the fact names the seat and the reason');
const r1 = await roster();
ok(r1.seats?.some((s: any) => s.handle === 'steward' && s.occupant?.tools === 'room'), "room_roster carries occupant.tools ('room': that very call connected the pane)");
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
