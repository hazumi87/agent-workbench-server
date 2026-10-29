"""component_transform — scale, move or turn ONE OR MORE connected components (pieces) of a mesh in place, everything else in the mesh left exactly as it is. Vertex positions only: UV layers, materials, face/vertex order and counts, vertex groups and the object's own transform are not touched. Saves a checkpoint (not with dry_run).

For a batched static mesh (many pieces merged into one object per material) where one piece must change, e.g. shorten one plank so its ends stop 2 mm short of the planks it butts against.
params:
  part        the object (required); a mesh shared with another object, or with shape keys, is refused
  select      how to pick pieces (give ONE):
                {"components": [3, 7]}  piece numbers as `face_orient` reports them (pieces = faces joined through shared vertices, numbered in order of their lowest vertex index)
                {"box": [[xmin,ymin,zmin],[xmax,ymax,zmax]], "tol_m": 0.001}  WORLD metres: a piece is picked when its whole world bounding box lies inside the box grown by tol_m (default 1 mm); pieces only partly inside are NOT picked and are listed
  scale       number or [sx, sy, sz] (default 1): about the pivot, along the WORLD axes
  rotate_deg  [rx, ry, rz] (default none): about the pivot, Euler XYZ in the WORLD frame, applied after the scale
  move        [dx, dy, dz] metres, WORLD frame (default none), applied last
  pivot       [x, y, z] WORLD metres; default = the middle of the picked pieces' joint bounding box
  expect      optional guard, {"pieces": 1, "faces": 22}: nothing is changed (and the step fails) when the picked pieces differ
  dry_run     true: report only
Returns: picked pieces (number, faces, vertices, world bounds before / after), `not_picked_partly_inside` (pieces that cut the box edge), `unpicked_vertex_drift_m` (largest move of any vertex outside the pieces: 0 expected), `uv_unchanged`, `materials_unchanged`, `counts_unchanged`, `transform_world` (the matrix used), warnings. UV0 is NOT adjusted: a plank scaled shorter keeps its UV, so its texture is compressed by the same factor along that direction (reported as `texture_stretch_note` when the scale is not 1). Shading normals follow the faces (smooth normals are recomputed by Blender); a mesh with CUSTOM split normals is refused.
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Euler, Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402


def components(bm):
    comp_of = [-1] * len(bm.verts)
    comps = []
    for v in bm.verts:
        if comp_of[v.index] != -1 or not v.link_faces:
            continue
        ci = len(comps)
        stack = [v]
        comp_of[v.index] = ci
        vs = []
        while stack:
            a = stack.pop()
            vs.append(a.index)
            for e in a.link_edges:
                b = e.other_vert(a)
                if comp_of[b.index] == -1:
                    comp_of[b.index] = ci
                    stack.append(b)
        comps.append(vs)
    return comps


def digest(arr):
    return hashlib.sha256(np.ascontiguousarray(arr).tobytes()).hexdigest()[:16]


def fingerprints(me):
    out = {}
    out["counts"] = (len(me.vertices), len(me.edges), len(me.polygons), len(me.loops))
    out["materials"] = digest(np.array([p.material_index for p in me.polygons], dtype=np.int32))
    out["uv"] = {}
    for layer in me.uv_layers:
        a = np.empty(len(me.loops) * 2, dtype=np.float32)
        layer.data.foreach_get("uv", a)
        out["uv"][layer.name] = digest(a)
    loops = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("vertex_index", loops)
    out["topology"] = digest(loops)
    return out


def main():
    ob = bpy.data.objects.get(L.param("part", ""))
    if ob is None or ob.type != "MESH":
        raise RuntimeError(f"part: no mesh object named {L.param('part')!r}")
    me = ob.data
    if me.users > 1:
        raise RuntimeError(f"{ob.name}: the mesh is shared by {me.users} users; refusing to change it for all of them")
    if me.shape_keys is not None:
        raise RuntimeError(f"{ob.name}: has shape keys; refusing")
    if me.has_custom_normals:
        raise RuntimeError(f"{ob.name}: has custom split normals; refusing (they would no longer match the moved faces)")
    sel = L.param("select") or {}
    mw = ob.matrix_world.copy()
    mwi = mw.inverted()
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    wco = (np.array(mw)[:3, :3] @ co.T).T + np.array(mw)[:3, 3]
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    comps = components(bm)
    bm.free()
    picked, partly = [], []
    if "components" in sel:
        for i in sel["components"]:
            if not (0 <= int(i) < len(comps)):
                raise RuntimeError(f"select.components: {i} is outside 0..{len(comps) - 1}")
            picked.append(int(i))
    elif "box" in sel:
        lo = np.array(sel["box"][0], dtype=float) - float(sel.get("tol_m", 0.001))
        hi = np.array(sel["box"][1], dtype=float) + float(sel.get("tol_m", 0.001))
        for i, vs in enumerate(comps):
            p = wco[vs]
            clo, chi = p.min(axis=0), p.max(axis=0)
            if (clo >= lo).all() and (chi <= hi).all():
                picked.append(i)
            elif (chi >= lo).all() and (clo <= hi).all():
                partly.append({"component": i, "bounds_m": [[round(float(x), 4) for x in clo], [round(float(x), 4) for x in chi]]})
    else:
        raise RuntimeError("select: give {\"components\": [...]} or {\"box\": [[...],[...]]}")
    if not picked:
        raise RuntimeError(f"nothing picked (pieces: {len(comps)}; partly inside the box: {len(partly)})")
    vsel = sorted({v for i in picked for v in comps[i]})
    faces_picked = 0
    fp = {p.index for p in me.polygons}
    vset = set(vsel)
    faces_picked = sum(1 for p in me.polygons if all(v in vset for v in p.vertices))
    exp = L.param("expect")
    if exp and (("pieces" in exp and exp["pieces"] != len(picked)) or ("faces" in exp and exp["faces"] != faces_picked)):
        raise RuntimeError(f"expect {exp} but picked {len(picked)} pieces / {faces_picked} faces: nothing changed")
    sc = L.param("scale", 1.0)
    sc = [float(sc)] * 3 if isinstance(sc, (int, float)) else [float(x) for x in sc]
    rot = L.param("rotate_deg")
    mv = L.param("move")
    pts = wco[vsel]
    pivot = np.array(L.param("pivot") if L.param("pivot") is not None else (pts.min(axis=0) + pts.max(axis=0)) / 2.0, dtype=float)
    R = np.eye(3)
    if rot:
        R = np.array(Euler([float(x) * 3.141592653589793 / 180.0 for x in rot], "XYZ").to_matrix())
    new_w = wco.copy()
    q = (pts - pivot) * np.array(sc)
    q = (R @ q.T).T + pivot
    if mv:
        q = q + np.array(mv, dtype=float)
    new_w[vsel] = q
    before = fingerprints(me)

    def bounds(a):
        return [[round(float(x), 5) for x in a.min(axis=0)], [round(float(x), 5) for x in a.max(axis=0)]]
    per = []
    for i in picked:
        per.append({"component": i, "vertices": len(comps[i]), "bounds_before_m": bounds(wco[comps[i]]), "bounds_after_m": bounds(new_w[comps[i]])})
    dry = bool(L.param("dry_run", False))
    warnings = []
    if any(abs(s - 1.0) > 1e-9 for s in sc):
        warnings.append("texture_stretch_note: UV0 is not adjusted; a piece scaled by " + str(sc) + " keeps its UV, so its texture is stretched or compressed by the same factors along the scaled directions")
    if len(partly):
        warnings.append(f"{len(partly)} piece(s) cut the box edge and were NOT picked (see not_picked_partly_inside)")
    drift = 0.0
    uv_same = mats_same = counts_same = None
    if not dry:
        newco = (np.array(mwi)[:3, :3] @ new_w.T).T + np.array(mwi)[:3, 3]
        me.vertices.foreach_set("co", newco.reshape(-1))
        me.update()
        after = fingerprints(me)
        co2 = np.empty(len(me.vertices) * 3, dtype=np.float64)
        me.vertices.foreach_get("co", co2)
        wco2 = (np.array(mw)[:3, :3] @ co2.reshape(-1, 3).T).T + np.array(mw)[:3, 3]
        others = np.ones(len(wco), dtype=bool)
        others[vsel] = False
        drift = float(np.abs(wco2[others] - wco[others]).max()) if others.any() else 0.0
        uv_same = after["uv"] == before["uv"]
        mats_same = after["materials"] == before["materials"]
        counts_same = after["counts"] == before["counts"] and after["topology"] == before["topology"]
    L.finish({"part": ob.name, "pieces_in_mesh": len(comps), "picked": per, "faces_picked": faces_picked, "dry_run": dry,
              "not_picked_partly_inside": partly, "unpicked_vertex_drift_m": drift, "uv_unchanged": uv_same, "materials_unchanged": mats_same,
              "counts_unchanged": counts_same, "pivot_m": [round(float(x), 5) for x in pivot], "scale": sc, "rotate_deg": rot, "move_m": mv,
              "transform_world": [list(map(float, r)) for r in mw], "warnings": warnings},
             save=not dry)


L.run(main)
