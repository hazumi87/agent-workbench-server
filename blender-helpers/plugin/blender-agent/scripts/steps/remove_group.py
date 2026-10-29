"""remove_group — cut a region off a part (the faces of a vertex group, or inside a box) and CLOSE the hole with a cap; report what was removed and the mesh health before and after, with pictures of the hole and the cap. Saves a checkpoint (not with dry_run).

For taking a placeholder piece off a generated part where another part covers it (a neck stump on a torso where the head sits): the faces go, the opening is closed with a flat cap, and nothing else changes. Only the NEW opening is capped: boundary that was already open stays open. The cap takes its material from the faces around it, and its UVs are copied per vertex from the neighbouring faces (stretched, but the colours stay plausible; check the picture). Vertex groups of the remaining vertices are untouched; vertices left with no face are deleted.

params:
  part         the object (required)
  group        a vertex group name: a face goes when ALL its vertices have weight >= min_weight in it (min_weight default 0.5)
  box          [[xmin, ymin, zmin], [xmax, ymax, zmax]] metres, WORLD frame: a face goes when its centre is inside (use group or box, or both: a face is removed when either selects it; `combine`: "or" (default) | "and")
  cap          true (default): close the new opening(s); false: leave them open
  weld_opening true (default): weld the vertices of the NEW opening that sit at one place (a mesh read from a GLB is split at UV seams), so the opening is one closed loop to cap; weld_dist_m (default 1e-5). Only the opening's own vertices are touched
  cap_style    "ngon" (default: one flat polygon per opening) | "tris" (the cap triangulated: a fan-free, even fill for rendering and export)
  dry_run      true: nothing is changed; the report and the "before" picture say what would go
  pictures     true (default): clay pictures of the region before (and after, unless dry_run) from the side the faces looked at, and from above it; res px (default 600), `size` closeup width in metres (default 2.5 x the region)
Returns: removed (faces, vertices, region centre / size in metres, the removed faces' mean normal), holes (new opening loops: count, edges each, capped), cap (faces, triangles, material used, flipped_normals = rim edges where the cap's winding disagrees with the surrounding faces, 0 expected; rim_edges_consistent; cap_turned_over), health before and after (vertices, faces, non-manifold edges, boundary edges, loose vertices), pictures, notes. Refuses when nothing matches, when the group does not exist, or when the cut would remove the whole part.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def health(bm):
    nm = sum(1 for e in bm.edges if len(e.link_faces) > 2)
    bd = sum(1 for e in bm.edges if len(e.link_faces) == 1)
    loose = sum(1 for v in bm.verts if not v.link_edges)
    return {"vertices": len(bm.verts), "faces": len(bm.faces), "non_manifold_edges": nm, "boundary_edges": bd, "loose_vertices": loose}


def loops_of(edges):
    """group boundary edges into closed loops of vertex indices (edges as (a, b) index pairs)"""
    adj = {}
    for a, b in edges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen, out = set(), []
    for s in adj:
        if s in seen:
            continue
        stack, comp = [s], []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            comp.append(x)
            stack.extend(adj[x])
        out.append(comp)
    return out


def main():
    obj = bpy.data.objects.get(L.param("part", ""))
    if obj is None or obj.type != "MESH":
        raise RuntimeError("give `part`: the name of a mesh object")
    gname, box = L.param("group"), L.param("box")
    if not gname and not box:
        raise RuntimeError("give `group` and/or `box`")
    me = obj.data
    mw = np.array(obj.matrix_world)
    gi = None
    if gname:
        if gname not in obj.vertex_groups:
            raise RuntimeError(f"{obj.name} has no vertex group {gname}; its groups: {[g.name for g in obj.vertex_groups][:20]}")
        gi = obj.vertex_groups[gname].index
    minw = float(L.param("min_weight", 0.5))
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    dl = bm.verts.layers.deform.verify()
    before = health(bm)
    bd_before = {tuple(sorted((e.verts[0].index, e.verts[1].index))) for e in bm.edges if len(e.link_faces) == 1}
    sel_g = np.zeros(len(bm.faces), bool)
    sel_b = np.zeros(len(bm.faces), bool)
    if gi is not None:
        for f in bm.faces:
            sel_g[f.index] = all(v[dl].get(gi, 0.0) >= minw for v in f.verts)
    if box:
        lo, hi = np.array(box[0], float), np.array(box[1], float)
        for f in bm.faces:
            c = mw[:3, :3] @ np.array(f.calc_center_median()) + mw[:3, 3]
            sel_b[f.index] = bool(((c >= lo) & (c <= hi)).all())
    if gname and box:
        sel = (sel_g & sel_b) if L.param("combine", "or") == "and" else (sel_g | sel_b)
    else:
        sel = sel_g if gname else sel_b
    if not sel.any():
        raise RuntimeError("nothing matches: no face has all its vertices in the group at that weight / its centre in the box")
    if sel.all():
        raise RuntimeError("the selection is the whole part: refused")
    removed_faces = [bm.faces[i] for i in np.nonzero(sel)[0]]
    rv = np.array([mw[:3, :3] @ np.array(v.co) + mw[:3, 3] for f in removed_faces for v in f.verts])
    centre = rv.mean(0)
    size = rv.max(0) - rv.min(0)
    nrm = np.mean([mw[:3, :3] @ np.array(f.normal) for f in removed_faces], axis=0)
    nrm = nrm / max(np.linalg.norm(nrm), 1e-9)
    dry = bool(L.param("dry_run", False))
    do_pics = bool(L.param("pictures", True))
    res = int(L.param("res", 600))
    csize = float(L.param("size", max(float(size.max()) * 2.5, 0.08)))
    files = []
    from _handview import render_views  # noqa: E402

    def pics(tag):
        d = Vector(nrm.tolist())
        up = Vector((0, 0, 1))
        side = d.cross(up)
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        side.normalize()
        dirs = {"facing": d, "above": Vector((0.001, 0.001, 1.0)), "side": side}
        return render_views([obj], Vector(centre.tolist()), csize, f"removegroup-{tag}", res, dirs)
    if do_pics:
        files += pics("before")
    out = {"part": obj.name, "dry_run": dry, "selected_by": {"group": gname, "min_weight": minw if gname else None, "box": box}, "health_before": before,
           "removed": {"faces": int(sel.sum()), "region_centre_m": [round(float(x), 4) for x in centre], "region_size_m": [round(float(x), 4) for x in size], "mean_normal": [round(float(x), 3) for x in nrm]}}
    if dry:
        out["pictures"] = [os.path.basename(f) for f in files]
        out["notes"] = ["dry run: nothing was changed"]
        L.finish(out, save=False, files=files)
        bm.free()
        return
    verts_before = len(bm.verts)
    bmesh.ops.delete(bm, geom=removed_faces, context="FACES")
    bm.verts.ensure_lookup_table()
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.verts.index_update()
    bm.edges.ensure_index_table() if hasattr(bm.edges, "ensure_index_table") else None
    out["removed"]["vertices"] = verts_before - len(bm.verts)
    bd_after_cut = [e for e in bm.edges if len(e.link_faces) == 1]
    # the NEW opening: boundary edges that were not boundary before (matched by their vertex positions: indices moved)
    old_pos = set()
    # rebuild positions of the old boundary edges from the original mesh data
    for a, b in bd_before:
        pa, pb = me.vertices[a].co, me.vertices[b].co
        old_pos.add(tuple(sorted((tuple(np.round(pa, 6)), tuple(np.round(pb, 6))))))
    new_edges = [e for e in bd_after_cut if tuple(sorted((tuple(np.round(e.verts[0].co, 6)), tuple(np.round(e.verts[1].co, 6))))) not in old_pos]
    # a mesh read from a GLB is split at UV seams / hard edges (duplicate vertices at one place): the opening must be ONE closed loop, so the vertices of the new opening that sit at the same place are welded (only those)
    ring = list({v for e in new_edges for v in e.verts})
    welded = 0
    if ring and bool(L.param("weld_opening", True)):
        n0 = len(bm.verts)
        bmesh.ops.remove_doubles(bm, verts=ring, dist=float(L.param("weld_dist_m", 1e-5)))
        welded = n0 - len(bm.verts)
        bm.verts.index_update()
        new_edges = [e for e in bm.edges if len(e.link_faces) == 1 and tuple(sorted((tuple(np.round(e.verts[0].co, 6)), tuple(np.round(e.verts[1].co, 6))))) not in old_pos]
    comps = loops_of([(e.verts[0].index, e.verts[1].index) for e in new_edges])
    holes = [{"edges": 0} for _ in comps]
    cap = bool(L.param("cap", True))
    cap_faces = []
    if cap and new_edges:
        res_f = bmesh.ops.holes_fill(bm, edges=new_edges, sides=max(len(new_edges) + 2, 4))
        cap_faces = res_f["faces"]
        if L.param("cap_style", "ngon") == "tris":
            r2 = bmesh.ops.triangulate(bm, faces=cap_faces, quad_method="BEAUTY", ngon_method="BEAUTY")
            cap_faces = r2["faces"]
        # the material of the faces around the cap; UVs per vertex from the neighbours
        uvl = bm.loops.layers.uv.active
        mats = {}
        cap_set = set(cap_faces)
        for f in cap_faces:
            for e in f.edges:
                for nf in e.link_faces:
                    if nf not in cap_set:
                        mats[nf.material_index] = mats.get(nf.material_index, 0) + 1
        mi = max(mats, key=mats.get) if mats else 0
        for f in cap_faces:
            f.material_index = mi
            f.smooth = False
            if uvl is not None:
                for lp in f.loops:
                    src = next((l2 for l2 in lp.vert.link_loops if l2.face not in cap_set), None)
                    if src is not None:
                        lp[uvl].uv = src[uvl].uv
        # winding: the cap must run the OPPOSITE way along every edge it shares with the surrounding faces (that is what "same side" means for connected faces). Count rim edges where it does not; when most are wrong the whole cap is turned over.
        def rim_edges_state():
            ok_, bad_ = 0, 0
            for f in cap_faces:
                for lp in f.loops:
                    for nf in lp.edge.link_faces:
                        if nf in cap_set:
                            continue
                        l2 = next((x for x in nf.loops if x.edge == lp.edge), None)
                        if l2 is None:
                            continue
                        if l2.vert == lp.vert:
                            bad_ += 1
                        else:
                            ok_ += 1
            return ok_, bad_
        ok0, bad0 = rim_edges_state()
        turned = False
        if bad0 > ok0:
            bmesh.ops.reverse_faces(bm, faces=cap_faces)
            turned = True
        ok1, bad1 = rim_edges_state()
        flipped = bad1
        out["cap"] = {"faces": len(cap_faces), "triangles": sum(len(f.verts) - 2 for f in cap_faces), "material_index": mi, "style": L.param("cap_style", "ngon"), "flipped_normals": flipped, "rim_edges_consistent": ok1, "cap_turned_over": turned, "uv": "copied per vertex from the neighbouring faces (stretched)" if uvl is not None else "no UV layer"}
    out["holes"] = {"new_openings": len(comps), "vertices_per_opening": [len(c) for c in comps], "capped": bool(cap_faces), "vertices_welded_at_the_opening": welded}
    out["health_after"] = health(bm)
    bm.to_mesh(me)
    bm.free()
    me.update()
    if do_pics:
        bpy.context.view_layer.update()
        files += pics("after")
    out["pictures"] = [os.path.basename(f) for f in files]
    out["notes"] = ["only the new opening was capped: boundary that was open before stays open", "the removed faces' vertices that no other face uses were deleted; vertex groups of the rest are unchanged"]
    L.finish(out, save=True, files=files)


L.run(main)
