"""helpers for the dev tie tools: read a GLB's TEXCOORD_1 triangles and the loader rule-B coverage count per texel (row 0 = glTF v 0)."""
import json
import struct

import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    raw = open(path, "rb").read()
    js = bin_ = None
    off = 12
    while off < len(raw):
        ln, ty = struct.unpack_from("<II", raw, off)
        body = raw[off + 8: off + 8 + ln]
        if ty == 0x4E4F534A:
            js = json.loads(body)
        elif ty == 0x004E4942:
            bin_ = body
        off += 8 + ln
    return js, bin_


def accessor(js, bin_, i):
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    n = NC[a["type"]]
    dt = np.dtype(CT[a["componentType"]])
    stride = bv.get("byteStride") or n * dt.itemsize
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    if stride == n * dt.itemsize:
        arr = np.frombuffer(bin_, dtype=dt, count=a["count"] * n, offset=base).reshape(a["count"], n)
    else:
        arr = np.stack([np.frombuffer(bin_, dtype=dt, count=n, offset=base + k * stride) for k in range(a["count"])])
    return arr.astype(np.float64) if dt.kind == "f" else arr.astype(np.int64)


def glb_cover_b(path, W, H):
    js, bin_ = read_glb(path)
    uvs = []
    for node in js.get("nodes", []):
        if "mesh" not in node:
            continue
        for prim in js["meshes"][node["mesh"]]["primitives"]:
            if "TEXCOORD_1" not in prim["attributes"]:
                continue
            U = accessor(js, bin_, prim["attributes"]["TEXCOORD_1"])
            I = (accessor(js, bin_, prim["indices"]).reshape(-1) if "indices" in prim else np.arange(len(U))).reshape(-1, 3)
            uvs.append(U[I] * np.array([W, H]))
    UV = np.concatenate(uvs)
    cov = np.zeros((H, W), np.int16)
    for a, b, c in UV:
        area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(area) < 1e-12:
            continue
        if area < 0:
            b, c = c, b
        x0, x1 = int(max(0, np.floor(min(a[0], b[0], c[0]) - 0.5))), int(min(W - 1, np.ceil(max(a[0], b[0], c[0]) + 0.5)))
        y0, y1 = int(max(0, np.floor(min(a[1], b[1], c[1]) - 0.5))), int(min(H - 1, np.ceil(max(a[1], b[1], c[1]) + 0.5)))
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        e0 = (b[0] - a[0]) * (ys - a[1]) - (b[1] - a[1]) * (xs - a[0])
        e1 = (c[0] - b[0]) * (ys - b[1]) - (c[1] - b[1]) * (xs - b[0])
        e2 = (a[0] - c[0]) * (ys - c[1]) - (a[1] - c[1]) * (xs - c[0])
        ok = np.ones(e0.shape, bool)
        for dx_, dy_, e_ in ((b[0] - a[0], b[1] - a[1], e0), (c[0] - b[0], c[1] - b[1], e1), (a[0] - c[0], a[1] - c[1], e2)):
            ok &= (e_ > 0) | ((e_ == 0) & (dy_ > 0 or (dy_ == 0 and dx_ < 0)))
        if ok.any():
            jy, jx = np.nonzero(ok)
            cov[jy + y0, jx + x0] += 1
    return cov
