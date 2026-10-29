// Runner tests with a stub "blender" (POSIX). Run on a temp copy of the tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = `#!/usr/bin/env node
const fs = require('fs');
const a = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const mode = a.params.mode || 'ok';
if (mode === 'hang') { require('child_process').spawn('sleep', ['60']); setInterval(() => {}, 1000); return; }
if (mode === 'crash') process.exit(3);
fs.writeFileSync(a.output, 'blend');
fs.writeFileSync(a.report, JSON.stringify({ ok: mode === 'ok', saved: true, summary: { input: a.input } }));
`;

function tool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-test-'));
  fs.cpSync(path.join(SRC, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'config.example.json'), path.join(dir, 'config.example.json'));
  fs.writeFileSync(path.join(dir, 'scripts', 'steps', 'fake.py'), '');
  const stub = path.join(dir, 'blender-stub');
  fs.writeFileSync(stub, STUB, { mode: 0o755 });
  return { dir, stub };
}

function run({ dir, stub }, step, params, extra = []) {
  const pf = path.join(dir, `p-${Math.random()}.json`);
  fs.writeFileSync(pf, JSON.stringify(params));
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-step.mjs'), 'j1', step, pf, ...extra],
    { encoding: 'utf8', env: { ...process.env, BLENDER_AGENT_BLENDER: stub } });
  return { code: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()) };
}

test('a step runs, is recorded, and feeds the next step its .blend', () => {
  const t = tool();
  const a = run(t, 'fake', { mode: 'ok' });
  assert.equal(a.code, 0);
  assert.equal(a.out.output, '01-fake.blend');
  const b = run(t, 'fake', { mode: 'ok' });
  assert.match(b.out.summary.input, /01-fake\.blend$/);
  const job = JSON.parse(fs.readFileSync(path.join(t.dir, 'work', 'j1', 'job.json'), 'utf8'));
  assert.deepEqual(job.steps.map((s) => [s.n, s.ok]), [[1, true], [2, true]]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'status', 'widget.json'), 'utf8')).kind, 'ok');
});

test('a failing step is recorded as failed and is never used as input', () => {
  const t = tool();
  run(t, 'fake', { mode: 'ok' });
  assert.equal(run(t, 'fake', { mode: 'fail' }).code, 1);
  assert.equal(run(t, 'fake', { mode: 'crash' }).code, 1);
  const c = run(t, 'fake', { mode: 'ok' });
  assert.match(c.out.summary.input, /01-fake\.blend$/);
});

test('a hung step is killed at its timeout', () => {
  const t = tool();
  const started = Date.now();
  const r = run(t, 'fake', { mode: 'hang', timeout_s: 1 });
  assert.equal(r.code, 1);
  assert.match(r.out.error, /timed out/);
  assert.ok(Date.now() - started < 10000);
});

test('a live lock refuses; a stale lock is taken over', () => {
  const t = tool();
  fs.mkdirSync(path.join(t.dir, 'status'), { recursive: true });
  const lock = path.join(t.dir, 'status', '.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, what: 'other', at: 'now' }));
  const busy = run(t, 'fake', { mode: 'ok' });
  assert.equal(busy.code, 2);
  assert.match(busy.out.error, /busy/);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7, what: 'dead', at: 'then' }));
  assert.equal(run(t, 'fake', { mode: 'ok' }).code, 0);
});

test('bad job/step names and unknown steps are refused before anything runs', () => {
  const t = tool();
  assert.equal(run(t, '../x', {}).code, 2);
  assert.equal(run(t, 'nosuchstep', {}).code, 2);
});

test('lineage keeps the chain that produced the last .blend, not superseded branches', async () => {
  const { lineage } = await import('../scripts/lib/common.mjs');
  const s = (n, step, input, output) => ({ n, step, ok: true, input, output, params: {} });
  const steps = [
    s(1, 'import_mesh', null, '01.blend'), s(2, 'skin', '01.blend', '02.blend'),
    s(3, 'anim_idle', '02.blend', '03.blend'), s(4, 'export', '03.blend', null),
    s(5, 'anim_idle', '02.blend', '05.blend'), s(6, 'export', '05.blend', null), s(7, 'preview', '05.blend', null),
  ];
  assert.deepEqual(lineage(steps).map((x) => x.n), [1, 2, 5, 6, 7]);
});

test('lineage keeps non-saving steps that fed the chain mid-way (render_front -> face_landmarks -> mouth_cut)', async () => {
  const { lineage } = await import('../scripts/lib/common.mjs');
  const s = (n, step, input, output) => ({ n, step, ok: true, input, output, params: {} });
  const steps = [
    s(1, 'import_mesh', null, '01.blend'), s(2, 'render_front', '01.blend', null), s(3, 'face_landmarks', '01.blend', null),
    s(4, 'mouth_cut', '01.blend', '04.blend'), s(5, 'export', '04.blend', null),
    s(6, 'render_front', '99.blend', null),
  ];
  assert.deepEqual(lineage(steps).map((x) => x.n), [1, 2, 3, 4, 5]);
});

test('lineage keeps only the latest re-run of a side step on the same .blend', async () => {
  const { lineage } = await import('../scripts/lib/common.mjs');
  const s = (n, step, input, output) => ({ n, step, ok: true, input, output, params: {} });
  const steps = [s(1, 'import_mesh', null, '01.blend'), s(2, 'export', '01.blend', null), s(3, 'validate', '01.blend', null),
    s(4, 'export', '01.blend', null), s(5, 'validate', '01.blend', null), s(6, 'meshopt', '01.blend', null)];
  assert.deepEqual(lineage(steps).map((x) => x.n), [1, 4, 5, 6]);
});
