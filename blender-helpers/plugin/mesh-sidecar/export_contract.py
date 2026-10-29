"""Raw Hunyuan GLB -> GLB contract v0 (see the GLB contract in the package docs): metres, +Y up facing +Z, one mesh,
identity node, origin at the centre of the lowest slice (between the feet / centre of a bust's cut), y=0 there.

  python export_contract.py <clean.glb> <out.glb> --height-m 2.4

Hunyuan3D-2mv's native frame is already +Y up facing +Z (checked on run 20260928T204544Z-man-turbo),
so no rotation. Prints a JSON line with the applied transform and mesh stats.
"""
import argparse
import json

import numpy as np
import trimesh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--height-m', type=float, required=True, help='bbox height after scaling (crown to soles / cut)')
    ap.add_argument('--slice', type=float, default=0.02, help='lowest fraction of height used to find the origin')
    a = ap.parse_args()

    mesh = trimesh.load(a.src, force='mesh')
    v = mesh.vertices
    ymin, ymax = v[:, 1].min(), v[:, 1].max()
    scale = a.height_m / (ymax - ymin)
    low = v[v[:, 1] <= ymin + a.slice * (ymax - ymin)]
    cx, cz = (low[:, 0].min() + low[:, 0].max()) / 2, (low[:, 2].min() + low[:, 2].max()) / 2
    mesh.apply_translation([-cx, -ymin, -cz])
    mesh.apply_scale(scale)
    mesh.export(a.out)  # trimesh writes one node, one mesh, no transform

    b = mesh.bounds
    print(json.dumps({'scale': round(float(scale), 6), 'translate_before_scale': [round(float(-cx), 5), round(float(-ymin), 5), round(float(-cz), 5)],
                      'height_m': round(float(b[1][1] - b[0][1]), 4), 'width_m': round(float(b[1][0] - b[0][0]), 4),
                      'depth_m': round(float(b[1][2] - b[0][2]), 4), 'faces': int(len(mesh.faces)),
                      'watertight': bool(mesh.is_watertight), 'components': int(len(mesh.split(only_watertight=False)))}))


if __name__ == '__main__':
    main()
