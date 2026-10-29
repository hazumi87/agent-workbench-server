"""Geometry difference between two contract GLBs (metres): Chamfer / Hausdorff in cm + a heat-map sheet.

  python geomdiff.py <a.glb> <b.glb> <heat.png> [--samples 200000] [--clip-cm 2]

Prints JSON: chamfer_cm (mean of both directions), hausdorff_cm (max), p95_cm, and the share of A's surface
within 0.5 / 1 / 2 cm of B. The heat sheet shows A from front/back/left/right, coloured by distance to B
(blue 0 -> red >= clip).
"""
import argparse
import json

import numpy as np
import trimesh
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree


def heat(d, clip):
    t = np.clip(d / clip, 0, 1)[:, None]
    return (np.hstack([t, 1 - np.abs(2 * t - 1), 1 - t]) * 255).astype(np.uint8)  # blue -> green -> red


def view(pts, cols, look, up, size):
    look, up = np.asarray(look, float), np.asarray(up, float)
    right = np.cross(look, up)
    x, y, depth = pts @ right, pts @ up, pts @ look
    lo, hi = min(x.min(), y.min()), max(x.max(), y.max())
    px = ((x - lo) / (hi - lo) * (size - 1)).astype(int)
    py = ((hi - y) / (hi - lo) * (size - 1)).astype(int)
    img = np.full((size, size, 3), 255, np.uint8)
    order = np.argsort(-depth)
    for r in (0, 1):
        for c in (0, 1):
            img[np.clip(py[order] + r, 0, size - 1), np.clip(px[order] + c, 0, size - 1)] = cols[order]
    return Image.fromarray(img)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a')
    ap.add_argument('b')
    ap.add_argument('png')
    ap.add_argument('--samples', type=int, default=200000)
    ap.add_argument('--clip-cm', type=float, default=2.0)
    a = ap.parse_args()
    A, B = trimesh.load(a.a, force='mesh'), trimesh.load(a.b, force='mesh')
    pa, _ = trimesh.sample.sample_surface(A, a.samples, seed=1)
    pb, _ = trimesh.sample.sample_surface(B, a.samples, seed=1)
    dab = cKDTree(pb).query(pa)[0] * 100  # cm
    dba = cKDTree(pa).query(pb)[0] * 100
    stats = {'chamfer_cm': round(float((dab.mean() + dba.mean()) / 2), 3),
             'hausdorff_cm': round(float(max(dab.max(), dba.max())), 2),
             'p95_cm': round(float(np.percentile(np.concatenate([dab, dba]), 95)), 3),
             'a_within_cm': {k: round(float((dab <= k).mean()), 4) for k in (0.5, 1.0, 2.0)}}
    cols = heat(dab, a.clip_cm)
    s = 640
    views = [('front', (0, 0, -1)), ('back', (0, 0, 1)), ('left', (-1, 0, 0)), ('right', (1, 0, 0))]
    sheet = Image.new('RGB', (s * 4, s + 30), 'white')
    for i, (name, look) in enumerate(views):
        sheet.paste(view(pa, cols, look, (0, 1, 0), s), (i * s, 30))
        ImageDraw.Draw(sheet).text((i * s + 8, 8), f'A vs B: {name}  (blue 0 -> red >= {a.clip_cm} cm)', fill=(0, 0, 0))
    sheet.save(a.png)
    print(json.dumps(stats))


if __name__ == '__main__':
    main()
