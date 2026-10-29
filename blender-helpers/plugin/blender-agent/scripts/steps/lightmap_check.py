"""lightmap_check — end-to-end proof of a lightmap pack THROUGH THE EXPORTED GLB, and the binding of the manifest to that GLB. Saves no checkpoint.

For every triangle of every primitive that carries TEXCOORD_1: the centroid's TEXCOORD_1 -> the texel in the packed .bin (row 0 = glTF v 0, no flip), the value read for each fixture, against the analytic open-air value cos(theta)/d^2 at the triangle's centroid (from the GLB's own POSITION and a face normal), the fixture position taken from the manifest (Blender frame -> glTF y-up: (x, z, -y)). It also repeats the comparison with v flipped (wrong orientation) to show the check can fail.
params: accept_coincident (default false: with it, a probe that fails the strict test is accepted only under the policy printed in correspondence.coincident_acceptance.policy; the report keeps `passed` / `passed_strict` false and adds `passed_with_documented_coincident_acceptance`; with bind a normally named manifest and <name>.coincident-acceptance.json are written, an existing .REJECTED manifest is left alone); bind (true: write <name>.manifest.json next to the maps in the exact the target runtime v1.1 shape (bin, mask and GLB name/bytes/sha256, receivers = node + primitive that carry TEXCOORD_1, fixtures padded with null) and a richer <name>.lightmaps.bound.json); pose / pose_angles (copied in; default closed/closed, 0/0); glb (path under the job's out folder, e.g. "out:lm-proof.glb"), manifest (the .lightmaps.json path), bin (the .bin path; default beside the manifest), only (receiver node names to check; default all with TEXCOORD_1)
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def out_path(p):
    if p.startswith("out:"):
        return os.path.join(L.ARGS["out_dir"], p[4:])
    return L.resolve(p)


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
    js, bin_ = read_glb(out_path(L.param("glb")))
    mpath = L.resolve(L.param("manifest")) if not str(L.param("manifest")).startswith("out:") else out_path(L.param("manifest"))
    man = json.load(open(mpath, encoding="utf-8"))
    pk = man["pack"]
    binp = L.param("bin") and out_path(L.param("bin")) or os.path.join(os.path.dirname(mpath), pk["file"])
    W_, H, layers = pk["width"], pk["height"], pk["layers"]
    data = np.frombuffer(open(binp, "rb").read(), dtype="<f2").reshape(layers, H, W_, 4).astype(np.float64)
    only = set(L.param("only") or [])
    nodes_by_mesh = {}
    for n in js.get("nodes", []):
        if "mesh" in n:
            nodes_by_mesh.setdefault(n["mesh"], []).append(n.get("name"))
    parent = {}
    for ni, n in enumerate(js.get("nodes", [])):
        for c in n.get("children", []):
            parent[c] = ni

    def local(n):
        if "matrix" in n:
            return np.array(n["matrix"], np.float64).reshape(4, 4).T
        t = n.get("translation", [0, 0, 0])
        q = n.get("rotation", [0, 0, 0, 1])
        sc = n.get("scale", [1, 1, 1])
        x, y, z, w = q
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
    out = {}
    checked_nodes = []
    for ni, node in enumerate(js.get("nodes", [])):
        if "mesh" not in node:
            continue
        names = [node.get("name")]
        if only and not (set(names) & only):
            continue
        W = world(ni)
        Wn = np.linalg.inv(W[:3, :3]).T
        for prim in js["meshes"][node["mesh"]]["primitives"]:
            at = prim["attributes"]
            if "TEXCOORD_1" not in at:
                continue
            P = accessor(js, bin_, at["POSITION"])
            P = (W[:3, :3] @ P.T).T + W[:3, 3]  # the node's WORLD transform: the exported scene may sit under rotated parents
            U = accessor(js, bin_, at["TEXCOORD_1"])
            I = accessor(js, bin_, prim["indices"]).reshape(-1) if "indices" in prim else np.arange(len(P))
            T = I.reshape(-1, 3)
            p0, p1, p2 = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
            cen = (p0 + p1 + p2) / 3
            nrm = np.cross(p1 - p0, p2 - p0)
            ln = np.linalg.norm(nrm, axis=1)
            ok = ln > 1e-12
            nrm = nrm[ok] / ln[ok][:, None]
            cen = cen[ok]
            uc = ((U[T[:, 0]] + U[T[:, 1]] + U[T[:, 2]]) / 3)[ok]
            checked_nodes += names
            for flip in (False, True):
                v = 1.0 - uc[:, 1] if flip else uc[:, 1]
                tx = np.clip((uc[:, 0] * W_).astype(int), 0, W_ - 1)
                ty = np.clip((v * H).astype(int), 0, H - 1)
                for k, mp in enumerate(man["maps"]):
                    bl = np.array(mp["position_m"])
                    gl = np.array([bl[0], bl[2], -bl[1]])
                    dv = gl - cen
                    d = np.linalg.norm(dv, axis=1)
                    ana = np.maximum(0.0, (dv * nrm).sum(axis=1) / np.maximum(d, 1e-9)) / np.maximum(d, float(pk.get("distance_min_m", 0.1))) ** 2
                    val = data[mp["layer"], ty, tx, mp["channel"]]
                    sel = ana > 0.02 * max(ana.max(), 1e-9)
                    if not sel.any():
                        continue
                    r = val[sel] / ana[sel]
                    key = (mp["bulb"], "flipped" if flip else "as_exported")
                    out.setdefault(key, []).append(r)
    # EXACT correspondence (no physics): each baker probe (a texel centre with the values stored for every bulb) is found on the exported triangles by its world position, its interpolated TEXCOORD_1 must land on the same texel, and the bin there must hold the stored values
    corr = None
    pf = os.path.join(os.path.dirname(mpath), pk.get("probe_file", "")) if pk.get("probe_file") else None
    if pf and os.path.isfile(pf):
        probes = json.load(open(pf, encoding="utf-8"))["probes"]
        node_idx = {}
        for ni, node in enumerate(js.get("nodes", [])):
            if "mesh" in node:
                node_idx.setdefault(node.get("name"), []).append(ni)
        geo = {}
        rows = []
        for pr in probes:
            nis = node_idx.get(pr["object"])
            if not nis:
                rows.append({"object": pr["object"], "error": "no node of that name in the GLB"})
                continue
            bl = pr["world_m"]
            q = np.array([bl[0], bl[2], -bl[1]])
            best = None
            cands = []
            for ni in nis:
                if ni not in geo:
                    W4 = world(ni)
                    items = []
                    for prim in js["meshes"][js["nodes"][ni]["mesh"]]["primitives"]:
                        if "TEXCOORD_1" not in prim["attributes"]:
                            continue
                        P = (W4[:3, :3] @ accessor(js, bin_, prim["attributes"]["POSITION"]).T).T + W4[:3, 3]
                        U = accessor(js, bin_, prim["attributes"]["TEXCOORD_1"])
                        I = (accessor(js, bin_, prim["indices"]).reshape(-1) if "indices" in prim else np.arange(len(P))).reshape(-1, 3)
                        items.append((P[I[:, 0]], P[I[:, 1]], P[I[:, 2]], U[I[:, 0]], U[I[:, 1]], U[I[:, 2]]))
                    geo[ni] = items
                for a, b, c, ua, ub, uc_ in geo[ni]:
                    v0, v1, v2 = b - a, c - a, q - a
                    d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
                    d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
                    den = d00 * d11 - d01 * d01
                    ok_ = np.abs(den) > 1e-14
                    bv = np.where(ok_, (d11 * d20 - d01 * d21) / np.where(ok_, den, 1), -1)
                    bw = np.where(ok_, (d00 * d21 - d01 * d20) / np.where(ok_, den, 1), -1)
                    bu = 1 - bv - bw
                    nrm_ = np.cross(v0, v1)
                    nl = np.linalg.norm(nrm_, axis=1)
                    dist = np.where(nl > 1e-14, np.abs((v2 * nrm_).sum(1)) / np.maximum(nl, 1e-14), 1e9)
                    inside_ = (bu >= -1e-3) & (bv >= -1e-3) & (bw >= -1e-3)
                    cost = np.where(inside_, dist, 1e9)
                    for kk in np.nonzero(cost < 5e-3)[0][:40]:
                        gn = nrm_[kk] / max(float(nl[kk]), 1e-14)  # triangle normal (winding), glTF frame -> Blender frame (x, -z, y)
                        dn = float(gn[0] * pr["normal"][0] + (-gn[2]) * pr["normal"][1] + gn[1] * pr["normal"][2]) if pr.get("normal") else 1.0
                        cands.append((float(cost[kk]), (bu[kk] * ua[kk] + bv[kk] * ub[kk] + bw[kk] * uc_[kk]).tolist(), dn))
                    k = int(np.argmin(cost))
                    if best is None or cost[k] < best[0]:
                        best = (cost[k], bu[k] * ua[k] + bv[k] * ub[k] + bw[k] * uc_[k])
            # triangles at the same place with different orientation (coincident or opposite faces of touching parts): the probe's recorded surface normal picks the one the baker sampled
            facing = [c for c in cands if c[2] > 0.5]
            if facing:
                c0 = min(facing, key=lambda t: t[0])
                best = (c0[0], np.array(c0[1]))
            if best is None or best[0] > 5e-3:
                rows.append({"object": pr["object"], "error": "probe point not on any exported triangle", "world_m": bl})
                continue
            uvq = best[1]
            tx_, ty_ = uvq[0] * W_, uvq[1] * H
            exp_tx, exp_ty = pr["texel"][0], H - 1 - pr["texel"][1]
            err_tex = float(np.hypot(tx_ - (exp_tx + 0.5), ty_ - (exp_ty + 0.5)))
            txi, tyi = min(max(int(tx_), 0), W_ - 1), min(max(int(ty_), 0), H - 1)
            verr = 0.0
            for mp in man["maps"]:
                got = float(data[mp["layer"], tyi, txi, mp["channel"]])
                want = pr["values"][mp["bulb"]]
                verr = max(verr, abs(got - want) / max(1.0, abs(want)))
            row_ = {"object": pr["object"], "uv_error_texels": round(err_tex, 4), "value_rel_error": verr, "texel_ok": (txi, tyi) == (exp_tx, exp_ty)}
            if not row_["texel_ok"]:  # diagnosis only: which triangles lie within 5 mm of the probe, and does ANY of them map to the stored texel (coincident / opposite faces) or none (a real UV mismatch)
                cl = []
                for dd, uu_, dn_ in sorted(cands, key=lambda t: t[0]):
                    cx_, cy_ = min(max(int(uu_[0] * W_), 0), W_ - 1), min(max(int(uu_[1] * H), 0), H - 1)
                    ve_ = 0.0
                    for mp in man["maps"]:
                        ve_ = max(ve_, abs(float(data[mp["layer"], cy_, cx_, mp["channel"]]) - pr["values"][mp["bulb"]]) / max(1.0, abs(pr["values"][mp["bulb"]])))
                    same_ = all(float(data[mp["layer"], cy_, cx_, mp["channel"]]) == float(data[mp["layer"], exp_ty, exp_tx, mp["channel"]]) for mp in man["maps"])
                    cl.append({"distance_mm": round(dd * 1000, 3), "normal_dot_probe": round(dn_, 3), "texel": [cx_, cy_], "is_expected_texel": (cx_, cy_) == (exp_tx, exp_ty), "value_rel_error_vs_probe_over_all_bulbs": round(ve_, 6),
                               "stored_values_identical_to_expected_texel_all_maps": same_})
                # acceptance policy (only used with accept_coincident): the tied candidates are the triangles within 0.1 mm of the probe point facing the same way (normal dot >= 0.99); the expected texel must be one of
                # their texels, every tied candidate's texel must hold values IDENTICAL to the expected texel for ALL maps (all bulbs), and the expected texel must hold the probe's values (<= 1e-3)
                tied = [c for c in cl if c["distance_mm"] <= 0.1 and c["normal_dot_probe"] >= 0.99]
                exp_val_ok = max((abs(float(data[mp["layer"], exp_ty, exp_tx, mp["channel"]]) - pr["values"][mp["bulb"]]) / max(1.0, abs(pr["values"][mp["bulb"]])) for mp in man["maps"]), default=0.0) <= 1e-3
                acc = {"tied_candidates": len(tied), "expected_texel_among_tied": any(c["is_expected_texel"] for c in tied), "all_tied_values_identical": bool(tied) and all(c["stored_values_identical_to_expected_texel_all_maps"] for c in tied), "expected_texel_holds_probe_values": exp_val_ok}
                acc["accepted"] = acc["expected_texel_among_tied"] and acc["all_tied_values_identical"] and acc["expected_texel_holds_probe_values"]
                row_["coincident_acceptance_test"] = acc
                row_.update({"world_m": bl, "expected_texel": [exp_tx, exp_ty], "exported_texel": [txi, tyi], "candidate_triangles_within_5mm": cl[:8],
                             "a_candidate_maps_to_expected_texel": any(c["is_expected_texel"] for c in cl)})
            rows.append(row_)
        good = [r for r in rows if "error" not in r]
        corr = {"probes": len(probes), "matched": len(good), "unmatched": [r for r in rows if "error" in r][:6], "uv_error_texels_max": max((r["uv_error_texels"] for r in good), default=None),
                "value_rel_error_max": max((r["value_rel_error"] for r in good), default=None), "wrong_texel": sum(1 for r in good if not r["texel_ok"]), "wrong_texel_details": [r for r in good if not r["texel_ok"]][:20], "objects_covered": len({r["object"] for r in rows}),
                "passed": bool(good) and len(good) == len(probes) and all(r["texel_ok"] for r in good) and max(r["uv_error_texels"] for r in good) < 0.2 and max(r["value_rel_error"] for r in good) < 1e-3,
                "passed_strict": bool(good) and len(good) == len(probes) and all(r["texel_ok"] for r in good) and max(r["uv_error_texels"] for r in good) < 0.2 and max(r["value_rel_error"] for r in good) < 1e-3,
                "meaning": "the exported UV1 at each probe's world position lands on the texel the baker stored it in, and the bin holds the baker's values there (exact; no lighting involved)"}
    acc_block = None
    if corr is not None and L.param("accept_coincident", False):
        wrong_ = [r for r in good if not r["texel_ok"]]
        accepted = [r for r in wrong_ if r.get("coincident_acceptance_test", {}).get("accepted")]
        refused = [r for r in wrong_ if not r.get("coincident_acceptance_test", {}).get("accepted")]
        rest_ok = bool(good) and len(good) == len(probes) and all(r["texel_ok"] or r in accepted for r in good) and max((r["uv_error_texels"] for r in good if r["texel_ok"]), default=0) < 0.2 and max(r["value_rel_error"] for r in good) < 1e-3
        acc_block = {"requested": True, "strict_passed": corr["passed_strict"], "wrong_texel_strict": len(wrong_), "accepted": len(accepted), "refused": len(refused),
                     "passed_with_documented_coincident_acceptance": bool(rest_ok and not refused and not corr["passed_strict"]) or bool(corr["passed_strict"]),
                     "policy": "a probe that fails the strict test is accepted only if its expected texel is one of the texels of the triangles within 0.1 mm of the probe point that face the same way (normal dot >= 0.99), every such tied triangle's texel holds values IDENTICAL to the expected texel for all maps (all bulbs), and the expected texel holds the probe's values; every other mismatch, unmatched probe or value error still fails; no UV or position tolerance is widened",
                     "accepted_probes": [{"object": r["object"], "world_m": r["world_m"], "expected_texel": r["expected_texel"], "exported_texel": r["exported_texel"], "tied_candidates": r["coincident_acceptance_test"]["tied_candidates"]} for r in accepted],
                     "refused_probes": [{"object": r["object"], "world_m": r.get("world_m"), "expected_texel": r.get("expected_texel"), "test": r.get("coincident_acceptance_test")} for r in refused][:10]}
        corr["coincident_acceptance"] = acc_block
    rep = {}
    for (bulb, mode), lst in out.items():
        r = np.concatenate(lst)
        rep.setdefault(bulb, {})[mode] = {"triangles": int(len(r)), "ratio_p10_p50_p90": [round(float(np.percentile(r, q)), 3) for q in (10, 50, 90)], "within_10_percent": int(((r > 0.9) & (r < 1.1)).sum()),
                                           "shadowed_or_zero": int((r < 0.1).sum())}
    legacy_ok = all(rep[b].get("as_exported", {}).get("within_10_percent", 0) >= 0.7 * rep[b]["as_exported"]["triangles"] for b in rep) if rep else False
    ok_all = corr["passed"] if corr is not None else legacy_ok  # with probes the verdict is the exact correspondence; the centroid test is shadow-contaminated and informational
    bound = None
    if L.param("bind", False):
        import hashlib
        gp = out_path(L.param("glb"))
        gb = open(gp, "rb").read()
        recv = []
        for mi, mesh in enumerate(js["meshes"]):
            for pi, prim in enumerate(mesh["primitives"]):
                if "TEXCOORD_1" in prim["attributes"]:
                    recv.append({"mesh": mesh.get("name"), "primitive": pi, "nodes": nodes_by_mesh.get(mi, []), "triangles": int(len(accessor(js, bin_, prim["indices"])) // 3) if "indices" in prim else None})
        man["target_glb"] = {"file": os.path.basename(gp), "bytes": len(gb), "sha256": hashlib.sha256(gb).hexdigest(), "receiver_primitives": recv, "uv": "TEXCOORD_1, v as exported (row 0 of the bin = v 0)"}
        bound = mpath.replace(".json", ".bound.json")
        with open(bound, "w", encoding="utf-8") as f:
            json.dump(man, f, indent=2)
        import _lmpack as P
        d = os.path.dirname(mpath)
        rcv = [{"node": nn, "primitive": r["primitive"]} for r in recv for nn in r["nodes"]]
        hm = P.hearth_manifest(pk["width"], pk["height"], pk["layers"], [m["bulb"] for m in man["maps"]], L.param("pose", {"A": "closed", "B": "closed"}), L.param("pose_angles", {"A": 0, "B": 0}), rcv,
                               int(man["pack"]["padding"].split()[0]), sum(m.get("clamped_texels", 0) for m in man["maps"]), os.path.join(d, pk["file"]), os.path.join(d, pk["mask_file"]), gp,
                               radius=pk.get("emitter_radius_m", 0.0), dmin=pk.get("distance_min_m", 0.1))
        accepted_ok = bool(acc_block and acc_block["passed_with_documented_coincident_acceptance"] and not acc_block["strict_passed"])
        hpath = os.path.join(d, man["name"] + (".manifest.json" if (ok_all or accepted_ok) else ".manifest.REJECTED.json"))  # a failed check never leaves a normally named manifest behind; an existing REJECTED file is never deleted
        if accepted_ok:
            with open(os.path.join(d, man["name"] + ".coincident-acceptance.json"), "w", encoding="utf-8") as f:
                json.dump({"note": "this manifest was bound although the STRICT correspondence check failed; the accepted probes are coincident same-facing surfaces whose stored values are identical", "strict_passed": False, "acceptance": acc_block,
                           "glb": os.path.basename(gp)}, f, indent=2)
        with open(hpath, "w", encoding="utf-8") as f:
            json.dump(hm, f, indent=2)
        bound = hpath
    L.finish("UV/export/bin correspondence verified through the GLB" if ok_all else "CHECK FAILED: the exported GLB does not reproduce the stored map at the probe points (see correspondence)", save=False, ok=True, per_bulb=rep, receivers=sorted(set(checked_nodes)),
             passed=bool(ok_all), passed_strict=bool(ok_all), passed_with_documented_coincident_acceptance=(None if acc_block is None else bool(acc_block["passed_with_documented_coincident_acceptance"])), correspondence=corr, centroid_test_informational_only=corr is not None, bound_manifest=bound, note="each triangle's centroid UV1 (as exported, v NOT flipped) reads the packed bin; the 'flipped' rows show what a wrong orientation would give")


L.run(main)
