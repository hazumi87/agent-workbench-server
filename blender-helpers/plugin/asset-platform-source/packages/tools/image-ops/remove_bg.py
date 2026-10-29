#!/usr/bin/env python3
"""remove_bg.py <in.png> <out.png> '<json params>' — background removal with rembg (onnxruntime, CPU).
   remove_bg.py --fetch <model> [<model> ...]    — download models into $U2NET_HOME ahead of time.

Run by image-ops (server.js) in a child process so inference never blocks the gateway.
Params are validated on the Node side; this script only applies them.
Models live under $U2NET_HOME (server.js sets it from IMAGE_OPS_MODEL_DIR) as models/<name>/<name>.onnx.
Exit 3 = rembg/onnxruntime missing (Node → 503) · exit 4 = model not downloaded and
IMAGE_OPS_MODEL_DOWNLOAD unset (Node → 503 with the --fetch command) — a first call must never
silently turn into a ~1 GB download inside a request.
Prints one JSON line of stats to stdout.
"""
import json
import os
import sys
import time

try:
    import onnxruntime as ort
    from PIL import Image, ImageChops, ImageFilter
    from rembg import new_session, remove
    from rembg.bg import alpha_matting_cutout
    from rembg.sessions import sessions_class
except ImportError as e:
    sys.stderr.write(f'rembg not installed: {e}\n')
    sys.exit(3)


def session_class(name):
    return next(c for c in sessions_class if c.name() == name)


def downloaded(name):
    return session_class(name).resolve_existing(f'{name}.onnx') is not None


def main():
    if sys.argv[1] == '--fetch':
        for name in sys.argv[2:]:
            print(name, session_class(name).download_models(), flush=True)
        return
    src, dst, p = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    model = p['model']
    if not downloaded(model) and not os.getenv('IMAGE_OPS_MODEL_DOWNLOAD'):
        sys.stderr.write(f'model {model} not downloaded\n')
        sys.exit(4)

    t0 = time.monotonic()
    opts = ort.SessionOptions()
    threads = int(os.getenv('IMAGE_OPS_ORT_THREADS', '4'))   # leave the rest of the server to the gateway
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    opts.enable_cpu_mem_arena = False    # measured: peak RSS 7.6 → 6.7 GB (lite), 9.3 → 7.9 GB (general)
    opts.enable_mem_pattern = False
    session = new_session(model, sess_opts=opts, providers=['CPUExecutionProvider'])
    t1 = time.monotonic()

    rgba = Image.open(src).convert('RGBA')
    W, H = rgba.size
    # Infer on the image flattened on white (transparent pixels carry arbitrary RGB), capped in size;
    # the mask is scaled back up to the original afterwards.
    flat = Image.alpha_composite(Image.new('RGBA', (W, H), (255, 255, 255, 255)), rgba).convert('RGB')
    s = p['max_side'] / max(W, H)
    small = flat.resize((max(1, round(W * s)), max(1, round(H * s))), Image.Resampling.LANCZOS) if s < 1 else flat
    mask = remove(small, session=session, only_mask=True, post_process_mask=p['post_process_mask'])
    t2 = time.monotonic()
    matted = False
    if p['alpha_matting']:
        try:
            mask = alpha_matting_cutout(small, mask, p['alpha_matting_foreground_threshold'],
                                        p['alpha_matting_background_threshold'],
                                        p['alpha_matting_erode_size']).getchannel('A')
            matted = True
        except ValueError:
            pass   # rembg's own fallback: keep the model mask
    if mask.size != (W, H):
        mask = mask.resize((W, H), Image.Resampling.BILINEAR)
    if p['feather'] > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(p['feather']))
    mask = ImageChops.multiply(mask, rgba.getchannel('A'))   # never make a transparent pixel opaque

    if p['output'] == 'mask':
        out = mask
    else:
        out = rgba.copy()
        out.putalpha(mask)
        if p['output'] == 'white':
            out = Image.alpha_composite(Image.new('RGBA', (W, H), (255, 255, 255, 255)), out).convert('RGB')
    out.save(dst, 'PNG')
    print(json.dumps({'inference_size': list(small.size), 'threads': threads, 'alpha_matted': matted,
                      'load_s': round(t1 - t0, 2), 'infer_s': round(t2 - t1, 2),
                      'total_s': round(time.monotonic() - t0, 2)}))


if __name__ == '__main__':
    main()
