"""mesh-studio -- Model Studio's image-to-mesh backend on the GPU host.

Contract: Model Studio backend Model Studio backend contract .
GPU: harbor's traffic cop, docs/gpu-cop-schema.md (gpu-cop/2).

This process never imports torch and never holds VRAM. Each job runs run_once.py in the engine's
own venv as a CHILD process, which exits when the job ends, so "released" really is "freed".

HTTP (binds to MESH_BIND, default 127.0.0.1; set it to a LAN or VPN address only if other machines must reach it):
  GET  /manifest          provider manifest: operations = one per engine+recipe (op 'image-to-mesh')
  GET  /health            {ok, busy, version, gpu_runs}
  POST /run               {id, inputs:{front, left?, back?, right?: Library id}, params, origin?} -> 202 {jobId}
  GET  /jobs/<id>         {state, phase, pct, error, result:{assetIds}, log_tail}
  POST /jobs/<id>/cancel
  GET  /jobs?limit=       newest first
  GET  /gpu/status        the cop's poll (gpu-cop/1 section 1)
Auth: /run and /jobs* need `Authorization: Bearer <token>`. This side holds only the token's sha256, read per
request from MESH_TOKEN_SHA256_FILE (a fixed path outside any repo, written by exec; harbor keeps *TOKEN* values
out of the manifest). The token itself lives only on the server, in the core's bearer_file. A missing, empty or
malformed hash file = those routes refuse (fail closed). /manifest, /health, /gpu/status are open.

GPU gate, in order, before any job touches the card:
  1. MESH_GPU_ENABLED=1, off by default (the user's stand-down for the cop build);
  2. a GRANTED lease (POST /gpu/lease with HARBOR_GPU_TOKEN, min = want; no token or no cop = no run).
     The grant is trusted: the cop already did the fit arithmetic, and re-POSTing would lose the queue place;
  3. run_once's own free-VRAM floor and 500 MB spill guard, as the backstop.
Until all pass, the job stays queued with phase "waiting on GPU scheduling: <why>".
"""
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = '2026.09.29'
ROOT = Path(os.environ.get('MESH_ROOT', str(Path.home() / 'mesh-workspace')))
WORK = Path(os.environ.get('MESH_WORK', str(Path.home() / 'mesh-workspace' / 'jobs')))
SHARE_DIR = Path(os.environ.get('MESH_SHARE_DIR', str(Path.home() / 'agent-share' / 'mesh-studio' / 'runs')))
SHARE_URL = os.environ.get('MESH_SHARE_URL', 'http://127.0.0.1:8215/raw/mesh-studio/runs')
LIBRARY = os.environ.get('MESH_LIBRARY', 'http://localhost/asset-management/library/api')
BIND = os.environ.get('MESH_BIND', '127.0.0.1')
PORT = int(os.environ.get('MESH_PORT', '8291'))
COP = os.environ.get('MESH_COP_URL', 'http://127.0.0.1:8210/gpu')
GPU_ENABLED = os.environ.get('MESH_GPU_ENABLED', '0') == '1'
TOKEN_SHA256_FILE = Path(os.environ.get('MESH_TOKEN_SHA256_FILE', str(Path.home() / 'mesh-workspace' / 'bearer.sha256')))
HERE = Path(__file__).resolve().parent

HUNYUAN_LICENCE = {'outputs': 'evaluation_only', 'name': 'tencent-hunyuan-3d-2.0-community',
                   'note': 'Outputs may not be used or shown in the EU, UK or South Korea (section 5c).'}
# Measured (GPU memory measurements). floor = least free VRAM to start; need = run requirement.
ENGINES = {
    'hunyuan-2mv-turbo': {'label': 'Hunyuan3D-2mv turbo (fast draft)', 'engine': 'hunyuan', 'venv': ROOT / 'venv',
                          'args': ['--subfolder', 'hunyuan3d-dit-v2-mv-turbo', '--flashvdm', '--steps', '5', '--octree', '380'],
                          'floor_mib': 6000, 'need_mib': 8000, 'seconds': 70, 'licence': HUNYUAN_LICENCE},
    'hunyuan-2mv-quality': {'label': 'Hunyuan3D-2mv quality (faces)', 'engine': 'hunyuan', 'venv': ROOT / 'venv',
                            'args': ['--subfolder', 'hunyuan3d-dit-v2-mv', '--steps', '50', '--octree', '512'],
                            'floor_mib': 7000, 'need_mib': 9000, 'seconds': 200, 'licence': HUNYUAN_LICENCE},
    'trellis-v1': {'label': 'TRELLIS v1 multi-image (licence-clean, weaker faces)', 'engine': 'trellis',
                   'venv': ROOT / 'trellis' / 'venv', 'args': ['--trellis-mode', 'stochastic'],
                   # Exclusive. Torch peak was 16,920 MiB + ~2 GB WDDM spill: a SINGLE measurement (, voice
                   # paused). need must stay under the card (16,376) or no lease can ever be granted; the rest spills.
                   'floor_mib': 14000, 'need_mib': 14500, 'seconds': 90, 'licence': None},
}
VIEWS = ('front', 'left', 'back', 'right')
CAMERAS = {'front': '+Z→-Z', 'left': '+X→-X', 'back': '-Z→+Z', 'right': '-X→+X'}
PARAMS = {'type': 'object', 'additionalProperties': False, 'properties': {
    'seed': {'type': 'integer', 'default': 12345, 'title': 'Seed'},
    'target_height_m': {'type': 'number', 'default': 1.8, 'minimum': 0.05, 'maximum': 20,
                        'title': 'Height (m)', 'description': 'crown to soles, or crown to the cut for a bust'},
    'label': {'type': 'string', 'title': 'Label'}}}

JOBS, LOCK, QUEUE = {}, threading.Lock(), queue.Queue()
STATE = {'child': None, 'job': None, 'last': None}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def manifest():
    ops = [{'op': 'image-to-mesh', 'id': k, 'label': e['label'],
            'inputs': [{'kind': 'asset', 'category': 'image', 'name': v, 'required': v == 'front'} for v in VIEWS],
            'outputs': [{'kind': 'asset', 'category': 'mesh', 'arity': '1'}],
            'params': PARAMS, 'est': {'seconds': e['seconds']},
            'gpu': {'need_mb': e['need_mib'], 'floor_mb': e['floor_mib']}, 'license': e['licence']}
           for k, e in ENGINES.items()]
    return {'id': 'mesh-studio', 'label': 'Mesh Studio (image to mesh)', 'version': VERSION, 'profileVersion': 1,
            'runtime': {'host': 'gpu-host', 'health': 'GET /health', 'gpu': {'need_mb': 8000}},
            'license': None,  # per operation: the Hunyuan ids are evaluation_only, TRELLIS is clean
            'operations': ops}


def set_job(jid, **kw):
    with LOCK:
        JOBS[jid].update(kw, updated=time.time())
    if 'phase' in kw:
        log(f'job {jid}: {kw["phase"]}')


def public(j):
    return {k: j.get(k) for k in ('jobId', 'id', 'state', 'phase', 'pct', 'error', 'result', 'created', 'updated', 'inputs', 'params')} | {
        'log_tail': j.get('log_tail')}


# ---------- GPU gate ----------
def cop(path, body=None, token=None):
    req = urllib.request.Request(f'{COP}/{path}', data=json.dumps(body).encode() if body is not None else None,
                                 method='POST' if body is not None else 'GET',
                                 headers={'Content-Type': 'application/json', **({'Authorization': f'Bearer {token}'} if token else {})})
    with urllib.request.urlopen(req, timeout=2) as r:
        return json.load(r)


def gate(jid, eng):
    """Block until the GPU may be used for this job; return the lease id. Raises on cancel or refusal."""
    j = JOBS[jid]
    # min = want: mesh spills rather than degrading, so a partial grant must never happen (cop review, line 1553)
    body = {'want_mib': eng['need_mib'], 'min_mib': eng['need_mib'], 'expected_s': eng['seconds'],
            'initiator': (j.get('origin') or {}).get('initiator') or 'agent:mesh-workspace',
            'room': (j.get('origin') or {}).get('room'), 'reason': f"image-to-mesh {j['id']}"}
    while True:
        if j.get('cancel'):
            raise RuntimeError('cancelled while waiting for GPU')
        why = None
        token = os.environ.get('HARBOR_GPU_TOKEN')
        if not GPU_ENABLED:
            why = 'GPU runs are off (MESH_GPU_ENABLED) until the traffic cop test turn'
        elif not token:
            why = 'no HARBOR_GPU_TOKEN (not launched by harbor), so no lease is possible'
        else:
            try:
                r = cop('lease', body, token)
                if r.get('status') == 'refused':
                    raise RuntimeError(f"GPU refused: {r.get('reason')}")
                if r.get('status') == 'granted':  # the cop did the fit arithmetic; run_once's spill guard is the backstop
                    return r['lease_id']
                else:
                    held = ', '.join(x.get('why') or f"{x.get('service')} {(x.get('mib') or 0) / 1024:.1f} GB"
                                     for x in (r.get('blocked_by') or [])[:3]) or 'the queue'
                    why = f"queued #{r.get('position')}: {held}"
            except RuntimeError:
                raise
            except Exception as e:
                why = f'traffic cop unreachable ({e.__class__.__name__})'
        set_job(jid, phase=f'waiting on GPU scheduling: {why}')
        for _ in range(20):  # re-POST well inside the cop's 30 s waiter window
            if j.get('cancel'):
                raise RuntimeError('cancelled while waiting for GPU')
            time.sleep(1)


# ---------- the job ----------
def fetch(asset_id, dest):
    with urllib.request.urlopen(f'{LIBRARY}/assets/{asset_id}/file', timeout=60) as r:
        dest.write_bytes(r.read())


def child(jid, cmd, logf):
    """Run one step as a child process; cancel kills its whole tree."""
    with open(logf, 'ab') as out:
        p = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, cwd=str(HERE),
                             creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))
        STATE['child'] = p
        try:
            while p.poll() is None:
                if JOBS[jid].get('cancel'):
                    subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True)
                    raise RuntimeError('cancelled')
                time.sleep(1)
        finally:
            STATE['child'] = None
    tail = logf.read_text(errors='replace').splitlines()[-8:]
    set_job(jid, log_tail='\n'.join(tail))
    if p.returncode:
        raise RuntimeError(f'{Path(cmd[1]).name} exited {p.returncode}')


def publish(jid, eng, glb, report, xform, share_run):
    j = JOBS[jid]
    inputs = j['inputs']
    derived = {'op': 'image-to-mesh', 'provider': 'mesh-studio', 'id': j['id'], 'version': VERSION,
               'params': j['params'], 'inputs': inputs, 'model': report.get('model'),
               'engine_params': report.get('params'), 'scale': xform, 'run_id': report.get('run_id'),
               'rembg': 'birefnet-general (MIT)', 'contract': 'GLB contract v0'}
    c = report['clean']
    meta = {'origin': j.get('origin') or {'kind': 'app', 'app': 'mesh-studio'},
            'mesh': {'tris': c['faces'], 'watertight': c['watertight'], 'components': c['components'],
                     'units': 'm', 'up': '+Y', 'facing': '+Z'},
            'projection': {'frame': 'gltf +Y up, facing +Z, metres', 'crop_border': 0.15, 'crop': 'per-view silhouette bbox',
                           'views': {v: {'camera': CAMERAS[v], 'cutout': f'{SHARE_URL}/{share_run}/cut_{v}.png',
                                         'library_id': inputs[v]} for v in report.get('views', []) if v in inputs}}}
    if eng['licence']:
        meta['evaluation_only'] = eng['licence']['outputs'] == 'evaluation_only'
        meta['licence'] = eng['licence']
    label = j['params'].get('label') or f"mesh - {j['id']}"
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in (('label', label), ('source', 'mesh-studio'), ('parent_id', inputs['front']),
                 ('derived_op', json.dumps(derived)), ('meta', json.dumps(meta))):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    fname = f"{j['id']}-{jid[:8]}.glb"
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fname}"\r\n'
                 f'Content-Type: model/gltf-binary\r\n\r\n'.encode() + glb.read_bytes() + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    req = urllib.request.Request(f'{LIBRARY}/assets/upload', data=b''.join(parts), method='POST',
                                 headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)['asset']['id']


def run_job(jid):
    j = JOBS[jid]
    eng = ENGINES[j['id']]
    d = WORK / jid
    d.mkdir(parents=True, exist_ok=True)
    logf = d / 'job.log'
    lease_id = None
    try:
        set_job(jid, phase='fetching views from the Library', pct=5)
        for v, aid in j['inputs'].items():
            fetch(aid, d / f'job_{v}.png')
        lease_id = gate(jid, eng)
        STATE['job'] = jid
        set_job(jid, state='running', phase=f"generating ({eng['label']})", pct=20)
        py = str(eng['venv'] / 'Scripts' / 'python.exe')
        child(jid, [py, str(HERE / 'run_once.py'), '--engine', eng['engine'], '--char', 'job', '--views', str(d),
                    '--out', str(d / 'out'), '--seed', str(j['params'].get('seed', 12345)),
                    '--min-free-mb', str(eng['floor_mib']), '--spill-mb', '4000' if eng['engine'] == 'trellis' else '500',
                    '--timeout-s', str(max(600, eng['seconds'] * 4)), *eng['args']], logf)
        run = max((d / 'out').iterdir(), key=lambda p: p.stat().st_mtime)
        report = json.loads((run / 'report.json').read_text())
        if report.get('status') != 'ok':
            raise RuntimeError(f"run_once: {report.get('status')}")
        if lease_id:
            lease_release(lease_id)
            lease_id = None
        STATE['job'] = None
        set_job(jid, phase='scaling to the contract (metres, origin, +Y up)', pct=80)
        height = float(j['params'].get('target_height_m', 1.8))
        out_glb = d / 'mesh.glb'
        child(jid, [str(ROOT / 'venv' / 'Scripts' / 'python.exe'), str(HERE / 'export_contract.py'),
                    str(run / 'clean.glb'), str(out_glb), '--height-m', str(height)], logf)
        xform = json.loads(logf.read_text(errors='replace').strip().splitlines()[-1])
        share_run = f'{run.name}-{jid[:8]}'
        (SHARE_DIR / share_run).mkdir(parents=True, exist_ok=True)
        for f in run.glob('cut_*.png'):
            shutil.copy2(f, SHARE_DIR / share_run / f.name)
        shutil.copy2(run / 'report.json', SHARE_DIR / share_run / 'report.json')
        set_job(jid, phase='publishing to the Library', pct=90)
        asset_id = publish(jid, eng, out_glb, report, xform, share_run)
        set_job(jid, state='done', phase='done', pct=100, result={'assetIds': [asset_id]},
                stats={'times_s': report.get('times_s'), 'gpu': report.get('gpu_peaks_by_stage'), 'clean': report.get('clean')})
    except Exception as e:
        cancelled = j.get('cancel')
        set_job(jid, state='cancelled' if cancelled else 'error', phase='cancelled' if cancelled else 'failed',
                error=None if cancelled else str(e))
        if not cancelled:
            traceback.print_exc()
    finally:
        STATE.update(job=None, last=time.time())
        if lease_id:
            lease_release(lease_id)


def lease_release(lease_id):
    try:
        cop(f'lease/{lease_id}/release', {}, os.environ.get('HARBOR_GPU_TOKEN'))
    except Exception as e:
        log(f'lease {lease_id} release failed ({e}); the cop drops it when this job ends')


def worker():
    while True:
        jid = QUEUE.get()
        if JOBS[jid].get('cancel'):
            set_job(jid, state='cancelled', phase='cancelled')
            continue
        run_job(jid)


def gpu_status():
    busy = STATE['job'] is not None
    eng = ENGINES[JOBS[STATE['job']]['id']] if busy else None
    queued = sum(1 for j in JOBS.values() if j['state'] in ('queued', 'running')) - (1 if busy else 0)
    return {'state': 'busy' if busy else 'stopped', 'interactive': False, 'restart_safe': not busy and queued == 0,
            'vram_held_mib': 0,  # the sidecar holds none; the cop measures the child's pid tree itself
            'floor_mib': eng['floor_mib'] if busy else 6000,
            'active_jobs': int(busy), 'queued_jobs': max(0, queued),
            'last_activity_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(STATE['last'])) if STATE['last'] else None,
            'load_error': None, 'current_job': {'id': STATE['job']} if busy else None,
            'busy_reason': f"image-to-mesh {JOBS[STATE['job']]['id']}" if busy else None}


class Handler(BaseHTTPRequestHandler):
    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass

    def authed(self):
        import hashlib
        import hmac
        got = self.headers.get('Authorization', '')
        tok = got[7:].strip() if got.startswith('Bearer ') else ''
        try:  # re-read each time: a rotation needs no restart
            want = TOKEN_SHA256_FILE.read_text(encoding='ascii').strip().lower()
        except OSError:
            want = ''
        if len(want) != 64 or any(c not in '0123456789abcdef' for c in want):
            self.send(401, {'error': 'token hash file missing or malformed: job routes are closed'})
            return False
        if tok and hmac.compare_digest(hashlib.sha256(tok.encode()).hexdigest(), want):
            return True
        self.send(401, {'error': 'bearer required'})
        return False

    def do_GET(self):
        path, _, qs = self.path.partition('?')
        if path.startswith('/jobs') and not self.authed():
            return
        if path == '/manifest':
            return self.send(200, manifest())
        if path == '/health':
            return self.send(200, {'ok': True, 'busy': STATE['job'] is not None, 'version': VERSION, 'gpu_runs': GPU_ENABLED})
        if path == '/gpu/status':
            return self.send(200, gpu_status())
        if path == '/jobs':
            limit = int(dict(p.split('=', 1) for p in qs.split('&') if '=' in p).get('limit', 50))
            jobs = sorted(JOBS.values(), key=lambda j: -j['created'])[:limit]
            return self.send(200, {'jobs': [public(j) for j in jobs]})
        if path.startswith('/jobs/'):
            j = JOBS.get(path.split('/')[2])
            return self.send(200, public(j)) if j else self.send(404, {'error': 'no such job'})
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        path = self.path.partition('?')[0]
        if not self.authed():
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        except ValueError:
            return self.send(400, {'error': 'body must be JSON'})
        if path == '/run':
            op_id, inputs = body.get('id'), body.get('inputs') or {}
            if op_id not in ENGINES:
                return self.send(400, {'error': f'unknown id {op_id!r}; see GET /manifest'})
            bad = [k for k in inputs if k not in VIEWS] + [k for k, v in inputs.items() if not isinstance(v, str)]
            if bad or not isinstance(inputs.get('front'), str):
                return self.send(400, {'error': 'inputs: front (Library id) required; left/back/right optional'})
            params = body.get('params') or {}
            unknown = [k for k in params if k not in PARAMS['properties']]
            if unknown:
                return self.send(400, {'error': f'unknown params {unknown}; see GET /manifest'})
            jid = uuid.uuid4().hex[:12]
            with LOCK:
                JOBS[jid] = {'jobId': jid, 'id': op_id, 'inputs': inputs, 'params': params, 'origin': body.get('origin'),
                             'state': 'queued', 'phase': 'queued', 'pct': 0, 'created': time.time()}
            QUEUE.put(jid)
            return self.send(202, {'jobId': jid})
        if path.startswith('/jobs/') and path.endswith('/cancel'):
            j = JOBS.get(path.split('/')[2])
            if not j:
                return self.send(404, {'error': 'no such job'})
            j['cancel'] = True
            return self.send(200, {'ok': True})
        self.send(404, {'error': 'not found'})


if __name__ == '__main__':
    WORK.mkdir(parents=True, exist_ok=True)
    SHARE_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=worker, daemon=True).start()
    log(f'mesh-studio {VERSION} on {BIND}:{PORT}; GPU runs {"ENABLED" if GPU_ENABLED else "OFF"}')
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
