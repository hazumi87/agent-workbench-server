#!/usr/bin/env python3
"""vtracer_svg.py <in.png> <out.svg> '<json params>' — raster → SVG with vtracer.

Run by image-ops (server.js) in a child process so tracing never blocks the gateway.
Params are validated on the Node side; this script only maps them onto vtracer.
Exit 3 = vtracer module missing (Node reports 503 'vtracer not installed').
"""
import json
import sys

try:
    import vtracer
except ImportError:
    sys.stderr.write('vtracer module not installed\n')
    sys.exit(3)

KEYS = ('colormode', 'hierarchical', 'mode', 'filter_speckle', 'color_precision',
        'layer_difference', 'corner_threshold', 'length_threshold', 'max_iterations',
        'splice_threshold', 'path_precision')


def main():
    src, dst, raw = sys.argv[1], sys.argv[2], sys.argv[3]
    p = json.loads(raw)
    vtracer.convert_image_to_svg_py(src, dst, **{k: p[k] for k in KEYS if k in p})


if __name__ == '__main__':
    main()
