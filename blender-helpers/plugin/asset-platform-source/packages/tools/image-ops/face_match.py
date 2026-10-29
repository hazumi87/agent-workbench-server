#!/usr/bin/env python3
"""face_match.py '<json request>'  — face identity score: SCRFD face detector + ArcFace embedding (InsightFace buffalo_l), onnxruntime CPU.
   face_match.py --fetch                  — download the buffalo_l models into $IMAGE_OPS_MODEL_DIR/insightface/buffalo_l ahead of time.

Run by image-ops (server.js) in a child process. Request: {"source": "<png>", "candidates": [{"id": "...", "path": "<png>"}],
"face_index": 0, "det_size": 640, "det_thresh": 0.5}. Faces of an image are numbered largest first.
For each candidate the score is the best cosine similarity between the chosen source face and any face in the candidate.
Prints one JSON object. Exit 3 = onnxruntime/numpy/PIL missing (Node -> 503) · exit 4 = models not downloaded and
IMAGE_OPS_MODEL_DOWNLOAD unset (Node -> 503 with the --fetch command).

The weights are InsightFace's pretrained buffalo_l models: NON-COMMERCIAL research use only. The code here does not use the insightface package;
it runs the two ONNX files directly (detector det_10g, recognition w600k_r50), following InsightFace's pre- and post-processing.
"""
import json
import os
import sys
import time
import urllib.request
import zipfile

try:
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
except ImportError as e:
    sys.stderr.write(f'face_match dependencies missing: {e}\n')
    sys.exit(3)

MODEL_DIR = os.path.join(os.getenv('IMAGE_OPS_MODEL_DIR', '<runtime-root>/image-ops-models'), 'insightface', 'buffalo_l')
FILES = {'det': 'det_10g.onnx', 'rec': 'w600k_r50.onnx'}
ZIP_URL = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip'
# ArcFace's 112x112 landmark template (left eye, right eye, nose, left mouth corner, right mouth corner)
TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)
STRIDES = (8, 16, 32)
NMS_IOU = 0.4


def fetch():
    os.makedirs(MODEL_DIR, exist_ok=True)
    tmp = os.path.join(MODEL_DIR, 'buffalo_l.zip.part')
    urllib.request.urlretrieve(ZIP_URL, tmp)
    with zipfile.ZipFile(tmp) as z:
        for f in FILES.values():
            z.extract(f, MODEL_DIR)
    os.remove(tmp)
    print(json.dumps({'models': MODEL_DIR, 'files': list(FILES.values())}), flush=True)


def session(name, threads):
    o = ort.SessionOptions()
    o.intra_op_num_threads = threads
    o.inter_op_num_threads = 1
    o.enable_cpu_mem_arena = False
    o.enable_mem_pattern = False
    return ort.InferenceSession(os.path.join(MODEL_DIR, FILES[name]), sess_options=o, providers=['CPUExecutionProvider'])


def nms(dets):
    x1, y1, x2, y2, s = (dets[:, i] for i in range(5))
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = s.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1, yy1 = np.maximum(x1[i], x1[order[1:]]), np.maximum(y1[i], y1[order[1:]])
        xx2, yy2 = np.minimum(x2[i], x2[order[1:]]), np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1 + 1) * np.maximum(0, yy2 - yy1 + 1)
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou <= NMS_IOU]
    return keep


def detect(sess, img, det_size, thresh):
    """faces of a PIL RGB image: [{box:[x1,y1,x2,y2], det_score, kps:[[x,y]*5]}], largest first, in image pixels"""
    W, H = img.size
    scale = min(det_size / W, det_size / H)
    nw, nh = max(1, round(W * scale)), max(1, round(H * scale))
    canvas = np.zeros((det_size, det_size, 3), dtype=np.uint8)
    canvas[:nh, :nw] = np.asarray(img.resize((nw, nh), Image.Resampling.BILINEAR))
    blob = ((canvas.astype(np.float32) - 127.5) / 128.0).transpose(2, 0, 1)[None]
    out = sess.run(None, {sess.get_inputs()[0].name: blob})
    scores_l, boxes_l, kps_l = out[0:3], out[3:6], out[6:9]
    rows = []
    for idx, stride in enumerate(STRIDES):
        n = det_size // stride
        centers = np.stack(np.mgrid[:n, :n][::-1], axis=-1).astype(np.float32).reshape(-1, 2) * stride
        centers = np.repeat(centers, 2, axis=0)            # 2 anchors per location
        sc = scores_l[idx].reshape(-1)
        keep = np.where(sc >= thresh)[0]
        if not keep.size:
            continue
        b = boxes_l[idx][keep] * stride
        c = centers[keep]
        box = np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], axis=1)
        k = (kps_l[idx][keep] * stride).reshape(-1, 5, 2) + c[:, None, :]
        rows.append(np.concatenate([box, sc[keep, None], k.reshape(-1, 10)], axis=1))
    if not rows:
        return []
    d = np.concatenate(rows)
    d = d[nms(d[:, :5])]
    faces = []
    for r in d:
        faces.append({'box': [round(float(v) / scale, 1) for v in r[:4]], 'det_score': round(float(r[4]), 3),
                      'kps': (r[5:].reshape(5, 2) / scale).tolist()})
    faces.sort(key=lambda f: -(f['box'][2] - f['box'][0]) * (f['box'][3] - f['box'][1]))
    return faces


def umeyama(src, dst):
    """similarity transform (2x3) mapping src points onto dst"""
    sm, dm = src.mean(0), dst.mean(0)
    s, d = src - sm, dst - dm
    u, sig, vt = np.linalg.svd(d.T @ s / len(src))
    e = np.ones(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        e[-1] = -1
    r = u @ np.diag(e) @ vt
    scale = (sig * e).sum() / s.var(0).sum()
    t = dm - scale * r @ sm
    return np.concatenate([scale * r, t[:, None]], axis=1)


def embed(sess, img, kps):
    m = umeyama(np.asarray(kps, dtype=np.float32), TEMPLATE)
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))[:2]       # PIL wants output -> input
    face = img.transform((112, 112), Image.Transform.AFFINE, tuple(inv.reshape(-1)), resample=Image.Resampling.BILINEAR)
    blob = ((np.asarray(face).astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[None]
    v = sess.run(None, {sess.get_inputs()[0].name: blob})[0][0]
    return v / np.linalg.norm(v)


def analyse(det, rec, path, p):
    img = Image.open(path).convert('RGB')
    faces = detect(det, img, p['det_size'], p['det_thresh'])
    for f in faces:
        f['_emb'] = embed(rec, img, f['kps'])
    return img.size, faces


def main():
    if sys.argv[1] == '--fetch':
        return fetch()
    p = json.loads(sys.argv[1])
    p.setdefault('det_size', 640)
    p.setdefault('det_thresh', 0.5)
    missing = [f for f in FILES.values() if not os.path.isfile(os.path.join(MODEL_DIR, f))]
    if missing and not os.getenv('IMAGE_OPS_MODEL_DOWNLOAD'):
        sys.stderr.write(f'buffalo_l models not downloaded: {missing}\n')
        sys.exit(4)
    if missing:
        fetch()
    t0 = time.monotonic()
    threads = int(os.getenv('IMAGE_OPS_ORT_THREADS', '4'))
    det, rec = session('det', threads), session('rec', threads)
    t1 = time.monotonic()
    (sw, sh), sfaces = analyse(det, rec, p['source'], p)
    idx = int(p.get('face_index') or 0)
    src = {'size': [sw, sh], 'faces': len(sfaces)}
    out = {'source': src, 'candidates': []}
    if not sfaces or idx >= len(sfaces):
        src['error'] = 'no face found in the source image' if not sfaces else f'face_index {idx} but the source has {len(sfaces)} face(s)'
    else:
        f = sfaces[idx]
        src.update(face_index=idx, box=f['box'], det_score=f['det_score'])
        for c in p['candidates']:
            (cw, ch), cfaces = analyse(det, rec, c['path'], p)
            r = {'id': c['id'], 'size': [cw, ch], 'faces': len(cfaces)}
            if not cfaces:
                r['score'] = None
                r['note'] = 'no face'
            else:
                sims = [float(f['_emb'] @ g['_emb']) for g in cfaces]
                best = int(np.argmax(sims))
                g = cfaces[best]
                r.update(score=round(sims[best], 4), face_index=best, box=g['box'], det_score=g['det_score'],
                         all_scores=[round(s, 4) for s in sims])
            out['candidates'].append(r)
    out['timing'] = {'load_s': round(t1 - t0, 2), 'total_s': round(time.monotonic() - t0, 2), 'threads': threads}
    print(json.dumps(out))


if __name__ == '__main__':
    main()
