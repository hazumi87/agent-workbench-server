/**
 * IS THE VENDOR'S PROGRAM INSTALLED (src/engine/vendor-binary.ts): fb30s showed a starter lead that was a bare shell because nothing checked that `claude` exists before the
 * engine typed it. Resolved the way a shell would: PATH (absolute entries only, PATHEXT on Windows), then the usual install places. Pure: platform, env and the file check
 * are passed in, so the Windows rules run here on Linux. Three outcomes: a path, null (not found), and "not a program-running vendor" (a shell: nothing to check).
 */
import { programFor, resolveProgram, vendorDisplayName } from '../src/engine/vendor-binary.ts';

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };
const has = (...p: string[]) => (x: string): boolean => p.includes(x);

ok(programFor('claude-code') === 'claude' && programFor('codex-cli') === 'codex' && programFor('gemini-cli') === 'gemini', 'the program each agent vendor runs');
ok(programFor('cli-manager') === null && programFor('unknown') === null && programFor(null) === null, 'a shell (or anything else) has no program to check');
ok(vendorDisplayName('claude-code') === 'Claude Code' && vendorDisplayName('codex-cli') === 'Codex' && vendorDisplayName('gemini-cli') === 'Gemini CLI', 'plain names for the refusal');

console.log('\n[POSIX]');
ok(resolveProgram('claude', { platform: 'linux', env: { PATH: '/usr/bin:/home/u/bin' }, exists: has('/home/u/bin/claude') }) === '/home/u/bin/claude', 'found on PATH');
ok(resolveProgram('claude', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: has() }) === null, 'not on PATH and not in an install place: null');
ok(resolveProgram('claude', { platform: 'linux', env: { PATH: '/usr/bin', HOME: '/home/u' }, exists: has('/home/u/.local/bin/claude') }) === '/home/u/.local/bin/claude', 'the native installer\'s place, when PATH was not updated yet');
ok(resolveProgram('claude', { platform: 'linux', env: { PATH: '.:bin:/usr/bin' }, exists: (p) => p === './claude' || p === 'bin/claude' }) === null, 'a relative PATH entry is never searched (a file in the current folder must not stand in for the program)');

console.log('\n[Windows]');
const winEnv = { PATH: 'C:\\Windows;C:\\Tools\\bin', USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
ok(resolveProgram('claude', { platform: 'win32', env: winEnv, exists: has('C:\\Tools\\bin\\claude.exe') }) === 'C:\\Tools\\bin\\claude.exe', 'claude.exe on PATH');
ok(resolveProgram('claude', { platform: 'win32', env: winEnv, exists: has('C:\\Tools\\bin\\claude.cmd') }) === 'C:\\Tools\\bin\\claude.cmd', 'a .cmd shim (npm installs) counts');
ok(resolveProgram('claude', { platform: 'win32', env: { ...winEnv, Path: winEnv.PATH, PATH: undefined }, exists: has('C:\\Tools\\bin\\claude.exe') }) === 'C:\\Tools\\bin\\claude.exe', 'Windows spells the variable `Path`');
ok(resolveProgram('claude', { platform: 'win32', env: winEnv, exists: has('C:\\Users\\u\\.local\\bin\\claude.exe') }) === 'C:\\Users\\u\\.local\\bin\\claude.exe', 'the native installer\'s per-user place');
ok(resolveProgram('claude', { platform: 'win32', env: winEnv, exists: has('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd') }) === 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', 'the npm global folder');
ok(resolveProgram('claude', { platform: 'win32', env: winEnv, exists: has() }) === null, 'nothing installed: null');
ok(resolveProgram('claude', { platform: 'win32', env: { PATH: '.;bin' }, exists: () => true }) === null, 'relative entries are not searched on Windows either (the current folder is searched FIRST by the OS, which is the trap)');
ok(resolveProgram('claude', { platform: 'win32', env: { PATH: '"C:\\Tools\\bin"' }, exists: has('C:\\Tools\\bin\\claude.exe') }) === 'C:\\Tools\\bin\\claude.exe', 'a quoted PATH entry is unquoted');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
