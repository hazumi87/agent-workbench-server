"""dev_tieattr — DEV TOOL (read-only, saves nothing): attribute the texels where a baker mask and an exact-GLB raster (loader rule B) disagree. params: glb, mask (absolute paths), width, height (1024), near_texel (0.001: a centre this close to a triangle edge, in texel units, counts as `near_tie`).
For every texel the GLB raster under rule B covers that mask 0 / 2 does not (`covered_not_label1`), or that mask 1 marks and the raster does not cover (`label1_uncovered`): the closest triangle edge (distance in texels, signed: positive = inside), the owning node, the number of triangles within 1e-3 texel of the centre, and a class: exact_tie (distance exactly 0), near_tie (< near_texel but not 0), other. Also the same distance histogram for ALL rule-B tie centres, so the ties the GLB sees can be compared."""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402

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


def main():
    W, H = int(L.param("width", 1024)), int(L.param("height", 1024))
    near = float(L.param("near_texel", 0.001))
    mask = np.fromfile(L.param("mask"), np.uint8).reshape(H, W)
    js, bin_ = read_glb(L.param("glb"))
    names, UVs = [], []
    for node in js.get("nodes", []):
        if "mesh" not in node:
            continue
        for pi, prim in enumerate(js["meshes"][node["mesh"]]["primitives"]):
            if "TEXCOORD_1" not in prim["attributes"]:
                continue
            U = accessor(js, bin_, prim["attributes"]["TEXCOORD_1"])
            I = (accessor(js, bin_, prim["indices"]).reshape(-1) if "indices" in prim else np.arange(len(U))).reshape(-1, 3)
            UVs.append(U[I] * np.array([W, H]))
            names.append((node.get("name"), pi, len(I)))
    UV = np.concatenate(UVs)  # (N, 3, 2)
    owner_prim = np.concatenate([np.full(n, k) for k, (_, _, n) in enumerate(names)])
    N = len(UV)
    covB = np.zeros((H, W), np.int16)
    for t in range(N):
        a, b, c = UV[t]
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
            covB[jy + y0, jx + x0] += 1
    cov = covB > 0
    sets = {"covered_not_label1": cov & (mask != 1), "label1_uncovered": (mask == 1) & ~cov}
    mn, mxx = UV.min(axis=1), UV.max(axis=1)
    out = {"rule": "B (owns an exact-edge centre if dy > 0, or dy == 0 and dx < 0)", "triangles": int(N), "covered_B": int(cov.sum()), "mask1": int((mask == 1).sum())}

    def edge_dists(tx, ty):
        p = np.array([tx + 0.5, ty + 0.5])
        cand = np.nonzero((mn[:, 0] <= p[0] + 0.01) & (mxx[:, 0] >= p[0] - 0.01) & (mn[:, 1] <= p[1] + 0.01) & (mxx[:, 1] >= p[1] - 0.01))[0]
        best = None
        rows = []
        for t in cand:
            a, b, c = UV[t]
            area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if abs(area) < 1e-12:
                continue
            if area < 0:
                b, c = c, b
            ds = []
            for (u, v) in ((a, b), (b, c), (c, a)):
                ln = np.hypot(v[0] - u[0], v[1] - u[1])
                ds.append(((v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0])) / max(ln, 1e-12))
            inside_ish = min(ds)  # >= 0: inside (or on an edge); the nearest edge when the centre is just outside is the most negative
            rows.append((abs(min(ds, key=abs)), int(t), [float(d) for d in ds], float(inside_ish), float(area)))
        rows.sort(key=lambda r: r[0])
        return rows

    for key, m in sets.items():
        ys_, xs_ = np.nonzero(m)
        res, cls = [], {"exact_tie": 0, "near_tie": 0, "other": 0}
        by_node = {}
        for y, x in zip(ys_, xs_):
            rows = edge_dists(int(x), int(y))
            d = rows[0][0] if rows else None
            exact = any(r[0] == 0.0 for r in rows)
            c_ = "exact_tie" if exact else ("near_tie" if (d is not None and d < near) else "other")
            cls[c_] += 1
            nm = names[int(owner_prim[rows[0][1]])][0] if rows else None
            by_node[nm] = by_node.get(nm, 0) + 1
            if len(res) < 40:
                res.append({"texel": [int(x), int(y)], "mask": int(mask[y, x]), "owners_B": int(covB[y, x]), "class": c_, "nearest_edge_texels": d, "triangles_within_0.01_texel": len(rows), "node": nm,
                            "edge_distances_of_nearest": rows[0][2] if rows else None, "triangle_area_texels2": (rows[0][4] / 2) if rows else None})
        out[key] = {"count": int(m.sum()), "classes": cls, "by_node": by_node, "examples": res}
    # the ties the GLB itself sees, by edge distance to a float32 grid: how many centres lie within `near` of an edge but not exactly on it
    L.finish(out, save=False)


L.run(main)
