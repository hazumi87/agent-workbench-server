"""Mesh Studio one-off measurement run (stage b, before the sidecar exists).

Four views -> one engine (hunyuan | triposr | trellis, each in its own venv) -> raw/clean GLB + report.json.
Measures what the GPU doc needs: cold load time, per-stage time, peak dedicated + shared VRAM (WDDM counters,
sampled all run) and torch's own peak. --cuts reuses earlier cut-outs so engines see identical inputs.

Owns its lifecycle (briefing-table review, room line 726): a hard timeout, a log, a pid file
(stop.ps1 kills only this pid's tree), results in report.json - never read from exec stdout.

  <venv>/bin/python run_once.py --engine trellis --char <name> --cuts <run-dir>/ --out <out-dir>
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(os.environ.get('MESH_ROOT', str(Path.home() / 'mesh-workspace')))
os.environ.setdefault('HY3DGEN_MODELS', str(ROOT / 'models'))
os.environ.setdefault('U2NET_HOME', str(ROOT / 'models' / 'u2net'))  # rembg weights
os.environ.setdefault('HF_HOME', str(ROOT / 'models' / 'hf'))

VIEWS = ('front', 'left', 'back', 'right')  # Hunyuan view2idx; 'left' = character faces image-left (same as ours)


def gpu_mb():
    out = subprocess.run(['nvidia-smi', '--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
                         capture_output=True, text=True, timeout=10).stdout.strip().split(',')
    return int(out[0]), int(out[1])


# WDDM per-adapter counters: dedicated AND shared (spill into system RAM). One persistent PowerShell
# prints a block per ~1 s sample; the adapter with the most dedicated usage is the 4080.
PS_SAMPLER = ("while($true){ (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage','\\GPU Adapter Memory(*)\\Shared Usage')"
              ".CounterSamples | % { $_.InstanceName + '|' + $_.Path.Split('\\')[-1] + '|' + [int64]$_.CookedValue }; 'END' }")


class Sampler(threading.Thread):
    """Peak dedicated/shared MB per stage; trips `spilled` when shared rises > spill_mb over its baseline."""
    def __init__(self, spill_mb):
        super().__init__(daemon=True)
        self.stage, self.peaks, self.spill_mb = 'idle', {}, spill_mb
        self.base_shared = None
        self.spilled = threading.Event()
        self.proc = subprocess.Popen(['powershell', '-NoProfile', '-Command', PS_SAMPLER],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors='replace')

    def run(self):
        block = {}
        for line in self.proc.stdout:
            line = line.strip()
            if line != 'END':
                parts = line.split('|')
                if len(parts) == 3:
                    kind = 'ded' if 'dedicated' in parts[1].lower() else 'shr'
                    block.setdefault(parts[0], {})[kind] = int(parts[2]) // 2**20
                continue
            if block:
                gpu = max(block.values(), key=lambda v: v.get('ded', 0))
                ded, shr = gpu.get('ded', 0), gpu.get('shr', 0)
                if self.base_shared is None:
                    self.base_shared = shr
                pk = self.peaks.setdefault(self.stage, {'dedicated_mb': 0, 'shared_mb': 0})
                pk['dedicated_mb'], pk['shared_mb'] = max(pk['dedicated_mb'], ded), max(pk['shared_mb'], shr)
                if shr - self.base_shared > self.spill_mb:
                    self.spilled.set()
            block = {}

    def close(self):
        self.proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--char', required=True)
    ap.add_argument('--views', help='folder holding <char>_<view>.png (front required)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--engine', default='hunyuan', choices=['hunyuan', 'triposr', 'trellis'])
    ap.add_argument('--cuts', help='folder with cut_<view>.png (RGBA) from an earlier run: skips background removal')
    ap.add_argument('--rembg-model', default='birefnet-general', help='rembg session (birefnet-general = MIT)')
    ap.add_argument('--trellis-mode', default='stochastic', choices=['stochastic', 'multidiffusion'])
    ap.add_argument('--subfolder', default='hunyuan3d-dit-v2-mv')
    ap.add_argument('--steps', type=int, default=50)
    ap.add_argument('--octree', type=int, default=380)
    ap.add_argument('--chunks', type=int, default=20000)
    ap.add_argument('--seed', type=int, default=12345)
    ap.add_argument('--min-free-mb', type=int, default=7000, help='load guard: refuse below this free VRAM')
    ap.add_argument('--timeout-s', type=int, default=1800)
    ap.add_argument('--spill-mb', type=int, default=500, help='abort if shared GPU memory rises this much over baseline')
    ap.add_argument('--flashvdm', action='store_true', help='turbo VAE + FlashVDM decoding (the turbo recipe)')
    ap.add_argument('--fixed-frame', action='store_true', help='Hunyuan only, needs --cuts: the views are ALREADY framed to one square; no per-view crop/recentre/rescale (fixed_frame.py). Writes fed_*.png + framing.json next to the result')
    ap.add_argument('--frame-meta', help='JSON merged into framing.json (source id, crop box, anchors, residuals)')
    ap.add_argument('--frame-pad', action='store_true', help='with --fixed-frame: centre-pad views to the largest square instead of refusing (never scales)')
    a = ap.parse_args()

    tag = a.subfolder.split('-')[-1] if a.engine == 'hunyuan' else a.engine
    run_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + f'-{a.char}-{tag}'
    out = Path(a.out) / run_id
    out.mkdir(parents=True, exist_ok=True)
    pidfile = ROOT / 'logs' / 'run_once.pid'
    pidfile.write_text(str(os.getpid()))
    report = {'run_id': run_id, 'char': a.char, 'engine': a.engine, 'model': MODEL_LABEL[a.engine](a), 'cuts': a.cuts,
              'params': {'flashvdm': a.flashvdm, 'steps': a.steps, 'octree_resolution': a.octree, 'num_chunks': a.chunks, 'seed': a.seed, 'fixed_frame': bool(getattr(a, 'fixed_frame', False))},
              'status': 'running', 'times_s': {}}

    def save():
        (out / 'report.json').write_text(json.dumps(report, indent=2))

    def watchdog():
        time.sleep(a.timeout_s)
        report['status'] = f'timeout after {a.timeout_s}s'
        save()
        os._exit(3)
    threading.Thread(target=watchdog, daemon=True).start()

    sampler = Sampler(a.spill_mb)
    sampler.start()

    def spill_guard():
        sampler.spilled.wait()
        report['status'] = f'aborted: shared GPU memory rose > {a.spill_mb} MB over baseline (spill) in stage {sampler.stage}'
        report['gpu_peaks_by_stage'] = sampler.peaks
        report['shared_baseline_mb'] = sampler.base_shared
        save()
        sampler.close()
        os._exit(4)
    threading.Thread(target=spill_guard, daemon=True).start()
    time.sleep(3)  # let the sampler take a baseline before anything touches the GPU
    try:
        used, total = gpu_mb()
        report['gpu_before'] = {'used_mb': used, 'total_mb': total, 'free_mb': total - used}
        if total - used < a.min_free_mb:
            report['status'] = f'refused: {total - used} MB free < floor {a.min_free_mb}'
            return

        from PIL import Image
        import torch

        sampler.stage = 'rembg'
        t = time.time()
        images = {}
        src = Path(a.cuts) if a.cuts else Path(a.views)
        name = (lambda v: f'cut_{v}.png') if a.cuts else (lambda v: f'{a.char}_{v}.png')
        present = [v for v in VIEWS if (src / name(v)).exists()]  # front required; left/back/right optional
        if 'front' not in present:
            raise FileNotFoundError(f'no front view in {src}')
        if a.cuts:  # reuse earlier cut-outs so engines are compared on identical inputs
            for v in present:
                images[v] = Image.open(src / name(v)).convert('RGBA')
        else:
            from rembg import new_session, remove
            session = new_session(a.rembg_model)
            for v in present:
                images[v] = remove(Image.open(src / name(v)).convert('RGB'), session=session)
        report['views'] = present
        if getattr(a, 'fixed_frame', False):
            if a.engine != 'hunyuan' or not a.cuts:
                raise ValueError('--fixed-frame needs --engine hunyuan and --cuts')
            import fixed_frame
            images, frame_px, pads = fixed_frame.check_frames(images, pad=a.frame_pad)
            meta = json.loads(Path(a.frame_meta).read_text()) if a.frame_meta else {}
            meta.update({'char': a.char, 'run_id': run_id, 'model': MODEL_LABEL[a.engine](a), 'seed': a.seed, 'steps': a.steps, 'octree': a.octree, 'chunks': a.chunks})
            report['framing'] = {k: v for k, v in fixed_frame.write_debug(out, images, {v: str(src / name(v)) for v in present}, frame_px, pads, 512, meta, tag='fed').items() if k != 'views'}
            report['framing']['frame_px'] = frame_px
        for v, im in images.items():
            im.save(out / f'cut_{v}.png')
        report['times_s']['rembg'] = round(time.time() - t, 1)

        engine = ENGINES[a.engine]
        sampler.stage = 'load'
        t = time.time()
        model = engine['load'](a)
        if getattr(a, 'fixed_frame', False):
            import fixed_frame
            model.image_processor = fixed_frame.FixedFrameMVProcessor(512, pad=a.frame_pad, debug_dir=str(out / 'fed_runtime'), meta={'char': a.char})
        report['times_s']['load_cold'] = round(time.time() - t, 1)
        report['vram_after_load_mb'] = gpu_mb()[0]

        sampler.stage = 'generate'
        t = time.time()
        mesh = engine['generate'](model, images, a)
        report['times_s']['generate'] = round(time.time() - t, 1)
        if getattr(a, 'fixed_frame', False):   # the images the model actually received must equal the ones written before the run
            pre = json.loads((out / 'framing.json').read_text())['views']; rt = json.loads((out / 'fed_runtime' / 'framing.json').read_text())['views']
            report['framing']['runtime_conditioning_matches_prerun'] = all(pre[v]['conditioning_rgb_sha256'] == rt[v]['conditioning_rgb_sha256'] for v in pre) and set(pre) == set(rt)
        report['torch_peak_reserved_mb'] = round(torch.cuda.max_memory_reserved() / 2**20)

        sampler.stage = 'post'
        mesh.export(out / 'raw.glb')
        report['raw'] = stats(mesh)
        parts = mesh.split(only_watertight=False)
        mesh = max(parts, key=lambda m: len(m.faces)) if len(parts) > 1 else mesh  # drop floaters
        mesh.export(out / 'clean.glb')
        report['clean'] = stats(mesh)
        report['status'] = 'ok'
    except Exception as e:
        report['status'] = f'error: {type(e).__name__}: {e}'
    finally:
        report['gpu_peaks_by_stage'] = sampler.peaks
        report['shared_baseline_mb'] = sampler.base_shared
        sampler.close()
        save()
        pidfile.unlink(missing_ok=True)


def stats(mesh):
    b = mesh.bounds.tolist()
    return {'faces': int(len(mesh.faces)), 'vertices': int(len(mesh.vertices)),
            'watertight': bool(mesh.is_watertight), 'components': int(len(mesh.split(only_watertight=False))),
            'bounds_min': [round(x, 4) for x in b[0]], 'bounds_max': [round(x, 4) for x in b[1]]}


# --- engines: load(args) -> model, generate(model, {view: RGBA image}, args) -> trimesh.Trimesh (+Y up, facing +Z)
TRIPOSR = ROOT / 'triposr'
TRELLIS = ROOT / 'trellis'


def hunyuan_load(a):
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained('tencent/Hunyuan3D-2mv', subfolder=a.subfolder,
                                                            variant='fp16', use_safetensors=True)
    if a.flashvdm:
        pipe.enable_flashvdm()
    return pipe


def hunyuan_generate(pipe, images, a):
    import torch
    return pipe(image=images, num_inference_steps=a.steps, octree_resolution=a.octree, num_chunks=a.chunks,
                generator=torch.manual_seed(a.seed), output_type='trimesh')[0]


def triposr_load(a):
    sys.path.insert(0, str(TRIPOSR / 'src'))
    from tsr.system import TSR
    model = TSR.from_pretrained(str(TRIPOSR / 'models' / 'TripoSR'), config_name='config.yaml', weight_name='model.ckpt')
    model.renderer.set_chunk_size(8192)
    return model.to('cuda')


def triposr_generate(model, images, a):  # single image: the front view only (as TripoSR's run.py prepares it)
    import numpy as np
    import torch
    from PIL import Image
    from tsr.utils import resize_foreground
    im = np.asarray(resize_foreground(images['front'], 0.85)).astype(np.float32) / 255.0
    im = im[:, :, :3] * im[:, :, 3:4] + (1 - im[:, :, 3:4]) * 0.5
    torch.manual_seed(a.seed)
    with torch.no_grad():
        codes = model([Image.fromarray((im * 255).astype(np.uint8))], device='cuda')
    return model.extract_mesh(codes, False, resolution=256)[0]


def trellis_load(a):
    os.environ.setdefault('ATTN_BACKEND', 'xformers')
    os.environ.setdefault('SPCONV_ALGO', 'native')
    os.environ['TORCH_HOME'] = str(TRELLIS / 'models' / 'torch')
    sys.path.insert(0, str(TRELLIS / 'src'))
    from trellis.pipelines import TrellisImageTo3DPipeline
    pipe = TrellisImageTo3DPipeline.from_pretrained(str(TRELLIS / 'models' / 'TRELLIS-image-large'))
    pipe.cuda()
    return pipe


def trellis_generate(pipe, images, a):  # shape only: formats=['mesh'] (FlexiCubes); no nvdiffrast to_glb
    import numpy as np
    import trimesh
    out = pipe.run_multi_image([images[v] for v in VIEWS if v in images], seed=a.seed, formats=['mesh'], mode=a.trellis_mode)
    m = out['mesh'][0]
    v = m.vertices.detach().cpu().numpy() @ np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]])  # Z-up -> Y-up, as to_glb does
    return trimesh.Trimesh(v, m.faces.detach().cpu().numpy(), process=False)


ENGINES = {'hunyuan': {'load': hunyuan_load, 'generate': hunyuan_generate},
           'triposr': {'load': triposr_load, 'generate': triposr_generate},
           'trellis': {'load': trellis_load, 'generate': trellis_generate}}
MODEL_LABEL = {'hunyuan': lambda a: f'tencent/Hunyuan3D-2mv:{a.subfolder}',
               'triposr': lambda a: 'stabilityai/TripoSR (single image: front)',
               'trellis': lambda a: f'microsoft/TRELLIS-image-large (multi-image {a.trellis_mode}, shape only)'}


if __name__ == '__main__':
    main()
    sys.exit(0)
