"""lightmap_recheck — re-judge an EXISTING lightmap set without baking (read-only, saves nothing). Run it on a copy of the checkpoint the maps were baked from (verb 87), with the set's bin and manifest.
Two modes:
  "exported" (default): the set's own `<name>.probes.json` (exact texel-centre points with the value stored for every bulb) against the scene.
  "original": re-derives the baker's OWN random probe selection (same seed and rules: the receivers' LightmapUV already in the checkpoint, `probes` default 600) and reads the stored values from the packed bin, so a point named in a bake report can be found again; it lists every point where the old single-ray test said visible but the stored value is 0, with the new five-ray verdict.
Both judge each texel as a patch: five rays (centre + four edge midpoints), each aimed from its own lifted origin to the bulb; only meshes that are render-visible and cast shadows block (bulb diffusers excluded: `exclude`).
params: manifest (the <name>.lightmaps.json: fixtures, layer, channel, texel size), bin (packed bin; mode original), probes_file (mode exported), mode, receivers + atlas_px + probes (mode original), mm_per_texel, dmin (0.1), exclude, bulbs (subset of ids)
Returns: source hashes (the checkpoint file as opened, bin, manifest), per bulb counts: visible / blocked / shadow-edge, visible stored/expected percentiles and within-10 %, visible_stored_zero, blocked_dark, edge texels with a value between 0 and open air; mode original also `old_visible_stored_zero` (each point: object, world position, texel, old verdict, patch verdict, number of rays blocked, blocker, expected, stored).
"""
import fnmatch
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import lightmap_bake as LB  # noqa: E402


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    scn = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    man_path = L.resolve(L.param("manifest"))
    man = json.load(open(man_path, encoding="utf-8"))
    pk = man.get("pack", {})
    dmin = float(L.param("dmin", 0.1))
    excl = L.param("exclude", ["bulb_*.diffuser"])
    casters = {o.name for o in scn.objects if o.type == "MESH" and not o.hide_render and o.visible_shadow and not any(fnmatch.fnmatchcase(o.name, g) for g in excl)}
    maps = [m for m in man["maps"] if not L.param("bulbs") or m["bulb"] in L.param("bulbs")]
    mode = L.param("mode", "exported")
    W = H = int(pk.get("width", L.param("atlas_px", 512)))
    layers = int(pk.get("layers", 1))
    binp = L.resolve(L.param("bin")) if L.param("bin") else None
    data = np.frombuffer(open(binp, "rb").read(), dtype="<f2").reshape(layers, H, W, 4).astype(np.float64) if binp else None
    src = {"checkpoint_opened": os.path.basename(L.ARGS.get("input") or ""), "checkpoint_sha256": sha(L.ARGS["input"]) if L.ARGS.get("input") else None, "manifest_sha256": sha(man_path), "bin_sha256": sha(binp) if binp else None}

    def blocked_by(lp, org, n):
        org = org + n * 2e-3
        dd = lp - org
        dl = dd.length
        dr = dd / dl
        left = dl
        for _ in range(12):
            hit, loc, hn, idx, ob, mw = scn.ray_cast(dg, org, dr, distance=left)
            if not hit:
                return None
            if ob.name in casters:
                return ob.name
            left -= (loc - org).length + 1e-4
            org = loc + dr * 1e-4
            if left <= 0:
                return None
        return None

    def old_blocked(lp, p, n):
        dv = lp - p
        d = dv.length
        dr = dv / d
        org = p + n * 2e-3
        left = d - 2e-3
        for _ in range(12):
            hit, loc, hn, idx, ob, mw = scn.ray_cast(dg, org, dr, distance=left)
            if not hit:
                return None
            if ob.name in casters:
                return ob.name
            left -= (loc - org).length + 1e-4
            org = loc + dr * 1e-4
            if left <= 0:
                return None
        return None

    pts = []  # (object, world p, normal n, patch points, texel, values per bulb)
    if mode == "original":
        recv = LB.pick(L.param("receivers"), {"MESH"})
        cover, pos, nrm, owner, stats, empty = LB.raster(recv, W)
        tex_m = max(s["mm_per_texel"] for s in stats) / 1000.0
        cov0 = cover > 0
        interior1 = cov0.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                shp1 = np.roll(np.roll(pos, dy, 0), dx, 1)
                interior1 &= np.roll(np.roll(cov0, dy, 0), dx, 1) & (np.linalg.norm(shp1 - pos, axis=2) <= tex_m * max(abs(dx), abs(dy)) * 1.6 + 1e-9)
        ys, xs = np.nonzero(interior1)
        n_max = int(L.param("probes", 600))
        rng = np.random.default_rng(1)
        pick = rng.choice(len(ys), size=min(n_max, len(ys)), replace=False)
        for k in pick:
            y, x = int(ys[k]), int(xs[k])
            p = Vector(pos[y, x])
            n = Vector(nrm[y, x])
            patch = [p] + [(p + Vector(pos[y + dy, x + dx])) / 2 for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0))]
            pts.append({"object": recv[int(owner[y, x])].name, "p": p, "n": n, "patch": patch, "texel": [x, y], "stored": {m["bulb"]: float(data[m["layer"], H - 1 - y, x, m["channel"]]) for m in maps}})
    else:
        probes = json.load(open(L.resolve(L.param("probes_file")), encoding="utf-8"))["probes"]
        tex = float(L.param("mm_per_texel", 46)) / 1000.0
        for pr in probes:
            p = Vector(pr["world_m"])
            n = Vector(pr["normal"]).normalized()
            t1 = n.cross(Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))).normalized()
            t2 = n.cross(t1).normalized()
            pts.append({"object": pr["object"], "p": p, "n": n, "patch": [p, p + t1 * tex / 2, p - t1 * tex / 2, p + t2 * tex / 2, p - t2 * tex / 2], "texel": pr.get("texel"), "stored": pr["values"]})
    out = {}
    nb_dark = {}
    for m in maps:
        lp = bpy.data.objects[m["light"]].matrix_world.translation
        vis, blk, edge, oldzero, buried = [], [], [], [], []
        vz_total = 0
        for q in pts:
            dv = lp - q["p"]
            d = dv.length
            facing = q["n"].dot(dv) / d
            if facing <= 1e-3:
                continue
            bl = [blocked_by(lp, c, q["n"]) for c in q["patch"]]
            nb = sum(1 for b in bl if b)
            ana = facing / max(d, dmin) ** 2
            st = q["stored"][m["bulb"]]
            rec = (nb, st, ana, facing)
            (vis if nb == 0 else blk if nb == len(bl) else edge).append(rec)
            if nb == len(bl) and st >= 0.1 * ana:  # blocked on all five rays but the map is not dark: say exactly where, who blocks, how far from the surface, and whether the stored value looks like the unblocked analytic value
                dr_ = (lp - q["p"]).normalized()
                org_ = q["p"] + q["n"] * 2e-3
                hit_, loc_, hn_, idx_, ob_, mw_ = scn.ray_cast(dg, org_, dr_, distance=d)
                nb_dark.setdefault(m["bulb"], []).append({"object": q["object"], "world_m": [round(c, 4) for c in q["p"]], "normal": [round(c, 3) for c in q["n"]], "texel": q["texel"], "dist_to_bulb_m": round(d, 3), "cos": round(facing, 3),
                                                          "rays_blocked_of_5": nb, "blockers": sorted({b for b in bl if b}), "first_hit_from_centre_ray": {"object": ob_.name if hit_ else None, "distance_m": round((loc_ - org_).length, 4) if hit_ else None,
                                                          "hit_normal_dot_surface_normal": round(float(hn_.dot(q["n"])), 3) if hit_ else None},
                                                          "stored": round(st, 5), "analytic_open": round(ana, 5), "stored_over_analytic": round(st / ana, 3) if ana else None})
            if nb == 0 and facing > 0.2 and st == 0.0:  # clear from 2 mm up but stored 0: is the point BURIED under the same or another mesh's surface a fraction of a millimetre in front of it (a hidden face, so 0 is right)?
                vz_total += 1
                bl_ = float(L.param("buried_lift_m", 1e-4))
                o2 = q["p"] + q["n"] * bl_
                dr2 = (lp - o2).normalized()
                h2, l2, n2, i2, ob2, m2 = scn.ray_cast(dg, o2, dr2, distance=(lp - o2).length)
                if h2 and ob2.name in casters and (l2 - o2).length < 0.01:
                    buried.append({"object": q["object"], "world_m": [round(c, 4) for c in q["p"]], "texel": q["texel"], "covered_by": ob2.name, "polygon": i2, "distance_along_ray_mm": round((l2 - o2).length * 1000, 2),
                                   "hit_from_behind": bool(n2.dot(dr2) > 0), "cos": round(facing, 3), "expected": round(ana, 5)})
            if mode == "original":
                ob_old = old_blocked(lp, q["p"], q["n"])
                if ob_old is None and st == 0.0 and facing > 0.2:
                    oldzero.append({"object": q["object"], "world_m": [round(c, 4) for c in q["p"]], "texel": q["texel"], "old_ray": "visible", "patch_rays_blocked_of_5": nb,
                                    "patch_verdict": "visible" if nb == 0 else ("blocked" if nb == len(bl) else "edge"), "blocker": next((b for b in bl if b), None), "dist_m": round(d, 3), "cos": round(facing, 3), "expected": round(ana, 5), "stored": st})
        vv = [r for r in vis if r[3] > 0.2]
        rat = np.array([r[1] / r[2] for r in vv])
        out[m["bulb"]] = {"facing": len(vis) + len(blk) + len(edge), "visible": len(vv), "blocked": len(blk), "edge": len(edge),
                          "visible_ratio_p10_p50_p90": [round(float(np.percentile(rat, q_)), 3) for q_ in (10, 50, 90)] if len(rat) else None, "visible_within_10_percent": int(((rat > 0.9) & (rat < 1.1)).sum()) if len(rat) else 0,
                          "visible_stored_zero": int((rat < 1e-6).sum()) if len(rat) else 0, "blocked_dark": int(sum(1 for r in blk if r[1] < 0.1 * r[2])), "edge_stored_between_0_and_open_air": int(sum(1 for r in edge if 0 < r[1] < r[2] * 1.05)),
                          "edge_stored_zero_or_full": int(sum(1 for r in edge if not (0 < r[1] < r[2] * 1.05)))}
        out[m["bulb"]]["visible_stored_zero_buried"] = {"count": len(buried), "of_visible_stored_zero": vz_total, "lift_m": float(L.param("buried_lift_m", 1e-4)), "note": "visible_stored_zero probes that a ray lifted only buried_lift_m from the point finds covered by a caster within 10 mm: a hidden face under a surface a fraction of a millimetre in front of it; the bake's 0 is right, the 2 mm lift of the five-ray test starts above that surface", "examples": buried[:12]}
        if mode == "original":
            out[m["bulb"]]["old_visible_stored_zero"] = oldzero
    L.finish("re-checked (" + mode + ")", save=False, source=src, mode=mode, points=len(pts), per_bulb=out, blocked_not_dark={"count": sum(len(v) for v in nb_dark.values()), "by_bulb": nb_dark},
             sampling_note="five rays per texel are a sample of its footprint, not a proof of a scene-wide error bound; the edge column is a sampling limitation")


if __name__ == "__main__":
    L.run(main)
