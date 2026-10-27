/**
 * LOCAL MODE, pure rules (src/engine/local-mode.ts): when the engine may start as the desktop app's child, which port it takes,
 * which Host and Origin it answers, and the one ready line the supervisor waits for. No engine is started here (see
 * local-mode-engine.test.mjs for that).
 */
import { brokerAutostartEnabled, browserOriginRefused, hostHeaderAllowed, isLocalMode, localModeConfig, localPort, originAllowed, readyLine, supervisorOrigins } from '../src/engine/local-mode.ts';
import { spawnEnv } from '../src/engine/cli-host.ts';
import { brokerSpawnEnv } from '../src/engine/broker-client.ts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}

const good = { HARBOR_WB_MODE: 'local', HARBOR_WB_TOKEN: 't', HARBOR_WB_DATA_DIR: '/x', HARBOR_WB_FILES_DIR: '/f' };
ok(!localModeConfig({}).enabled && localModeConfig({}).problems.length === 0, 'no HARBOR_WB_MODE: server mode, nothing changes');
ok(!localModeConfig({ HARBOR_WB_MODE: 'server' }).enabled, 'any other mode value is server mode');
ok(localModeConfig(good).enabled && localModeConfig(good).problems.length === 0, 'local mode with a token and a data dir may start');
ok(localModeConfig({ ...good, HARBOR_WB_MODE: ' LOCAL ' }).enabled, 'the switch is case- and space-insensitive');
ok(localModeConfig({ ...good, HARBOR_WB_TOKEN: '' }).problems.some((p) => /HARBOR_WB_TOKEN/.test(p)), 'no token: refused (never minted)');
ok(localModeConfig({ ...good, HARBOR_WB_TOKEN: '  ' }).problems.length === 1, 'a blank token is no token');
ok(localModeConfig({ ...good, HARBOR_WB_DATA_DIR: undefined }).problems.some((p) => /DATA_DIR/.test(p)), 'no data dir: refused (nothing in the install folder)');
ok(localModeConfig({ ...good, HARBOR_WB_FILES_DIR: '' }).problems.some((p) => /FILES_DIR/.test(p)), 'no files folder: refused (it is chosen at first run)');
ok(localModeConfig({ ...good, HARBOR_WB_FILES_DIR: '/x' }).problems.some((p) => /overlap/.test(p)), 'a files folder equal to the data folder is refused');
ok(localModeConfig({ ...good, HARBOR_WB_FILES_DIR: '/x/files' }).problems.some((p) => /overlap/.test(p)), 'a files folder INSIDE the data folder is refused');
ok(localModeConfig({ ...good, HARBOR_WB_FILES_DIR: '/' }).problems.some((p) => /overlap/.test(p)) && localModeConfig({ ...good, HARBOR_WB_DATA_DIR: '/f/data' }).problems.some((p) => /overlap/.test(p)), 'a files folder ABOVE the data folder is refused');
ok(!localModeConfig({ ...good, HARBOR_WB_FILES_DIR: '/xyz' }).problems.some((p) => /overlap/.test(p)) && !localModeConfig(good).problems.some((p) => /overlap/.test(p)), 'a sibling with a similar name is fine (/x vs /xyz)');
ok(localModeConfig({ ...good, HARBOR_WB_HOST: '0.0.0.0' }).problems.some((p) => /127\.0\.0\.1 only/.test(p)), 'a non-loopback host is refused');
ok(localModeConfig({ ...good, HARBOR_WB_HOST: '127.0.0.1' }).problems.length === 0, 'the loopback host is fine');
ok(localModeConfig({ ...good, HARBOR_WB_IDENTITY: 'strict' }).problems.some((p) => /no accounts/.test(p)), 'accounts are refused');
ok(localModeConfig({ ...good, HARBOR_WB_IDENTITY: 'legacy' }).problems.length === 0, 'legacy identity is the local path');
ok(localModeConfig({ HARBOR_WB_MODE: 'local' }).problems.length === 3, 'every missing thing is listed, not just the first');

ok(localPort({}) === 0 && localPort({ HARBOR_WB_PORT: '' }) === 0, 'the port defaults to 0 (the OS picks)');
ok(localPort({ HARBOR_WB_PORT: '7431' }) === 7431, 'a valid port is honoured (tests)');
ok(localPort({ HARBOR_WB_PORT: 'abc' }) === 0 && localPort({ HARBOR_WB_PORT: '70000' }) === 0 && localPort({ HARBOR_WB_PORT: '-1' }) === 0, 'a bad port falls back to 0');

ok(hostHeaderAllowed('127.0.0.1:5000', 5000), 'Host 127.0.0.1 on our port is allowed');
ok(hostHeaderAllowed('localhost:5000', 5000) && hostHeaderAllowed('LOCALHOST:5000', 5000), 'localhost is allowed, any case');
ok(hostHeaderAllowed('[::1]:5000', 5000), 'the IPv6 loopback name is allowed');
ok(!hostHeaderAllowed('127.0.0.1:5001', 5000), 'the wrong port is refused');
ok(!hostHeaderAllowed('evil.example:5000', 5000), 'another name pointed at 127.0.0.1 (DNS rebinding) is refused');
ok(!hostHeaderAllowed('127.0.0.1.evil.example:5000', 5000), 'a name that merely starts with the address is refused');
ok(!hostHeaderAllowed(undefined, 5000) && !hostHeaderAllowed('', 5000), 'no Host header is refused');
ok(!hostHeaderAllowed('127.0.0.1', 5000), 'no port means port 80, which is not ours');

ok(originAllowed(undefined, 5000), 'no Origin (a non-browser client) is allowed');
ok(originAllowed('http://127.0.0.1:5000', 5000) && originAllowed('http://localhost:5000', 5000), 'our own loopback origin is allowed');
ok(!originAllowed('http://evil.example', 5000), 'another site is refused');
ok(!originAllowed('http://127.0.0.1:5001', 5000), 'our address on another port is refused');
ok(!originAllowed('not a url', 5000), 'an unparsable Origin is refused');
ok(!originAllowed('file:///x', 5000), 'a non-http Origin is refused');

const line = readyLine(5000);
ok(!line.includes('\n') && line.length < 100, 'the ready line is one short line');
ok(JSON.parse(line).ready === true && JSON.parse(line).port === 5000 && JSON.parse(line).mode === 'local', 'it says ready, the mode and the port');
ok(!/token|secret/i.test(line), 'and carries nothing secret');

ok(isLocalMode({ HARBOR_WB_MODE: ' Local ' }) && !isLocalMode({}) && !isLocalMode({ HARBOR_WB_MODE: 'server' }), 'isLocalMode reads the switch');
ok(!brokerAutostartEnabled({ HARBOR_WB_MODE: 'local' }) && !brokerAutostartEnabled({ HARBOR_WB_MODE: 'local', HARBOR_WB_BROKER_AUTOSTART: '1' }), 'local mode NEVER autostarts the broker (no scheduled task), whatever the setting');
ok(brokerAutostartEnabled({}) && !brokerAutostartEnabled({ HARBOR_WB_BROKER_AUTOSTART: '0' }), 'server mode keeps its default (on unless 0)');
ok(supervisorOrigins({ HARBOR_WB_ALLOWED_ORIGINS: ' app://workbench , http://x:1 ,' }).join('|') === 'app://workbench|http://x:1' && supervisorOrigins({}).length === 0, 'the supervisor\'s extra origins are a trimmed comma list');
ok(!browserOriginRefused({}, 5000), 'no Origin, no Sec-Fetch-Site (curl, the hook, the app\'s main process): not refused');
ok(!browserOriginRefused({ origin: 'http://127.0.0.1:5000' }, 5000), 'our own origin: not refused');
ok(browserOriginRefused({ origin: 'http://evil.example' }, 5000), 'a foreign Origin: refused');
ok(browserOriginRefused({ origin: 'null' }, 5000), 'Origin: null (a sandboxed page or file): refused');
ok(!browserOriginRefused({ origin: 'app://workbench' }, 5000, ['app://workbench']) && browserOriginRefused({ origin: 'app://other' }, 5000, ['app://workbench']), 'a supervisor-allowed origin passes, others do not');
ok(browserOriginRefused({ 'sec-fetch-site': 'cross-site' }, 5000), 'no Origin but Sec-Fetch-Site cross-site: refused');
ok(!browserOriginRefused({ 'sec-fetch-site': 'same-origin' }, 5000) && !browserOriginRefused({ 'sec-fetch-site': 'none' }, 5000), 'same-origin and user-typed navigations are not refused');
{
  const base = { PATH: '/bin', HARBOR_WB_TOKEN: 'secret', HARBOR_WB_TOKEN_FILE: '/x/t', HARBOR_WB_PANE_TOKEN: 'p', HARBOR_WB_DATA_DIR: '/d' };
  const desc = { binary: 'sh', args: [], cwd: '/' } as never;
  const local = spawnEnv(desc, { ...base, HARBOR_WB_MODE: 'local' });
  ok(local.HARBOR_WB_TOKEN === undefined && local.HARBOR_WB_TOKEN_FILE === undefined && local.HARBOR_WB_PANE_TOKEN === undefined, 'local mode: a pane never inherits the engine token, its file name or a pane token');
  ok(local.PATH === '/bin' && local.HARBOR_WB_DATA_DIR === '/d', '...and keeps the rest of the environment');
  ok(spawnEnv(desc, base).HARBOR_WB_TOKEN === 'secret', 'server mode is unchanged (it keeps its token in a file, not in a pane)');
  /* by VALUE, not only by name: a copy of a secret under any other name goes too */
  const sneaky = spawnEnv(desc, { PATH: '/bin', HARBOR_WB_MODE: 'local', HARBOR_WB_TOKEN: 'engine-secret-value', PTY_BROKER_TOKEN: 'broker-secret-value', LAUNCHER_COPY: 'engine-secret-value', FUTURE_NAME: 'broker-secret-value', KEEP_ME: 'ordinary' });
  ok(!Object.values(sneaky).some((v) => v === 'engine-secret-value' || v === 'broker-secret-value') && sneaky.KEEP_ME === 'ordinary', 'local mode: no variable carries a secret VALUE into a pane, under any name; ordinary variables stay');
  ok(Object.values(sneaky).join('|').indexOf('secret-value') === -1, '...a scan of every pane variable for the token values finds nothing');
  /* fail closed: the broker's bearer never reaches a pane, even if the mode switch is absent at spawn time */
  const noMode = spawnEnv(desc, { PATH: '/bin', PTY_BROKER_TOKEN: 'broker-secret-value', HARBOR_WB_BROKER_TOKEN: 'broker-secret-value', HARBOR_WB_BROKER_TOKEN_FILE: '/x' });
  ok(noMode.PTY_BROKER_TOKEN === undefined && noMode.HARBOR_WB_BROKER_TOKEN === undefined && noMode.HARBOR_WB_BROKER_TOKEN_FILE === undefined, 'without the mode switch the broker tokens are STILL dropped (fail closed)');
  const spawnLocal = brokerSpawnEnv({ A: '1' }, 'local', { HARBOR_WB_TOKEN: 'engine-secret-value', PTY_BROKER_TOKEN: 'broker-secret-value', COPY_OF_IT: 'broker-secret-value', OTHER: 'x' });
  ok(spawnLocal?.A === '1' && spawnLocal?.PTY_BROKER_TOKEN === '' && spawnLocal?.HARBOR_WB_TOKEN === '' && spawnLocal?.COPY_OF_IT === '' && spawnLocal?.OTHER === undefined, 'a local spawn sent to the broker blanks the named tokens and any variable of ours that carries a secret value');
  ok(brokerSpawnEnv({ A: '1' }, undefined, {})?.A === '1' && Object.keys(brokerSpawnEnv({ A: '1' }, undefined, {}) ?? {}).length === 1 && brokerSpawnEnv(undefined, 'server', {}) === undefined, 'server mode spawns are unchanged');
}

{
  console.log('\n[H6: hosted scrubs engine secrets from a pane env]');
  const h = spawnEnv({ binary: 'x' } as never, { PATH: '/bin', HARBOR_WB_HOSTED: '1', HARBOR_WB_TOKEN: 'engine-secret-value', COPY: 'engine-secret-value', HARBOR_WB_WINDOW_AGENT_TOKEN: 'wa-secret-value', KEEP_ME: 'ordinary' });
  ok(h.HARBOR_WB_TOKEN === undefined && h.COPY === undefined && h.HARBOR_WB_WINDOW_AGENT_TOKEN === undefined && h.KEEP_ME === 'ordinary', 'hosted: engine token, its copies and the window-agent token are gone; ordinary vars stay');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
