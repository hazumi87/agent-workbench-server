"""CPU preview of a GLB: orthographic, vertex-splat z-buffer, Lambert shading. No GPU, no GL.

  python render.py <mesh.glb> <out.png> [--size 768]

Renders the six axis views (+X -X +Y -Y +Z -Z, labelled by the axis the camera looks ALONG)
in a 3x2 sheet, so axes and facing can be read off before any re-orientation.
"""
import argparse

import numpy as np
import trimesh
from PIL import Image, ImageDraw


def view(verts, normals, look, up, size):
    look, up = np.asarray(look, float), np.asarray(up, float)
    right = np.cross(look, up)
    x, y, depth = verts @ right, verts @ up, verts @ look
    lo, hi = min(x.min(), y.min()), max(x.max(), y.max())
    px = ((x - lo) / (hi - lo) * (size - 1)).astype(int)
    py = ((hi - y) / (hi - lo) * (size - 1)).astype(int)
    shade = np.clip(-(normals @ look), 0, 1) * 0.8 + 0.2
    order = np.argsort(-depth)                    # far first; nearer points overwrite
    img = np.full((size, size), 255, np.uint8)
    for r in (0, 1):                              # 2x2 splat closes pinholes at this density
        for c in (0, 1):
            yy, xx = np.clip(py[order] + r, 0, size - 1), np.clip(px[order] + c, 0, size - 1)
            img[yy, xx] = (shade[order] * 235).astype(np.uint8)
    return Image.fromarray(img)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh')
    ap.add_argument('out')
    ap.add_argument('--size', type=int, default=768)
    a = ap.parse_args()
    mesh = trimesh.load(a.mesh, force='mesh')
    v, n = mesh.vertices, mesh.vertex_normals
    views = [('look +X', (1, 0, 0), (0, 1, 0)), ('look -X', (-1, 0, 0), (0, 1, 0)),
             ('look +Z', (0, 0, 1), (0, 1, 0)), ('look -Z', (0, 0, -1), (0, 1, 0)),
             ('look -Y (top)', (0, -1, 0), (0, 0, -1)), ('look +Y (bottom)', (0, 1, 0), (0, 0, 1))]
    s = a.size
    sheet = Image.new('L', (3 * s, 2 * s), 255)
    for i, (label, look, up) in enumerate(views):
        tile = view(v, n, look, up, s)
        ImageDraw.Draw(tile).text((8, 8), label, fill=0)
        sheet.paste(tile, ((i % 3) * s, (i // 3) * s))
    sheet.save(a.out)


if __name__ == '__main__':
    main()
