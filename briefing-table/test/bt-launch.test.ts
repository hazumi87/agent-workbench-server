/**
 * E1 LAUNCH INJECTION (pure plan + byte tests; nothing launches a CLI): the per-pane bt config, the Claude and Codex command-line pieces, the role file, the token rules.
 * the design notes sections 3-4.
 */
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-btlaunch-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_PANE_TOKENS = '1';
process.env.HARBOR_WB_BT_MCP = '1';

const bl = await import('../src/engine/bt-launch.ts');
const { TOOL_NAMES } = await import('../src/server/bt-mcp.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const TOKEN = 'SECRETTOKEN0123456789abcdefghijklmnopqrstuvwxyz';

console.log('\n[the plan]');
const base = { enabled: true, vendor: 'claude-code', runsHere: true, port: 51234, paneid: 'recipe:abc#1', tokenFile: join(dir, 'mcp', 'tok.token'), dir: join(dir, 'mcp'), role: null as string | null };
let p = bl.planBt(base);
ok(p.on && p.vendor === 'claude-code', 'claude on this host: planned');
ok(!bl.planBt({ ...base, enabled: false }).on, 'off: not planned');
ok(!bl.planBt({ ...base, runsHere: false }).on, 'a pane that does not run on this host (ssh, the other PC): not planned');
ok(!bl.planBt({ ...base, vendor: 'cli-manager' }).on && !bl.planBt({ ...base, vendor: 'gemini-cli' }).on, 'a shell and Gemini (later) are not planned');
ok(!bl.planBt({ ...base, port: 0 }).on, 'no bound port yet: not planned (the pane would have no address)');
const off = bl.planBt({ ...base, enabled: false });
ok(!off.on && /off/.test((off as any).reason), '...with the reason named');

console.log('\n[claude: config file + flags]');
if (!p.on) throw new Error('plan');
const written = bl.writeBtConfig(p);
ok(existsSync(written.configPath) && (statSync(written.configPath).mode & 0o777) === 0o600, 'the per-pane config exists and is 0600');
const cfg = JSON.parse(readFileSync(written.configPath, 'utf8'));
ok(cfg.mcpServers?.bt?.type === 'http' && cfg.mcpServers.bt.url === 'http://127.0.0.1:51234/mcp', 'it names the bt server at the engine\'s own address');
const helper: string = cfg.mcpServers.bt.headersHelper;
ok(typeof helper === 'string' && helper.includes(base.tokenFile) && /Authorization/.test(helper) && /Bearer/.test(helper), 'the token comes from a headersHelper that reads the token FILE');
ok(!JSON.stringify(cfg).includes(TOKEN), 'the config never contains a token (it has only the file path)');
const cmd = written.claudeArgs;
ok(cmd.includes('--mcp-config') && cmd.includes(written.configPath), 'the command line names the config');
const allowed = cmd.slice(cmd.indexOf('--allowedTools')).split(/[\s,]+/).filter((x) => x.startsWith('mcp__'));
ok(JSON.stringify(allowed.sort()) === JSON.stringify(TOOL_NAMES.map((n) => `mcp__bt__${n}`).sort()), 'every tool is allowed BY NAME');
ok(!/mcp__bt(\s|$)/.test(cmd), '...and never the server-level mcp__bt (that would pre-allow future writes)');
ok(!cmd.includes(TOKEN) && !cmd.includes('Bearer'), 'no token or Authorization on the command line');
ok(!/[\u0000-\u0008\u000b-\u001f]/.test(readFileSync(written.configPath, 'utf8') + cmd), 'no stray control characters in the file or the line');

console.log('\n[role file: role first, then seat context, ONE file]');
mkdirSync(join(dir, 'agents', 'steward'), { recursive: true });
writeFileSync(join(dir, 'agents', 'steward', 'CLAUDE.md'), '# Steward\nPlan before building.\n');
const rolePath = bl.writeRoleFile('recipe:abc#1', { roleSource: join(dir, 'agents', 'steward', 'CLAUDE.md'), seatContext: 'You are @steward in "Alpha".' });
ok(!!rolePath && existsSync(rolePath), 'a role file is written');
const roleText = readFileSync(rolePath as string, 'utf8');
ok(roleText.indexOf('Plan before building.') >= 0 && roleText.indexOf('You are @steward') > roleText.indexOf('Plan before building.'), 'the person\'s role comes first, the seat context after');
ok((statSync(rolePath as string).mode & 0o777) === 0o600, '...0600');
const noRole = bl.writeRoleFile('recipe:abc#2', { roleSource: join(dir, 'agents', 'nobody', 'CLAUDE.md'), seatContext: 'You are @x.' });
ok(!!noRole && readFileSync(noRole, 'utf8').trim() === 'You are @x.', 'a missing role file is just the seat context (never blocks a start)');
ok(bl.writeRoleFile('recipe:abc#3', { roleSource: null, seatContext: '' }) === null, 'nothing to say: no file');
writeFileSync(join(dir, 'big.md'), 'x'.repeat(200 * 1024));
const big = bl.writeRoleFile('recipe:abc#4', { roleSource: join(dir, 'big.md'), seatContext: 'ctx' });
ok(!!big && readFileSync(big, 'utf8').length < 80 * 1024, 'an oversize role file is cut, not copied whole');
ok(bl.claudeRoleArgs(rolePath as string).startsWith('--append-system-prompt-file'), 'claude gets --append-system-prompt-file <file>');

console.log('\n[token in the pane ENV only (HARBOR_WB_PANE_TOKEN_DELIVERY=env: the pane\'s account is not the engine\'s)]');
{
  const { execFileSync } = await import('node:child_process');
  const { splitCommandLine } = await import('../src/engine/argv.ts');
  const edir = join(dir, 'mcp-env');
  const pe = bl.planBt({ ...base, paneid: 'recipe:env#1', dir: edir, tokenInEnv: true });
  ok(pe.on && pe.tokenInEnv === true, 'planned with tokenInEnv');
  if (pe.on) {
    const w = bl.writeBtConfig(pe);
    ok(!existsSync(w.configPath), 'NO config file is written into the engine config dir (the pane\'s account could not read it)');
    const argv = splitCommandLine(w.claudeArgs);
    ok(!!argv && argv[0] === '--mcp-config', 'the hosted direct-argv splitter reads the line (no shell needed)');
    const cfg = JSON.parse(argv?.[1] ?? '{}');
    const helper = cfg.mcpServers?.bt?.headersHelper as string;
    ok(cfg.mcpServers?.bt?.url === 'http://127.0.0.1:51234/mcp' && typeof helper === 'string', 'the inline config names the bt url and a helper');
    ok(!helper.includes('cat ') && helper.includes('$HARBOR_WB_PANE_TOKEN') && !helper.includes('tok.token'), 'the helper reads the ENV var, never a file');
    ok(!w.claudeArgs.includes(TOKEN), 'no token value on the line');
    const out = execFileSync('sh', ['-c', helper], { env: { PATH: process.env.PATH ?? '', HARBOR_WB_PANE_TOKEN: TOKEN } }).toString();
    ok(JSON.parse(out).Authorization === 'Bearer ' + TOKEN, 'run with only the env set, the helper prints the bearer header');
    ok(w.claudeArgs.includes('--allowedTools'), 'the tools are still allow-listed');
  }
  if (pe.on) {
    let threw = false;
    try { bl.writeBtConfig(pe, { mergeInto: join(edir, 'chan.json') }); } catch { threw = true; }
    ok(threw, 'a token-in-env pane REFUSES to merge into a channel config file (no quiet file)');
  }
  const pcx = bl.planBt({ ...base, vendor: 'codex-cli', paneid: 'recipe:env#2', dir: edir, tokenInEnv: true });
  ok(pcx.on, 'hosted Codex with explicit seat-account env delivery is planned');
  if (pcx.on) {
    const w = bl.writeBtConfig(pcx);
    ok(w.codexArgs.includes('bearer_token_env_var') && !w.codexArgs.includes('http_headers_helper') && !existsSync(bl.codexHelperPath(pcx.paneid, edir)), 'codex in a token-in-env pane reads the env var (its delivery), with no helper file in the engine dir');
  }
  const pf = bl.planBt(base);
  ok(pf.on && pf.tokenInEnv === false, 'a same-account pane is unchanged (file delivery)');
}

console.log('\n[codex: -c config + env token, LOCAL ONLY (D-E1-1)]');
delete process.env.HARBOR_WB_MODE;
const cxServer = bl.planBt({ ...base, vendor: 'codex-cli' });
ok(cxServer.on && cxServer.envToo === false, 'on a server a codex pane gets bt with NO token in its env (it reads the token FILE through a helper)');
if (cxServer.on) {
  const w = bl.writeBtConfig(cxServer);
  const helper = bl.codexHelperPath(cxServer.paneid, cxServer.dir);
  ok(w.codexArgs.includes('http_headers_helper') && w.codexArgs.includes(helper), 'the helper script path rides -c');
  ok(!w.codexArgs.includes('bearer_token_env_var') && !w.codexArgs.includes(TOKEN), 'no env bearer, no token on the line');
  ok((statSync(helper).mode & 0o777) === 0o700, 'the helper is 0700');
  const body = readFileSync(helper, 'utf8');
  ok(body.includes(cxServer.tokenFile) && !body.includes(TOKEN), 'the helper names the token FILE, never the value');
  ok(!w.codexArgs.includes('default_tools_approval_mode') && w.codexArgs.includes('tools.'), 'approval is per tool, not blanket');
  const { splitCommandLine } = await import('../src/engine/argv.ts');
  const argv = splitCommandLine(w.codexArgs);
  ok(!!argv && argv.length % 2 === 0 && argv.every((a, i) => (i % 2 === 0 ? a === '-c' : /^mcp_servers\.bt\.[a-z_.]+=".*"$/.test(a))), 'the hosted direct-argv splitter reads the line as clean -c pairs');
  ok(!!argv && argv.includes('mcp_servers.bt.http_headers_helper=' + JSON.stringify(helper)), '...and the helper value survives the split');
  bl.removeFiles(cxServer.paneid, cxServer.dir);
  ok(!existsSync(helper), 'the helper goes with the pane');
}
ok(bl.planBt(base).on, '...while claude on the same server still does');
process.env.HARBOR_WB_MODE = 'local';
const cx = bl.planBt({ ...base, vendor: 'codex-cli' });
ok(cx.on && cx.vendor === 'codex-cli', 'codex on this host: planned');
if (cx.on) {
  const w = bl.writeBtConfig(cx);
  ok(w.codexArgs.includes('mcp_servers.bt.url') && w.codexArgs.includes('http://127.0.0.1:51234/mcp'), 'the url rides -c');
  ok(w.codexArgs.includes('bearer_token_env_var') && w.codexArgs.includes('HARBOR_WB_PANE_TOKEN'), 'the token is read from the NAMED env var (D-E1-1)');
  ok(!w.codexArgs.includes(TOKEN), 'the value of the token is never on the line');
  ok(cx.envToo === true && p.envToo === false, 'only codex also needs the token in the pane env');
}

console.log('\n[the tool list is pinned (D-E1-4: no write verb joins bt while codex approves everything)]');
ok(JSON.stringify([...TOOL_NAMES]) === JSON.stringify(['handbook', 'room_list_mine', 'room_read', 'room_post', 'room_roster', 'session_whoami']), 'bt lists exactly the read verbs (handbook included) plus room_post; adding a tool must change this test on purpose');

console.log('\n[the headersHelper is POSIX-quoted whatever the platform]');
const quoted = bl.writeBtConfig({ ...(p as any), tokenFile: join(dir, "o'brien", 'tok.token'), paneid: 'recipe:q#1' });
const helperCmd: string = JSON.parse(readFileSync(quoted.configPath, 'utf8')).mcpServers.bt.headersHelper;
ok(helperCmd.includes(`o'\\''brien`) && !helperCmd.includes('o\'\'brien'), 'a quote in the path is escaped the POSIX way (never doubled the PowerShell way)');

console.log('\n[one --mcp-config when the fabric channel is on]');
const chan = join(dir, 'mcp', 'chan.json');
writeFileSync(chan, JSON.stringify({ mcpServers: { fabric: { command: 'node', args: ['x'] } } }));
const merged = bl.writeBtConfig({ ...(p as any), paneid: 'recipe:m#1' }, { mergeInto: chan });
const mergedCfg = JSON.parse(readFileSync(chan, 'utf8'));
ok(!!mergedCfg.mcpServers.fabric && !!mergedCfg.mcpServers.bt && merged.configPath === chan, 'bt is merged INTO the channel config; the fabric server is kept');
ok(!merged.claudeArgs.includes('--mcp-config') && !merged.claudeArgs.includes('--allowedTools') && merged.claudeArgs.startsWith('mcp__bt__'), 'the extra args are just tool names (they continue the channel flags\' --allowedTools list): no second --mcp-config, no repeated --allowedTools');
ok((statSync(chan).mode & 0o777) === 0o600, '...the merged file stays 0600');

console.log('\n[role source: INTERIM, agents/<role> folders only]');
ok(bl.roleSourceFor(join(dir, 'files', 'agents', 'steward'), true) === join(dir, 'files', 'agents', 'steward', 'CLAUDE.md'), 'an agents/<role> folder with the seat in a worktree: its CLAUDE.md');
ok(bl.roleSourceFor(join(dir, 'files', 'agents', 'steward'), false) === null, '...not when the seat runs IN that folder (claude loads CLAUDE.md itself)');
ok(bl.roleSourceFor(join(dir, 'code', 'repo'), true) === null, 'a code repo\'s CLAUDE.md is not appended (claude loads it from the worktree)');
ok(bl.roleSourceFor('C:\\Users\\x\\Documents\\agents\\steward', true) !== null && bl.roleSourceFor('agents', true) === null, 'Windows separators work, and a bare "agents" is not a role folder');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
