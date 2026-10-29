"""uv_edit — build an editable UV set on the body: named layers, seams by robust selections, unwrap, island texel density, pack. Saves a checkpoint.

The source UV layer is never touched: every edit works on the layer you name (make it with the `layer` op, which copies another layer). Seams are stored on the mesh edges, so they stay with the file.
Ops run in order:
  {"op": "layer", "name": "UV_edit", "from": "UVMap"}   make (or reuse) a UV layer, optionally a copy of `from`, and make it the active one (the one every later op edits)
  {"op": "seam_clear"}                                   remove every seam
  {"op": "seam_angle", "deg": 70}                        seam on edges whose faces meet at more than that angle
  {"op": "seam_groups", "groups": ["Head", "Neck", "LeftArm"], "between": "all"}   seam where the dominant bone of the faces changes between two of these groups (names without the prefix);
                                                         "between": "all" (default) or a list of pairs [["Head","Neck"], ...]; needs vertex groups
  {"op": "seam_plane", "point": [x,y,z], "normal": [x,y,z]}  seam on every edge the plane cuts (metres, world): a cut around a limb, between the torso and the head
  {"op": "seam_path", "points": [[x,y,z], [x,y,z], ...]}    seam along the shortest path over the surface between the mesh points nearest to each consecutive pair of points (metres, world):
                                                         the lengthwise cut a tube-like island (an arm, a leg) needs so that it unwraps flat instead of as a star
  {"op": "seam_box", "c": [x,y,z], "size": [x,y,z]}      seam on the edges that cross the box's surface (one end inside, one outside): cuts an island out of a region
  {"op": "unwrap", "method": "ANGLE_BASED" | "CONFORMAL", "margin": 0.003, "fill_holes": true}   unwrap the whole mesh by its seams into the active layer
  {"op": "density", "group": "Head", "scale": 2.0}       islands that mostly belong to that group are scaled by that factor (before packing): more texels on the face
  {"op": "pack", "margin": 0.003, "rotate": true}        pack all islands into 0-1, keeping their relative sizes
params:
  body   the mesh (default "body")
  ops    the list above
Returns: layers (names, active), seams (edges marked, after each seam op), islands (count, after the last op), per-op results.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import uv_common as UC  # noqa: E402

PRE = "mixamorig:"


def dominant_group(o):
    me = o.data
    if not o.vertex_groups:
        raise RuntimeError("seam_groups needs vertex groups: bind the body to the rig first")
    names = [g.name for g in o.vertex_groups]
    W = np.zeros((len(me.vertices), len(names)))
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    return W, [n[len(PRE):] if n.startswith(PRE) else n for n in names]


def main():
    o = bpy.data.objects.get(L.param("body", "body"))
    if o is None or o.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('body', 'body')}")
    me = o.data
    ops = L.param("ops") or []
    if not ops:
        raise RuntimeError("give ops, e.g. [{\"op\": \"layer\", \"name\": \"UV_edit\", \"from\": \"UVMap\"}, ...]")
    L.activate(o)
    bpy.context.scene.tool_settings.use_uv_select_sync = True  # the UV operators then act on the mesh selection (everything), not on stale UV selection flags
    res = []
    seams = None
    for op in ops:
        k = op.get("op")
        r = {"op": k}
        if k == "layer":
            name = op["name"]
            if op.get("from"):
                if op["from"] not in me.uv_layers:
                    raise RuntimeError(f"no UV layer {op['from']}; the layers are {', '.join(u.name for u in me.uv_layers)}")
                me.uv_layers.active = me.uv_layers[op["from"]]
            if name not in me.uv_layers:
                if len(me.uv_layers) >= 8:
                    raise RuntimeError("a mesh can have 8 UV layers at most")
                me.uv_layers.new(name=name, do_init=True)
            me.uv_layers.active = me.uv_layers[name]
            r["active"] = name
        elif k in ("seam_clear", "seam_angle", "seam_groups", "seam_plane", "seam_box", "seam_path"):
            bm = bmesh.new()
            bm.from_mesh(me)
            bm.edges.ensure_lookup_table()
            if k == "seam_clear":
                for e in bm.edges:
                    e.seam = False
            elif k == "seam_angle":
                lim = np.radians(float(op.get("deg", 70)))
                for e in bm.edges:
                    if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim:
                        e.seam = True
            elif k == "seam_groups":
                W, names = dominant_group(o)
                sel = [names.index(g) for g in op["groups"] if g in names]
                if len(sel) != len(op["groups"]):
                    raise RuntimeError(f"unknown group in {op['groups']}; groups: {', '.join(names)}")
                dom = np.array([max(sel, key=lambda g: W[v, g]) if W[v, sel].max() > 0.2 else -1 for v in range(len(me.vertices))])
                pairs = None if op.get("between", "all") == "all" else {frozenset((names.index(a), names.index(b))) for a, b in op["between"]}
                fdom = []
                for f in bm.faces:
                    c = np.bincount([dom[v.index] + 1 for v in f.verts], minlength=len(names) + 1)
                    fdom.append(int(c.argmax()) - 1)
                for e in bm.edges:
                    if len(e.link_faces) == 2:
                        a, b = fdom[e.link_faces[0].index], fdom[e.link_faces[1].index]
                        if a != b and a >= 0 and b >= 0 and (pairs is None or frozenset((a, b)) in pairs):
                            e.seam = True
            elif k == "seam_plane":
                pt, nm = np.array(op["point"], float), np.array(op["normal"], float)
                nm /= np.linalg.norm(nm)
                mw = o.matrix_world
                for e in bm.edges:
                    a, b = (np.array((mw @ v.co)[:]) for v in e.verts)
                    if (a - pt) @ nm > 0 and (b - pt) @ nm <= 0 or (a - pt) @ nm <= 0 and (b - pt) @ nm > 0:
                        e.seam = True
            elif k == "seam_path":
                import heapq
                from mathutils.kdtree import KDTree
                mw = o.matrix_world
                kd = KDTree(len(bm.verts))
                for v in bm.verts:
                    kd.insert(mw @ v.co, v.index)
                kd.balance()
                pts = [kd.find(__import__("mathutils").Vector(p))[1] for p in op["points"]]
                bm.verts.ensure_lookup_table()
                total = 0
                for a, b in zip(pts[:-1], pts[1:]):
                    dist, prev, hp = {a: 0.0}, {}, [(0.0, a)]
                    while hp:
                        d, u = heapq.heappop(hp)
                        if u == b:
                            break
                        if d > dist.get(u, 1e30):
                            continue
                        for e in bm.verts[u].link_edges:
                            w = e.other_vert(bm.verts[u]).index
                            nd = d + e.calc_length()
                            if nd < dist.get(w, 1e30):
                                dist[w], prev[w] = nd, (u, e.index)
                                heapq.heappush(hp, (nd, w))
                    if b not in dist:
                        raise RuntimeError("no path over the surface between two of the points")
                    cur = b
                    while cur != a:
                        u, ei = prev[cur]
                        bm.edges[ei].seam = True
                        total += 1
                        cur = u
                r["path_edges"] = total
            elif k == "seam_box":
                c, h = np.array(op["c"], float), np.array(op["size"], float) / 2
                mw = o.matrix_world
                for e in bm.edges:
                    ins = [bool((np.abs(np.array((mw @ v.co)[:]) - c) <= h).all()) for v in e.verts]
                    if ins[0] != ins[1]:
                        e.seam = True
            seams = sum(1 for e in bm.edges if e.seam)
            bm.to_mesh(me)
            bm.free()
            r["seam_edges"] = seams
        elif k == "unwrap":
            if me.uv_layers.active is None:
                raise RuntimeError("no UV layer: start with a layer op")
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.unwrap(method=op.get("method", "ANGLE_BASED"), fill_holes=bool(op.get("fill_holes", True)), margin=float(op.get("margin", 0.003)))
            bpy.ops.object.mode_set(mode="OBJECT")
            r["layer"] = me.uv_layers.active.name
        elif k == "density":
            W, names = dominant_group(o)
            if op["group"] not in names:
                raise RuntimeError(f"no group {op['group']}")
            gi = names.index(op["group"])
            lay = me.uv_layers.active.name
            lab, n = UC.islands(me, lay)
            uv = np.empty(len(me.loops) * 2)
            me.uv_layers[lay].data.foreach_get("uv", uv)
            uv = uv.reshape(-1, 2)
            scaled = 0
            for isl in range(n):
                polys = np.where(lab == isl)[0]
                vs = np.concatenate([[me.loops[li].vertex_index for li in me.polygons[p].loop_indices] for p in polys])
                share = (W[vs].argmax(1) == gi).mean()
                if share > 0.5:
                    li = np.concatenate([list(me.polygons[p].loop_indices) for p in polys])
                    c = uv[li].mean(0)
                    uv[li] = c + (uv[li] - c) * float(op["scale"])
                    scaled += 1
            me.uv_layers[lay].data.foreach_set("uv", uv.ravel())
            me.update()
            r["islands_scaled"] = scaled
        elif k == "pack":
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.pack_islands(udim_source="ACTIVE_UDIM", rotate=bool(op.get("rotate", True)), margin=float(op.get("margin", 0.003)))
            bpy.ops.object.mode_set(mode="OBJECT")
        else:
            raise RuntimeError(f"unknown op {k}")
        res.append(r)
    lay = me.uv_layers.active.name if me.uv_layers.active else None
    nis = UC.islands(me, lay)[1] if lay else None
    L.finish({"layers": [u.name for u in me.uv_layers], "active": lay, "seam_edges": seams if seams is not None else sum(1 for e in me.edges if e.use_seam), "islands": nis, "ops": res}, save=True)


L.run(main)
