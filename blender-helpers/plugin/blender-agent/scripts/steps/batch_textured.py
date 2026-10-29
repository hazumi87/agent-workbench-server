"""batch_textured — merge many static TEXTURED meshes into a few, one per material (and per grid cell), keeping every UV layer, the material (so alpha mode and textures stay) and the world position. Saves a checkpoint (not with dry_run). Opt-in and limited to the `roots` you name: scene_optimize leaves textured meshes alone, this is the verb for them.

Run it on a COPY of the assembly (job_copy, verb 87); the earlier checkpoint keeps the separate objects. Only meshes UNDER the named roots that are in the WORKING scene are merged (objects set aside by scene_archive are ignored and untouched; the report counts them as `archived_objects_ignored`); everything else, every empty, light, bulb assembly and louver stays as it is. Triangles are not reduced (use decimate_textured first); this only cuts draw calls and nodes.
Each merged mesh is named `tex__<root>__<material>[__<cx>_<cy>]` and parented to the root it came from (world position unchanged). Faces keep their material, their smooth/flat state and every UV layer by name (an object lacking a layer gets (0,0) there, counted in the report). Custom split normals are CARRIED by default (`keep_normals`): every merged loop gets its source's shading normal (turned into the root's frame), so a rounded or foliage-shaded mesh keeps its look; vertex colours are not carried (the report counts the sources that had them).
params:
  roots    names of the empties (or objects) whose descendants are merged, e.g. ["SiteYard"]   [required]
  protect  name globs never merged (default ["Louver_*", "Louvers_*", "*louver*", "bulb_*"]); animated objects, lights and empties are never merged
  only_textured  true (default): only meshes that use an image texture; false: every static mesh under the roots
  cell_m   0 (default): one mesh per root+material; a number such as 10: also split by a square grid of that size in the world XY plane, so a runtime can still cull far parts
  keep_normals  true (default): keep the shading normals (custom split normals; for sources without them, the normals Blender computes from their smooth/flat faces) when ANY source in a merged mesh has custom normals. false: the old behaviour (normals dropped: smooth/flat only).
  dry_run  true: the plan only (groups, counts), nothing changes
Returns: before / after (mesh objects, triangles, materials used), `groups` (name, material, source objects, triangles, bounding box), `checks` (triangles equal before and after, material count equal, each group's world bounding box against its sources, in mm), `left` (what was not merged and why).
"""
import fnmatch
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402


def tris_of(me, mi=None):
    return sum(len(p.vertices) - 2 for p in me.polygons if mi is None or p.material_index == mi)


def has_image(o):
    return any(m and m.use_nodes and any(n.type == "TEX_IMAGE" for n in m.node_tree.nodes) for m in o.data.materials)


def animated(o):
    ad = o.animation_data
    return bool(ad and (ad.action or ad.nla_tracks))


def mats_slots(objs):
    return {m.name for o in objs for m in o.data.materials if m}


def mats_faces(objs):
    """materials that at least one face uses (a slot with no face does not count)"""
    out = set()
    for o in objs:
        used = {p.material_index for p in o.data.polygons}
        for mi in used:
            if mi < len(o.data.materials) and o.data.materials[mi]:
                out.add(o.data.materials[mi].name)
    return out


def wbox(pts):
    return [min(p[i] for p in pts) for i in range(3)], [max(p[i] for p in pts) for i in range(3)]


def main():
    dry = bool(L.param("dry_run", False))
    roots_n = L.param("roots")
    if not roots_n:
        raise RuntimeError("roots: name the empties to merge under, e.g. [\"SiteYard\"]")
    scn = bpy.context.scene
    live = set(scn.objects)   # only objects of the working scene: a child set aside by scene_archive keeps its parent link but is NOT merged
    roots = []
    for n in roots_n:
        r = bpy.data.objects.get(n)
        if r is None:
            raise RuntimeError(f"roots: no object named {n!r}")
        if r not in live:
            raise RuntimeError(f"roots: {n!r} is not in the working scene (archived?)")
        roots.append(r)
    protect = L.param("protect") or ["Louver_*", "Louvers_*", "*louver*", "bulb_*"]
    only_tex = L.param("only_textured", True)
    cell = float(L.param("cell_m", 0))
    bpy.context.view_layer.update()
    allm = [o for o in scn.objects if o.type == "MESH" and "blender_agent_marker" not in o]
    before = {"mesh_objects": len(allm), "triangles": sum(tris_of(o.data) for o in allm),
              "materials_used": len({m.name for o in allm for m in o.data.materials if m})}
    slots0, faces0 = mats_slots(allm), mats_faces(allm)
    groups, left = {}, []
    archived_skipped = 0
    for r in roots:
        for o in r.children_recursive:
            if o not in live:
                archived_skipped += 1
                continue
            if o.type != "MESH" or "blender_agent_marker" in o:
                continue
            why = None
            if animated(o):
                why = "animated"
            elif any(fnmatch.fnmatchcase(o.name, p) for p in protect):
                why = "protected name"
            elif only_tex and not has_image(o):
                why = "no image texture"
            if why:
                left.append({"name": o.name, "why": why})
                continue
            c = o.matrix_world @ Vector(sum((Vector(b) for b in o.bound_box), Vector()) / 8.0)
            cx, cy = (math.floor(c.x / cell), math.floor(c.y / cell)) if cell > 0 else (0, 0)
            for mi in sorted({p.material_index for p in o.data.polygons}):
                mat = o.data.materials[mi] if mi < len(o.data.materials) else None
                key = (r.name, mat, cx, cy)
                groups.setdefault(key, []).append((o, mi))
    rows = []
    for (rn, mat, cx, cy), lst in groups.items():
        nm = f"tex__{rn}__{mat.name if mat else 'none'}" + (f"__{cx}_{cy}" if cell > 0 else "")
        rows.append({"name": nm, "root": rn, "material": mat.name if mat else None, "source_objects": len({o.name for o, _ in lst}),
                     "triangles": sum(tris_of(o.data, mi) for o, mi in lst)})
    plan = {"archived_objects_ignored": archived_skipped, "merged_source_objects": len({o.name for lst in groups.values() for o, _ in lst}), "groups": len(rows),
            "triangles_in_groups": sum(r["triangles"] for r in rows)}
    if dry:
        L.finish({"dry_run": True, "before": before, **plan}, save=False, group_rows=rows[:200], left=left[:200])
        return
    made, checks_bbox = [], []
    n_nolayer = 0
    normals_src, vcol_src = set(), set()
    keep_n = bool(L.param("keep_normals", True))
    kept_max_diff = 0.0
    kept_groups = 0
    for (rn, mat, cx, cy), lst in groups.items():
        par = bpy.data.objects[rn]
        inv = par.matrix_world.inverted()
        bm = bmesh.new()
        layers = {}
        for o, _ in lst:
            for u in o.data.uv_layers:
                if u.name not in layers:
                    layers[u.name] = bm.loops.layers.uv.new(u.name)
        src_pts = []
        cn = []
        want_n = keep_n and any(o.data.has_custom_normals for o, _ in lst)
        for o, mi in lst:
            me = o.data
            M = inv @ o.matrix_world
            NM = M.to_3x3().inverted_safe().transposed()
            if me.has_custom_normals:
                normals_src.add(o.name)
            if me.color_attributes:
                vcol_src.add(o.name)
            n_nolayer += sum(1 for k in layers if k not in me.uv_layers)
            vmap = {}
            for p in me.polygons:
                if p.material_index != mi:
                    continue
                vs = []
                for vi in p.vertices:
                    if vi not in vmap:
                        vmap[vi] = bm.verts.new(M @ me.vertices[vi].co)
                        src_pts.append(o.matrix_world @ me.vertices[vi].co)
                    vs.append(vmap[vi])
                try:
                    f = bm.faces.new(vs)
                except ValueError:
                    continue
                f.smooth = p.use_smooth
                if want_n:
                    for li in p.loop_indices:
                        cn.append((NM @ me.corner_normals[li].vector).normalized()[:])
                for k, lay in layers.items():
                    src = me.uv_layers.get(k)
                    if src is None:
                        continue
                    for li, loop in zip(p.loop_indices, f.loops):
                        loop[lay].uv = src.data[li].uv
        nm = next(r["name"] for r in rows if r["root"] == rn and r["material"] == (mat.name if mat else None) and (cell <= 0 or r["name"].endswith(f"__{cx}_{cy}")))
        me2 = bpy.data.meshes.new(nm)
        bm.to_mesh(me2)
        bm.free()
        if want_n and len(cn) == len(me2.loops):
            me2.normals_split_custom_set(cn)
            kept_groups += 1
            for li in range(0, len(cn), max(1, len(cn) // 2000)):
                a, b = me2.corner_normals[li].vector, Vector(cn[li])
                kept_max_diff = max(kept_max_diff, math.degrees(a.angle(b, 0.0)))
        elif want_n:
            normals_src.add(f"{nm}: loop count mismatch, normals NOT kept")
        if mat is not None:
            me2.materials.append(mat)
        ob = bpy.data.objects.new(nm, me2)
        scn.collection.objects.link(ob)
        ob.parent = par
        ob.matrix_parent_inverse = Matrix.Identity(4)
        ob["batch_textured"] = True
        made.append(ob)
        bpy.context.view_layer.update()
        if src_pts and len(me2.vertices):
            a, b = wbox(src_pts)
            c, d = wbox([ob.matrix_world @ v.co for v in me2.vertices])
            checks_bbox.append(max(abs(x - y) for x, y in zip(a + b, c + d)) * 1000)
    gone = {o.name for lst in groups.values() for o, _ in lst}
    for nm in sorted(gone):
        o = bpy.data.objects.get(nm)
        if o is None:
            continue
        d = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if d is not None and d.users == 0:
            bpy.data.meshes.remove(d)
    bpy.context.view_layer.update()
    allm2 = [o for o in scn.objects if o.type == "MESH" and "blender_agent_marker" not in o]
    after = {"mesh_objects": len(allm2), "triangles": sum(tris_of(o.data) for o in allm2),
             "materials_used": len({m.name for o in allm2 for m in o.data.materials if m})}
    slots1, faces1 = mats_slots(allm2), mats_faces(allm2)
    checks = {"triangles_equal": after["triangles"] == before["triangles"], "materials_with_faces_equal": faces0 == faces1,
              "materials_lost_with_faces": sorted(faces0 - faces1), "materials_in_slots_lost": sorted(slots0 - slots1),
              "materials_in_slots_lost_had_no_faces": sorted((slots0 - slots1) - faces0),
              "materials_equal": slots0 == slots1,
              "max_group_bbox_change_mm": round(max(checks_bbox or [0]), 4), "uv_layers_missing_on_a_source": n_nolayer,
              "sources_with_custom_normals": len(normals_src), "keep_normals": keep_n, "merged_meshes_with_carried_normals": kept_groups, "carried_normals_max_diff_deg_sampled": round(kept_max_diff, 3), "sources_with_custom_normals_dropped": 0 if keep_n and kept_groups else len(normals_src), "sources_with_vertex_colours_dropped": len(vcol_src), "counts_are_distinct_source_objects": True}
    for o in made:
        for r in rows:
            if r["name"] == o.name:
                r["triangles_after"] = tris_of(o.data)
    L.finish({"dry_run": False, "before": before, "after": after, **plan, "checks": checks}, save=True, group_rows=rows[:200], left=left[:200])


L.run(main)
