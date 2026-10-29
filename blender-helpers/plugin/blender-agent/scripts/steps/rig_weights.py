"""rig_weights — read and edit the skin weights of the bound body, locally, without running the automatic weights again. Saves a checkpoint (not for a pure read, or with dry_run).

Weights live in the body's vertex groups (one per bone). A list of ops runs in order on a SELECTION of vertices; what is outside the selection is never touched.

params:
  body      the mesh (default "body")
  select    which vertices (world frame, millimetres/metres as named); default all:
              "all"
              {"box": {"c": [x, y, z], "size": [x, y, z]}}                  metres
              {"sphere": {"c": [x, y, z], "r": r}}                          metres
              {"near_bone": {"bone": "LeftLeg", "radius_mm": 60}}           within that distance of the bone's segment
              {"group": {"name": "LeftLeg", "min": 0.2}}                    vertices with at least that weight in the group (name without the prefix)
              {"side": "left" | "right"}                                    x >= 0 or x < 0 (+X is the character's left); can be combined with another selector as {"and": [sel, sel]}
  ops       a list; each {op, ...}:
              {"op": "read"}                                                  report only
              {"op": "set", "group": "LeftLeg", "weight": 1.0, "mode": "replace"|"add"|"subtract"|"multiply"}   (group name without the prefix)
              {"op": "smooth", "iterations": 2, "factor": 0.5}                every group's weights averaged with the neighbours' (iterations of a Laplacian step)
              {"op": "normalize", "lock": ["Hips"]}                           scale the unlocked groups so the total is 1 (locked groups keep their weight)
              {"op": "limit", "max": 4}                                       keep each vertex's strongest `max` influences, then normalise
              {"op": "mirror", "from": "left"|"right", "tol_mm": 6}           copy the weights of the vertices on that side to the mirror-image vertices on the other side (Left and Right groups swapped)
              {"op": "transfer", "from": ["Neck", "Spine2"], "to": "Head", "amount": 1.0}   move that share of the listed groups' weight to another group, on the selected vertices (with `region`, scaled by the region weight); the totals stay the same
              {"op": "clear", "group": "LeftLeg"}                              remove the group's weight from the selected vertices
              {"op": "taper", "group": "LeftUpLeg", "axis": "x", "full_mm": 20, "zero_mm": -30, "to": "Hips"}
                                                                              the group's weight fades along a world axis: kept in full at or beyond full_mm, none at or beyond zero_mm (smooth between), on the selected vertices;
                                                                              what is removed is added to `to` (default Hips), so each vertex's total is unchanged. Positions are never touched (only weights). Use dry_run to see the counts first
  region    a SOFT region instead of (or as well as) the hard `select`: the same kinds and millimetre units as mesh_local, with a smooth falloff
              ({"sphere": {"c": [x, y, z], "r_mm": 40, "falloff_mm": 25}} (or "radii_mm"), {"box": {"c", "size_mm", "falloff_mm"}}, {"near_bone": {"bone", "radius_mm", "falloff_mm"}}, {"group": {"name", "min"}}, {"all": [...]}, {"any": [...]}).
            Every op then applies to a vertex in proportion to its region weight (1 inside, fading to 0 across the falloff), so an edit fades out instead of ending at a cut. Vertices with weight 0 are not touched. (Not mirrored: run it once per side.)
  lock      groups (without the prefix) that no op may change anywhere ("pins"): their weights are restored after each op, and the rest renormalised
  dry_run   true = report only, change nothing
Returns: selected (vertices, how), per op: affected vertices and the weight totals; before / after (vertices with no weight, with more than 4 influences, with a total not 1, largest influence count, the dominant vertices per bone),
changed_vertices, changed_by_group, and sample (up to 8 selected vertices with their weights).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402
from _region import region_weight  # noqa: E402

PRE = R.PREFIX


def read_weights(body):
    me = body.data
    n = len(me.vertices)
    names = [g.name for g in body.vertex_groups]
    W = np.zeros((n, len(names)))
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    return W, names


def write_weights(body, W, W0, names, rows):
    """write back only the vertices in `rows` whose weights changed"""
    ch = 0
    for i in rows:
        if np.allclose(W[i], W0[i], atol=1e-7):
            continue
        ch += 1
        for gi, g in enumerate(body.vertex_groups):
            if abs(W[i, gi] - W0[i, gi]) > 1e-7:
                if W[i, gi] > 1e-6:
                    g.add([int(i)], float(W[i, gi]), "REPLACE")
                else:
                    g.remove([int(i)])
    return ch


def stats(W):
    nz = (W > 0.01).sum(1)
    s = W.sum(1)
    dom = W.argmax(1)
    return {"unweighted": int((W.max(1) <= 0.01).sum()), "over_4_influences": int((nz > 4).sum()), "max_influences": int(nz.max()), "sum_not_1": int((np.abs(s - 1) > 0.01).sum()), "_dom": dom}


def select_mask(sel, V, arm, body, W, names):
    if sel in (None, "all"):
        return np.ones(len(V), bool), "all"
    if isinstance(sel, dict) and "and" in sel:
        ms = [select_mask(s, V, arm, body, W, names) for s in sel["and"]]
        m = ms[0][0]
        for x in ms[1:]:
            m = m & x[0]
        return m, "and(" + ", ".join(x[1] for x in ms) + ")"
    if not isinstance(sel, dict) or len(sel) != 1:
        raise RuntimeError('select must be "all" or an object with one of box, sphere, near_bone, group, side, and')
    k, v = next(iter(sel.items()))
    if k == "box":
        c, s = np.array(v["c"], float), np.array(v["size"], float) / 2
        return (np.abs(V - c) <= s).all(1), "box"
    if k == "sphere":
        return np.linalg.norm(V - np.array(v["c"], float), axis=1) <= float(v["r"]), "sphere"
    if k == "near_bone":
        b = arm.data.bones.get(PRE + v["bone"])
        if b is None:
            raise RuntimeError(f"no bone {v['bone']}")
        a, e = np.array(arm.matrix_world @ b.head_local), np.array(arm.matrix_world @ b.tail_local)
        d = e - a
        t = np.clip(((V - a) @ d) / max(d @ d, 1e-12), 0, 1)
        return np.linalg.norm(V - (a + t[:, None] * d), axis=1) <= float(v.get("radius_mm", 60)) / 1000.0, f"near {v['bone']}"
    if k == "group":
        gi = names.index(PRE + v["name"]) if PRE + v["name"] in names else None
        if gi is None:
            raise RuntimeError(f"no group {v['name']}")
        return W[:, gi] >= float(v.get("min", 0.01)), f"group {v['name']}"
    if k == "side":
        if v not in ("left", "right"):
            raise RuntimeError('side must be "left" or "right"')
        return (V[:, 0] >= 0) if v == "left" else (V[:, 0] < 0), v
    raise RuntimeError(f"unknown selector {k}")


def gidx(names, g):
    if PRE + g not in names:
        raise RuntimeError(f"no group {g}. Groups: {', '.join(n[len(PRE):] for n in names)}")
    return names.index(PRE + g)


def adjacency(me):
    n = len(me.vertices)
    nb = [[] for _ in range(n)]
    for e in me.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    return nb


def main():
    arm = R.find_rig()
    body = bpy.data.objects.get(L.param("body", "body"))
    if body is None or body.type != "MESH" or not body.vertex_groups:
        raise RuntimeError("the body has no vertex groups: bind it first (rig_biped, or rig_bind)")
    ops = L.param("ops") or []
    if not ops:
        raise RuntimeError("give ops, e.g. [{\"op\": \"read\"}]")
    V = np.array([(body.matrix_world @ v.co)[:] for v in body.data.vertices])
    W, names = read_weights(body)
    W0 = W.copy()
    s0 = stats(W)
    mask, how = select_mask(L.param("select"), V, arm, body, W, names)
    rw = None
    if L.param("region"):
        w_reg = region_weight(L.param("region"), V, arm, W, names, False)[0]
        if w_reg.max() <= 1e-6:
            lo, hi = V.min(0) * 1000, V.max(0) * 1000
            raise RuntimeError(f"the region selects no vertex. Region positions and sizes are in MILLIMETRES, world frame; the body spans x {lo[0]:.0f}..{hi[0]:.0f}, y {lo[1]:.0f}..{hi[1]:.0f}, z {lo[2]:.0f}..{hi[2]:.0f} mm")
        mask = mask & (w_reg > 1e-6)
        how = f"{how} + soft region"
    rows = np.where(mask)[0]
    if L.param("region"):
        rw = w_reg[rows]
    lock = [gidx(names, g) for g in (L.param("lock") or [])]
    nb = None
    report = []
    for o in ops:
        kind = o.get("op")
        before = W[rows].copy()
        if kind == "read":
            pass
        elif kind == "set":
            gi = gidx(names, o["group"])
            w = float(o["weight"])
            md = o.get("mode", "replace")
            if md == "replace":
                W[rows, gi] = w
            elif md == "add":
                W[rows, gi] = np.clip(W[rows, gi] + w, 0, 1)
            elif md == "subtract":
                W[rows, gi] = np.clip(W[rows, gi] - w, 0, 1)
            elif md == "multiply":
                W[rows, gi] = np.clip(W[rows, gi] * w, 0, 1)
            else:
                raise RuntimeError("mode must be replace, add, subtract or multiply")
        elif kind == "smooth":
            nb = nb or adjacency(body.data)
            f = float(o.get("factor", 0.5))
            for _ in range(int(o.get("iterations", 2))):
                Wn = W.copy()
                for i in rows:
                    if nb[i]:
                        Wn[i] = (1 - f) * W[i] + f * W[nb[i]].mean(0)
                W = Wn
        elif kind == "normalize":
            lk = [gidx(names, g) for g in (o.get("lock") or [])]
            free = [i for i in range(W.shape[1]) if i not in lk]
            for i in rows:
                fixed = W[i, lk].sum() if lk else 0.0
                s = W[i, free].sum()
                if s > 1e-9:
                    W[i, free] *= max(0.0, 1 - fixed) / s
        elif kind == "limit":
            m = int(o.get("max", 4))
            for i in rows:
                if (W[i] > 1e-6).sum() > m:
                    keep = np.argsort(-W[i])[:m]
                    z = np.zeros(W.shape[1])
                    z[keep] = W[i, keep]
                    W[i] = z / z.sum()
        elif kind == "mirror":
            side = o.get("from", "left")
            tol = float(o.get("tol_mm", 6)) / 1000.0
            from mathutils.kdtree import KDTree
            kd = KDTree(len(V))
            for i, p in enumerate(V):
                kd.insert(p, i)
            kd.balance()
            swap = {}
            for gi, n in enumerate(names):
                m = n.replace("Left", "\0").replace("Right", "Left").replace("\0", "Right")
                if m in names:
                    swap[gi] = names.index(m)
            src = rows[(V[rows, 0] >= 0) if side == "left" else (V[rows, 0] < 0)]
            done = 0
            for i in src:
                p = V[i].copy()
                p[0] = -p[0]
                _, j, d = kd.find(p)
                if d <= tol and j != i:
                    row = np.zeros(W.shape[1])
                    for gi in range(W.shape[1]):
                        row[swap.get(gi, gi)] = W[i, gi]
                    W[j] = row
                    done += 1
            report.append({"op": "mirror", "copied_vertices": done, "from": side})
            continue
        elif kind == "taper":
            # the group's weight fades along an axis (smoothstep between zero_mm and full_mm, world millimetres); what is removed goes to `to`, so every vertex's total stays the same
            gi, ti = gidx(names, o["group"]), gidx(names, o.get("to", "Hips"))
            if gi == ti:
                raise RuntimeError("taper: `to` must be a different group")
            ax = {"x": 0, "y": 1, "z": 2}[str(o.get("axis", "x")).lower()]
            full, zero = float(o["full_mm"]), float(o["zero_mm"])
            if full == zero:
                raise RuntimeError("taper: full_mm and zero_mm must differ")
            t = np.clip((V[rows, ax] * 1000 - zero) / (full - zero), 0, 1)
            f = t * t * (3 - 2 * t)
            moved = W[rows, gi] * (1 - f)
            W[rows, gi] -= moved
            W[rows, ti] += moved
        elif kind == "transfer":
            fr = o["from"] if isinstance(o["from"], list) else [o["from"]]
            fi = [gidx(names, g) for g in fr]
            ti = gidx(names, o["to"])
            if ti in fi:
                raise RuntimeError("transfer: `to` must not be one of `from`")
            amt = float(o.get("amount", 1.0))
            moved = W[np.ix_(rows, fi)].sum(1) * amt
            W[np.ix_(rows, fi)] *= (1 - amt)
            W[rows, ti] += moved
        elif kind == "clear":
            W[rows, gidx(names, o["group"])] = 0
        else:
            raise RuntimeError(f"unknown op {kind}")
        if rw is not None and kind != "read":  # a soft region: each vertex takes the op's result only in proportion to its region weight
            W[rows] = before + rw[:, None] * (W[rows] - before)
        if lock and kind != "read":
            for i in rows:  # pins: the locked groups go back, the rest renormalised
                fixed = W0[i, lock].sum()
                free = [g for g in range(W.shape[1]) if g not in lock]
                W[i, lock] = W0[i, lock]
                s = W[i, free].sum()
                if s > 1e-9:
                    W[i, free] *= max(0.0, 1 - fixed) / s
        d = np.abs(W[rows] - before)
        report.append({"op": kind, "vertices_changed": int((d.max(1) > 1e-7).sum()) if len(rows) else 0, "largest_weight_change": round(float(d.max()) if d.size else 0.0, 4),
                       "selected_weight_totals": {names[g][len(PRE):]: round(float(W[rows, g].sum()), 2) for g in np.argsort(-W[rows].sum(0))[:5]} if len(rows) else {}})
    s1 = stats(W)
    dry = bool(L.param("dry_run", False)) or all(r["op"] == "read" for r in report)
    changed = 0 if dry else write_weights(body, W, W0, names, rows)
    by_group = {names[g][len(PRE):]: int((np.abs(W[:, g] - W0[:, g]) > 1e-7).sum()) for g in range(W.shape[1]) if (np.abs(W[:, g] - W0[:, g]) > 1e-7).any()}
    names_short = [n[len(PRE):] for n in names]

    def dom(s):
        d = {}
        for g in s.pop("_dom"):
            d[names_short[g]] = d.get(names_short[g], 0) + 1
        return dict(sorted(d.items(), key=lambda kv: -kv[1])[:8])
    dom0, dom1 = dom(s0), dom(s1)
    sample = [{"vertex": int(i), "mm": [round(float(x) * 1000, 1) for x in V[i]], "weights": {names_short[g]: round(float(W[i, g]), 3) for g in np.argsort(-W[i])[:4] if W[i, g] > 0.005}} for i in rows[:8]]
    out = {"selected": {"vertices": int(len(rows)), "how": how}, "ops": report, "before": {**s0, "dominant": dom0}, "after": {**s1, "dominant": dom1}, "changed_vertices": int(changed) if not dry else int((np.abs(W - W0).max(1) > 1e-7).sum()),
           "changed_by_group": by_group, "sample": sample, "dry_run": dry}
    L.finish(out, save=not dry)


L.run(main)
