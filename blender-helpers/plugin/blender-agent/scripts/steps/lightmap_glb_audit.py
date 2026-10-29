"""lightmap_glb_audit — READ-ONLY reproduction of a loader-style validation of a lightmap set from the EXACT published GLB, the mask and the bin: rasterise every exported TEXCOORD_1 triangle at texel centres, then say who owns each texel and how that agrees with the baker's mask. Saves nothing, changes nothing. Run it as the first/any step of a job holding the bake checkpoint if `compare_blender` is wanted (job_copy of the export checkpoint), or on any job otherwise.
params:
  glb        path of the exported GLB   [required]
  mask       path of the .mask.u8 (row 0 = glTF v 0; labels 0 not receiver / 1 receiver / 2 padding)   [required]
  width, height   atlas size (default 1024)
  compare_blender  true (default if the objects of the GLB nodes exist in this scene): also rasterise the baker's own LightmapUV with lightmap_bake.raster and compare per receiver
  loader_coverage  optional path of a loader coverage byte array (row 0 = glTF v 0, >0 = covered): the number of texels that differ from each rule is reported
  tol_m      coincidence distance for multiply-owned texels (default 0.0001), facing: normal dot >= 0.99
Rule: a triangle owns a texel when the texel CENTRE (i + 0.5, j + 0.5) in texel units (x = u * width, y = v * height, as exported, row 0 = v 0) lies strictly inside it; centres exactly on an edge are counted separately (`edge_ties`) and reported both ways (inclusive / exclusive), because a top-left tie rule only decides those.
Returns: covered texels (>= 1 owner) and by mask label (covered&label1, covered&label2 = padding, covered&label0), label-1 texels with no owner, owners per texel histogram, MULTIPLY-OWNED texels classified by the world position and normal of each owner at that texel: same_surface_coincident_same_facing, coincident_opposite_facing, different_surfaces (a real UV overlap), with counts by primitive material and node; label-1 texels with no owner and covered-by-Blender-but-not-by-GLB attributed per receiver (when compare_blender); the first examples of each class with texel, nodes, positions, distances.
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
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
    gp = L.resolve(L.param("glb"), what="glb")
    mp = L.resolve(L.param("mask"), what="mask")
    W = int(L.param("width", 1024))
    H = int(L.param("height", 1024))
    tol = float(L.param("tol_m", 0.0001))
    mask = np.fromfile(mp, dtype=np.uint8).reshape(H, W)
    js, bin_ = read_glb(gp)
    parent = {}
    for ni, n in enumerate(js.get("nodes", [])):
        for c in n.get("children", []):
            parent[c] = ni

    def local(n):
        if "matrix" in n:
            return np.array(n["matrix"], np.float64).reshape(4, 4).T
        t = n.get("translation", [0, 0, 0])
        x, y, z, w = n.get("rotation", [0, 0, 0, 1])
        sc = n.get("scale", [1, 1, 1])
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        M = np.eye(4)
        M[:3, :3] = R @ np.diag(sc)
        M[:3, 3] = t
        return M

    def world(ni):
        M = local(js["nodes"][ni])
        while ni in parent:
            ni = parent[ni]
            M = local(js["nodes"][ni]) @ M
        return M
    prims = []  # (node name, prim index, material name, world positions per triangle (n,3,3), uv per triangle (n,3,2))
    for ni, node in enumerate(js.get("nodes", [])):
        if "mesh" not in node:
            continue
        Wm = world(ni)
        for pi, prim in enumerate(js["meshes"][node["mesh"]]["primitives"]):
            if "TEXCOORD_1" not in prim["attributes"]:
                continue
            P = (Wm[:3, :3] @ accessor(js, bin_, prim["attributes"]["POSITION"]).T).T + Wm[:3, 3]
            U = accessor(js, bin_, prim["attributes"]["TEXCOORD_1"])
            I = (accessor(js, bin_, prim["indices"]).reshape(-1) if "indices" in prim else np.arange(len(P))).reshape(-1, 3)
            mat = js["materials"][prim["material"]].get("name") if "material" in prim else None
            prims.append((node.get("name"), pi, mat, P[I], U[I]))
    OWN = 3
    cnt = np.zeros((H, W), np.int16)
    own = np.full((OWN, H, W), -1, np.int64)  # encoded (primitive index, triangle index)
    tie_in = np.zeros((H, W), np.int16)
    covA = np.zeros((H, W), np.int16)
    covB = np.zeros((H, W), np.int16)
    ties = 0
    for k, (nm, pi, mat, P, U) in enumerate(prims):
        UV = U * np.array([W, H])
        for t in range(len(UV)):
            a, b, c = UV[t]
            area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if abs(area) < 1e-12:
                continue
            if area < 0:
                b, c = c, b
                area = -area
            x0, x1 = int(max(0, np.floor(min(a[0], b[0], c[0]) - 0.5))), int(min(W - 1, np.ceil(max(a[0], b[0], c[0]) + 0.5)))
            y0, y1 = int(max(0, np.floor(min(a[1], b[1], c[1]) - 0.5))), int(min(H - 1, np.ceil(max(a[1], b[1], c[1]) + 0.5)))
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            e0 = (b[0] - a[0]) * (ys - a[1]) - (b[1] - a[1]) * (xs - a[0])
            e1 = (c[0] - b[0]) * (ys - b[1]) - (c[1] - b[1]) * (xs - b[0])
            e2 = (a[0] - c[0]) * (ys - c[1]) - (a[1] - c[1]) * (xs - c[0])
            strict = (e0 > 0) & (e1 > 0) & (e2 > 0)
            incl = (e0 >= 0) & (e1 >= 0) & (e2 >= 0)
            tie = incl & ~strict
            edges_ = ((b[0] - a[0], b[1] - a[1], e0), (c[0] - b[0], c[1] - b[1], e1), (a[0] - c[0], a[1] - c[1], e2))
            for var, covv in (("A", covA), ("B", covB)):  # the two top-left conventions (they differ in which side of a shared edge keeps a centre that lies exactly on it)
                ok = np.ones(e0.shape, bool)
                for dx_, dy_, e_ in edges_:
                    acc = (dy_ < 0 or (dy_ == 0 and dx_ > 0)) if var == "A" else (dy_ > 0 or (dy_ == 0 and dx_ < 0))
                    ok &= (e_ > 0) | ((e_ == 0) & acc)
                if ok.any():
                    jy, jx = np.nonzero(ok)
                    covv[jy + y0, jx + x0] += 1
            if tie.any():
                iy, ix = np.nonzero(tie)
                tie_in[iy + y0, ix + x0] += 1
                ties += int(tie.sum())
            if not strict.any():
                continue
            iy, ix = np.nonzero(strict)
            gy, gx = iy + y0, ix + x0
            for s_ in range(len(gy)):
                n_ = cnt[gy[s_], gx[s_]]
                if n_ < OWN:
                    own[n_, gy[s_], gx[s_]] = k * 10_000_000 + t
                cnt[gy[s_], gx[s_]] = n_ + 1
    covered = cnt > 0
    m1, m2, m0 = mask == 1, mask == 2, mask == 0
    hist = {str(i): int((cnt == i).sum()) for i in range(0, 5)}
    hist["5+"] = int((cnt >= 5).sum())
    # --- multiply-owned texels: same place? same facing?
    multi = np.argwhere(cnt > 1)
    classes = {"same_surface_coincident_same_facing": 0, "coincident_opposite_facing": 0, "different_surfaces_uv_overlap": 0}
    by_mat, by_node, examples, ident = {}, {}, {}, {}
    for (y, x) in multi:
        pts, nrms, who = [], [], []
        for q in range(min(int(cnt[y, x]), OWN)):
            code = own[q, y, x]
            k, t = int(code // 10_000_000), int(code % 10_000_000)
            nm, pi, mat, P, U = prims[k]
            a, b, c = U[t] * np.array([W, H])
            p = np.array([x + 0.5, y + 0.5])
            den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            w0 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / den
            w1 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / den
            pos = w0 * P[t][0] + w1 * P[t][1] + (1 - w0 - w1) * P[t][2]
            n = np.cross(P[t][1] - P[t][0], P[t][2] - P[t][0])
            n = n / max(np.linalg.norm(n), 1e-18)
            pts.append(pos)
            nrms.append(n)
            who.append((nm, pi, mat, t))
        dmax = max(np.linalg.norm(pts[i] - pts[j]) for i in range(len(pts)) for j in range(i + 1, len(pts)))
        dots = [float(nrms[i] @ nrms[j]) for i in range(len(pts)) for j in range(i + 1, len(pts))]
        if dmax <= tol and min(dots) >= 0.99:
            cl = "same_surface_coincident_same_facing"
        elif dmax <= tol and max(dots) <= -0.99:
            cl = "coincident_opposite_facing"
        else:
            cl = "different_surfaces_uv_overlap"
        classes[cl] += 1
        # are the coincident owners the SAME triangle (identical three world vertices, any order, within 1 micrometre) or different triangles on the same surface (a different triangulation / partial overlap)?
        trs = []
        for w_ in who:
            kk = [i for i, pp in enumerate(prims) if pp[0] == w_[0] and pp[1] == w_[1]][0]
            trs.append(prims[kk][3][w_[3]])
        same_tri = all(sorted(map(tuple, np.round(trs[0] * 1e6).astype(np.int64))) == sorted(map(tuple, np.round(t_ * 1e6).astype(np.int64))) for t_ in trs[1:])
        ident["identical_triangles" if same_tri else "different_triangles_same_surface"] = ident.get("identical_triangles" if same_tri else "different_triangles_same_surface", 0) + 1
        same_prim = len({(w_[0], w_[1]) for w_ in who}) == 1
        ident["owners_in_one_primitive" if same_prim else "owners_in_different_primitives"] = ident.get("owners_in_one_primitive" if same_prim else "owners_in_different_primitives", 0) + 1
        for w_ in who:
            by_mat[w_[2]] = by_mat.get(w_[2], 0) + 1
            by_node[w_[0]] = by_node.get(w_[0], 0) + 1
        if len(examples.setdefault(cl, [])) < 4:
            examples[cl].append({"texel": [int(x), int(y)], "owners": int(cnt[y, x]), "max_distance_m": round(float(dmax), 7), "normal_dots": [round(d, 4) for d in dots], "nodes": [(w_[0], w_[2], w_[3]) for w_ in who]})
    # --- compare with the baker's own raster on the Blender objects
    cmp_ = None
    names = {p[0] for p in prims}
    objs = [bpy.data.objects[n] for n in sorted(names) if n in bpy.data.objects and bpy.data.objects[n].type == "MESH" and "LightmapUV" in bpy.data.objects[n].data.uv_layers]
    if objs and L.param("compare_blender", True):
        import lightmap_bake as LB
        cover, pos, nrm, owner, stats, empty = LB.raster(objs, W)
        B = np.flipud(cover > 0)  # Blender rows -> glTF rows
        own_b = np.flipud(owner)
        miss = m1 & ~covered
        per = {}
        for oi, o in enumerate(objs):
            mine = (own_b == oi) & B
            per[o.name] = {"baker_texels": int(mine.sum()), "baker_not_in_glb": int((mine & ~covered).sum()), "mask1_without_glb_owner": int((miss & (own_b == oi)).sum())}
        top = sorted(per.items(), key=lambda kv: -(kv[1]["baker_not_in_glb"] + kv[1]["mask1_without_glb_owner"]))[:25]
        cmp_ = {"receivers_compared": len(objs), "baker_covered": int(B.sum()), "baker_covered_not_in_glb": int((B & ~covered).sum()), "glb_covered_not_baker": int((covered & ~B).sum()),
                "mask1_without_glb_owner_by_baker_owner": int((miss & (own_b >= 0)).sum()), "mask1_without_any_owner": int((miss & (own_b < 0)).sum()), "worst_receivers": [{"receiver": k, **v} for k, v in top]}
    def rule(cv):
        c_ = cv > 0
        return {"covered": int(c_.sum()), "covered_and_label1": int((c_ & m1).sum()), "covered_and_label2_padding": int((c_ & m2).sum()), "covered_and_label0": int((c_ & m0).sum()), "label1_without_owner": int((m1 & ~c_).sum()),
                "multiply_owned": int((cv > 1).sum())}
    rules = {"strict_inside_only": rule(cnt), "top_left_A_(owns_edge_if_dy<0_or_dy=0_and_dx>0)": rule(covA), "top_left_B_(owns_edge_if_dy>0_or_dy=0_and_dx<0)": rule(covB),
             "inclusive_both_sides_(the baker's own rule)": rule(cnt + (tie_in > 0).astype(np.int16))}
    loader_cmp = None
    lp = L.param("loader_coverage")
    if lp:
        lc = np.fromfile(L.resolve(lp), dtype=np.uint8)
        if lc.size == W * H:
            lcov = lc.reshape(H, W) > 0
            loader_cmp = {"file": os.path.basename(lp), "loader_covered": int(lcov.sum()),
                          "differing_texels_vs_each_rule": {k: int((lcov != (v_ > 0)).sum()) for k, v_ in (("strict_inside_only", cnt), ("top_left_A", covA), ("top_left_B", covB), ("inclusive", cnt + (tie_in > 0).astype(np.int16)))}}
        else:
            loader_cmp = {"error": f"{lc.size} bytes is not {W}x{H}"}
    rep = {"loader_coverage_comparison": loader_cmp, "rules": rules, "width": W, "height": H, "primitives_with_texcoord1": len(prims), "triangles": int(sum(len(p[3]) for p in prims)), "covered_texels": int(covered.sum()), "mask_label1": int(m1.sum()), "mask_label2": int(m2.sum()),
           "covered_and_label1": int((covered & m1).sum()), "covered_and_label2_padding": int((covered & m2).sum()), "covered_and_label0": int((covered & m0).sum()), "label1_without_owner": int((m1 & ~covered).sum()),
           "edge_ties": {"centres_exactly_on_an_edge_total": ties, "texels_with_a_tie": int((tie_in > 0).sum()), "texels_with_a_tie_and_no_strict_owner": int(((tie_in > 0) & ~covered).sum())},
           "owners_per_texel": hist, "multiply_owned_texels": int(len(multi)), "multiply_owned_classes": classes, "multiply_owned_triangle_identity": ident, "multiply_owned_owner_entries_by_material": by_mat, "multiply_owned_owner_entries_by_node": dict(sorted(by_node.items(), key=lambda kv: -kv[1])[:20]),
           "examples": examples, "compare_blender": cmp_, "glb": os.path.basename(gp)}
    L.finish(rep, save=False)


L.run(main)
