// The rig template is supplied locally: a missing or malformed one must fail clearly (stub bpy/mathutils, no Blender needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STEPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'steps');
const PY = spawnSync('python3', ['-c', 'import numpy']).status === 0;

function run(env, params = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-rig-'));
  const stubs = path.join(dir, 'stubs');
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'bpy.py'), '');
  fs.writeFileSync(path.join(stubs, 'mathutils.py'),
    'class Vector:\n  def __init__(s,*a): pass\nclass Matrix: pass\nclass Euler: pass\nclass kdtree: pass\n');
  const args = path.join(dir, 'args.json');
  fs.writeFileSync(args, JSON.stringify({ params, tool_root: dir, job_dir: dir, step: 'rig_biped' }));
  const code = `import sys; sys.argv=['x','--',${JSON.stringify(args)}]; sys.path[:0]=[${JSON.stringify(STEPS)}, ${JSON.stringify(stubs)}]
import rig_common
t = rig_common.template(); print('LOADED', len(t['bones']))`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { r, dir };
}

test('no template shipped: the verb says what is missing and how to supply it', { skip: !PY }, () => {
  const { r } = run({ BLENDER_AGENT_RIG_TEMPLATE: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rig template not found/);
  assert.match(r.stderr, /RIG-TEMPLATE\.md/);
});

test('a template given by environment variable loads', { skip: !PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-rigt-'));
  const f = path.join(dir, 'tpl.json');
  fs.writeFileSync(f, JSON.stringify({ object: { rotation_euler: [0, 0, 0], scale: [1, 1, 1] }, bones: [{ name: 'Hips', parent: null, head: [0, 0, 0], tail: [0, 1, 0], roll: 0 }] }));
  const { r } = run({ BLENDER_AGENT_RIG_TEMPLATE: f });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LOADED 1/);
});

test('a template without bones is refused with the missing key named', { skip: !PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-rigt-'));
  const f = path.join(dir, 'bad.json');
  fs.writeFileSync(f, JSON.stringify({ object: {} }));
  const { r } = run({ BLENDER_AGENT_RIG_TEMPLATE: f });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing \['bones'\]/);
});
