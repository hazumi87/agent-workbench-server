import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backgroundWork, isBusy } from '../src/engine/bg-detect.ts';


/* the runner's summary line (PASS n FAIL m): a tiny local test() instead of node:test, which prints no such line */
let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  \u2717 ${name}: ${(e as Error).message}`);
  }
}

const DIR = new URL('./fixtures/bg-screens/', import.meta.url);
const load = (n: string): string[] =>
  readFileSync(new URL(`${n}.txt`, DIR), 'utf8').split('\n').filter((l) => !l.startsWith('# ')).map((l) => l.trimEnd());

test('baseline idle prompt: not detected (the constant "2 agents" tail is not work)', () => {
  const r = backgroundWork(load('baseline-1'));
  assert.ok(r);
  assert.equal(isBusy(r), false);
});

test('background shell running: 1 shell', () => {
  for (const n of ['bgshell-1', 'bgshell-3', 'bgshell-6', 'manage-1', 'manage-esc-1']) {
    const r = backgroundWork(load(n));
    assert.equal(r?.shells, 1, n);
    assert.equal(r?.agents, 0, n);
  }
});

test('two background shells', () => {
  for (const n of ['two-1', 'two-6']) {
    assert.equal(backgroundWork(load(n))?.shells, 2, n);
  }
});

test('sub-agent running: 1 agent (status line + tree)', () => {
  for (const n of ['agent-1', 'agent2-1', 'agent2-3', 'agent2-6']) {
    const r = backgroundWork(load(n));
    assert.equal(r?.agents, 1, n);
    assert.equal(r?.shells, 0, n);
  }
});

test('finished work reads as nothing running', () => {
  for (const n of ['bgshell-after-1', 'two-after-1', 'agent2-after-1', 'agent-2']) {
    const r = backgroundWork(load(n));
    assert.ok(r, n);
    assert.equal(isBusy(r), false, n);
  }
});

test('foreground turn in progress is not background work', () => {
  for (const n of ['foreground-1', 'foreground-2']) {
    assert.equal(isBusy(backgroundWork(load(n))), false, n);
  }
});

test('footer covered by a dialog: cannot tell', () => {
  const rows = load('bgshell-1');
  const covered = rows.slice(0, rows.findIndex((l) => l.startsWith('✻ ')));
  assert.equal(backgroundWork(covered), null);
  assert.equal(backgroundWork([]), null);
  assert.equal(backgroundWork([' Quick safety check', ' ❯ No, exit', '   Yes, I trust this folder']), null);
});

test('words typed in the composer or said in chat do not count', () => {
  const rows = load('baseline-1');
  const at = rows.findIndex((l) => l.startsWith('❯'));
  const typed = [...rows];
  typed[at] = '❯ is 1 shell still running? ✻ Waiting for 3 background agents to finish · 2 shells';
  assert.equal(isBusy(backgroundWork(typed)), false);
  const chat = [...rows];
  chat.splice(at, 0, '● Note: the footer shows · 1 shell and "1 shell still running" while it works', '  ◯ not a tree row at column zero');
  assert.equal(isBusy(backgroundWork(chat)), false);
});

test('unknown "N <kind> still running" is reported as other', () => {
  const rows = load('bgshell-1').map((l) => l.replace('1 shell still running', '1 monitor still running').replace(/ · 1 shell/, ''));
  const r = backgroundWork(rows);
  assert.equal(r?.other, true);
  assert.equal(r?.shells, 0);
});

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
