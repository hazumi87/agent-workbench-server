"""material_solid — give named meshes a SOLID PBR material (a base colour, roughness, metallic: no image files), keep it in the saved checkpoint, and prove that a GLB export carries it. Saves a checkpoint (not with dry_run). Geometry is never changed.

For a room blockout (or any meshes): paint the walls, door frames, cabinet and floor with plain colours. Each material is named; assigning the same name again UPDATES that material, so one colour can be changed for every mesh that uses it. Custom properties on the objects (for example blockout_status = estimated / inferred) are left as they are. export_kit and export_bind write whatever materials the meshes carry, so these colours go into their GLBs as baseColorFactor / roughnessFactor / metallicFactor (`verify_export` shows it).

params:
  assign    list of {"name": "paint-white", "objects": ["door_frame_1", "door_frame_2"], "match": "wall_*" (glob; optional, added to objects), "base_color": [r, g, b] or [r, g, b, a] (0..1, as you SEE them: sRGB unless `space` is "linear"),
              "roughness": 0.6 (default 0.5), "metallic": 0.0 (default), "slot": "all" (default: the material replaces every material slot of each mesh) | a slot number,
              "alpha": 0.15 (optional, 0..1: the Principled Alpha INPUT, i.e. real transparency: 1 = opaque, 0.15 = clear glass; also sets the blend mode to BLEND, so Cycles, the viewport and the GLB (alphaMode BLEND, baseColorFactor alpha) agree; omitted = the material's alpha is left as it is; the 4th number of `base_color` is NOT transparency: it only fills the colour socket's alpha channel)}
  select    (per assignment, ONE mesh in `objects`) give the material to CHOSEN FACES only: {"faces": [indices]} or filters ANDed: {"components": [piece numbers as face_orient numbers them], "box": [[xmin,ymin,zmin],[xmax,ymax,zmax]] (WORLD metres, faces whose centre is inside), "plane": {"point": [x,y,z], "normal": [nx,ny,nz], "dist_tol_m": 0.002, "angle_tol_deg": 2, "either_side": true} (WORLD: faces whose centre is near the plane and whose normal is parallel to it)}; `expect` {"faces": n} (nothing changes when the count differs). The material becomes a NEW slot of the mesh (or its existing slot when the mesh already has it) and only the chosen faces' material index changes: vertices, faces, positions, UV-at-corner pairs over every layer, smooth flags, corner normals and every unchosen face's slot are compared before and after and reported (`invariants`). A mesh with no material slot, or one shared with another object, is refused. `slot` is ignored. With dry_run the count and the faces are reported and nothing changes
  space     "srgb" (default: the colour is converted to Blender's linear base colour) | "linear"
  dry_run   true: nothing is changed; the report says which objects each material would go to and which names matched nothing
  verify_export  true (default): export the assigned objects to a scratch GLB and read it back: each material's baseColorFactor (linear), roughnessFactor, metallicFactor as the file has them
Refuses an object that is not a mesh, and a name that matches nothing (that assignment is skipped, the rest still happen).
Returns: materials (name, base colour in sRGB and linear, roughness, metallic, created or updated, the objects it went to), skipped, export_check (when verified), notes.
"""
import fnmatch
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def to_linear(c):
    c = np.array(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.array(c, float)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def read_glb_json(path):
    with open(path, "rb") as f:
        b = f.read()
    ln = struct.unpack_from("<I", b, 12)[0]
    return json.loads(b[20:20 + ln].decode("utf8"))


def pieces(me):
    """connected pieces (faces joined through shared vertices), numbered as face_orient / normals_edit number them: in order of their lowest vertex index; returns the piece of every polygon"""
    par = list(range(len(me.vertices)))

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for e in me.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            par[max(a, b)] = min(a, b)
    num, comp = {}, []
    used = set()
    for p in me.polygons:
        used.update(p.vertices)
    for v in sorted(used):
        r = find(v)
        if r not in num:
            num[r] = len(num)
    return [num[find(p.vertices[0])] for p in me.polygons], len(num)


def fingerprint(me):
    nl = len(me.loops)
    uv = {u.name: np.array([c.uv[:] for c in u.data]) for u in me.uv_layers}
    try:
        cn = np.array([n.vector[:] for n in me.corner_normals])
    except AttributeError:
        cn = None
    return {"counts": (len(me.vertices), len(me.edges), len(me.polygons), nl), "pos": np.array([v.co[:] for v in me.vertices]), "poly": [(p.loop_start, p.loop_total, tuple(p.vertices), p.use_smooth) for p in me.polygons],
            "uv": uv, "cn": cn}


def apply_select(ob, m, sel, expect, dry):
    me = ob.data
    if me.users > 1:
        raise RuntimeError(f"{ob.name}: the mesh is shared by {me.users} users; refusing")
    if not len(me.materials):
        raise RuntimeError(f"{ob.name}: has no material slot; give it a base material first")
    nf = len(me.polygons)
    mw = np.array(ob.matrix_world)
    M3, mt = mw[:3, :3], mw[:3, 3]
    if "faces" in sel:
        chosen = sorted({int(i) for i in sel["faces"]})
        bad = [i for i in chosen if not 0 <= i < nf]
        if bad:
            raise RuntimeError(f"select.faces: {bad[:5]} outside 0..{nf - 1}")
    else:
        if not any(k in sel for k in ("components", "box", "plane")):
            raise RuntimeError("select: give faces, or components / box / plane")
        keep = np.ones(nf, dtype=bool)
        if "components" in sel:
            comp, ncomp = pieces(me)
            want = {int(i) for i in sel["components"]}
            if any(not 0 <= i < ncomp for i in want):
                raise RuntimeError(f"select.components: outside 0..{ncomp - 1}")
            keep &= np.array([c in want for c in comp])
        cen = np.array([M3 @ np.array(p.center[:]) + mt for p in me.polygons])
        if "box" in sel:
            lo, hi = np.array(sel["box"][0], float), np.array(sel["box"][1], float)
            keep &= ((cen >= lo) & (cen <= hi)).all(axis=1)
        if "plane" in sel:
            pl = sel["plane"]
            pn = np.array(pl["normal"], float)
            pn /= np.linalg.norm(pn)
            pp = np.array(pl["point"], float)
            dt = float(pl.get("dist_tol_m", 0.002))
            at = np.cos(np.radians(float(pl.get("angle_tol_deg", 2.0))))
            fn = np.array([np.linalg.inv(M3).T @ np.array(p.normal[:]) for p in me.polygons])
            fn /= np.maximum(np.linalg.norm(fn, axis=1), 1e-30)[:, None]
            dots = fn @ pn
            okn = (np.abs(dots) >= at) if pl.get("either_side", True) else (dots >= at)
            keep &= (np.abs((cen - pp) @ pn) <= dt) & okn
        chosen = [int(i) for i in np.nonzero(keep)[0]]
    if not chosen:
        raise RuntimeError("select: nothing chosen")
    if expect and "faces" in expect and int(expect["faces"]) != len(chosen):
        raise RuntimeError(f"expect {expect['faces']} faces but {len(chosen)} chosen: nothing changed")
    old = {i: me.polygons[i].material_index for i in chosen}
    rep = {"object": ob.name, "faces_chosen": len(chosen), "faces_total": nf, "chosen_from_slots": {str(k): sum(1 for v in old.values() if v == k) for k in sorted(set(old.values()))}, "first_faces": chosen[:40]}
    ctr = np.array([M3 @ np.array(me.polygons[i].center[:]) + mt for i in chosen])
    rep["face_centres_world_min_max"] = [[round(float(x), 5) for x in ctr.min(axis=0)], [round(float(x), 5) for x in ctr.max(axis=0)]]
    if dry:
        rep["would_add_slot"] = m is None or m.name not in [x.name for x in me.materials if x]
        return rep
    before, midx = fingerprint(me), np.array([p.material_index for p in me.polygons])
    if m.name in [x.name for x in me.materials if x]:
        slot = [x.name if x else None for x in me.materials].index(m.name)
        rep["slot"], rep["slot_was_new"] = slot, False
    else:
        me.materials.append(m)
        slot = len(me.materials) - 1
        rep["slot"], rep["slot_was_new"] = slot, True
    for i in chosen:
        me.polygons[i].material_index = slot
    me.update()
    after, midx2 = fingerprint(me), np.array([p.material_index for p in me.polygons])
    unch = np.ones(nf, bool)
    unch[chosen] = False
    rep["invariants"] = {"counts_unchanged": before["counts"] == after["counts"], "positions_unchanged": bool(np.array_equal(before["pos"], after["pos"])), "polygon_topology_and_smooth_unchanged": before["poly"] == after["poly"],
                         "uv_unchanged": all(np.array_equal(before["uv"][k], after["uv"][k]) for k in before["uv"]) and set(before["uv"]) == set(after["uv"]), "corner_normals_unchanged": (None if before["cn"] is None else bool(np.array_equal(before["cn"], after["cn"]))),
                         "unchosen_faces_slot_unchanged": bool(np.array_equal(midx[unch], midx2[unch])), "chosen_faces_now_on_slot": int((midx2[chosen] == slot).sum()), "unchosen_faces_on_that_slot": int((midx2[unch] == slot).sum())}
    return rep


def main():
    asg = L.param("assign") or []
    if not asg:
        raise RuntimeError('give assign: [{"name": "paint-white", "objects": [...], "base_color": [0.82, 0.82, 0.8], "roughness": 0.6}]')
    dry = bool(L.param("dry_run", False))
    space = L.param("space", "srgb")
    out, skipped, touched = {}, [], []
    for a in asg:
        nm = a["name"]
        names = list(a.get("objects", []))
        if a.get("match"):
            names += [o.name for o in bpy.data.objects if o.type == "MESH" and fnmatch.fnmatch(o.name, a["match"]) and o.name not in names]
        objs = []
        for on in names:
            o = bpy.data.objects.get(on)
            if o is None:
                skipped.append({"assignment": nm, "object": on, "why": "no such object"})
            elif o.type != "MESH":
                skipped.append({"assignment": nm, "object": on, "why": f"a {o.type}, not a mesh"})
            else:
                objs.append(o)
        if not objs:
            skipped.append({"assignment": nm, "why": "matched no mesh: skipped"})
            continue
        bc = list(a["base_color"]) + ([1.0] if len(a["base_color"]) == 3 else [])
        lin = to_linear(bc[:3]) if space == "srgb" else np.array(bc[:3], float)
        sr = to_srgb(lin)
        rough, metal = float(a.get("roughness", 0.5)), float(a.get("metallic", 0.0))
        m = bpy.data.materials.get(nm)
        existed = m is not None
        if not dry:
            if m is None:
                m = bpy.data.materials.new(nm)
            m.use_nodes = True
            b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if b is None:
                m.node_tree.nodes.clear()
                b = m.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
                o_ = m.node_tree.nodes.new("ShaderNodeOutputMaterial")
                m.node_tree.links.new(b.outputs["BSDF"], o_.inputs["Surface"])
            for lk in list(m.node_tree.links):
                if lk.to_node == b and lk.to_socket.name in ("Base Color", "Roughness", "Metallic"):
                    m.node_tree.links.remove(lk)  # a solid colour: no image feeds these
            b.inputs["Base Color"].default_value = (float(lin[0]), float(lin[1]), float(lin[2]), float(bc[3]))
            b.inputs["Roughness"].default_value = rough
            b.inputs["Metallic"].default_value = metal
            m.diffuse_color = (float(lin[0]), float(lin[1]), float(lin[2]), float(bc[3]))
            if a.get("alpha") is not None:
                al = float(a["alpha"])
                if not 0.0 <= al <= 1.0:
                    raise RuntimeError(f"{nm}: alpha must be 0..1, not {al}")
                for lk in list(m.node_tree.links):
                    if lk.to_node == b and lk.to_socket.name == "Alpha":
                        m.node_tree.links.remove(lk)  # a constant alpha: no image feeds it
                b.inputs["Alpha"].default_value = al
                mode = "BLEND" if al < 0.999 else "OPAQUE"
                for attr, val in (("blend_method", mode), ("surface_render_method", "BLENDED" if al < 0.999 else "DITHERED")):
                    try:
                        setattr(m, attr, val)
                    except (AttributeError, TypeError):
                        pass
                try:
                    m.use_backface_culling = False
                    m.show_transparent_back = False  # sorted per object; stops panes drawing through each other
                except AttributeError:
                    pass
            m.roughness, m.metallic = rough, metal
            slot = a.get("slot", "all")
            for o in ([] if a.get("select") is not None else objs):
                me = o.data
                if slot == "all" or not len(me.materials):
                    me.materials.clear()
                    me.materials.append(m)
                else:
                    me.materials[int(slot)] = m
                touched.append(o)
        sel_rep = None
        if a.get("select") is not None:
            if len(objs) != 1:
                raise RuntimeError(f"{nm}: select needs exactly one mesh in objects (got {len(objs)})")
            sel_rep = apply_select(objs[0], m, a["select"], a.get("expect"), dry)
            if not dry:
                touched.append(objs[0])
        out[nm] = {**({"select": sel_rep} if sel_rep else {}), "action": ("would_update" if existed else "would_create") if dry else ("updated" if existed else "created"), "base_color_srgb": [round(float(x), 4) for x in sr] + [bc[3]], "base_color_linear": [round(float(x), 5) for x in lin],
                   "roughness": rough, "metallic": metal, **({"alpha": float(a["alpha"])} if a.get("alpha") is not None else {}), "objects": [o.name for o in objs]}
    chk = None
    if not dry and touched and L.param("verify_export", True):
        os.makedirs(L.ARGS["out_dir"], exist_ok=True)
        p = os.path.join(L.ARGS["out_dir"], "material_solid-check.glb")
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        for o in touched:
            o.select_set(True)
        bpy.context.view_layer.objects.active = touched[0]
        bpy.ops.export_scene.gltf(filepath=p, export_format="GLB", use_selection=True, use_active_scene=True, export_apply=False, export_animations=False, export_skins=False)  # active scene only: the other (archive__) scenes were exported too
        js = read_glb_json(p)
        chk = {"file": os.path.basename(p), "materials": {mm.get("name"): {"baseColorFactor": [round(x, 5) for x in mm.get("pbrMetallicRoughness", {}).get("baseColorFactor", [])], "roughnessFactor": mm.get("pbrMetallicRoughness", {}).get("roughnessFactor"),
                                                                       "metallicFactor": mm.get("pbrMetallicRoughness", {}).get("metallicFactor"), "has_texture": "baseColorTexture" in mm.get("pbrMetallicRoughness", {}), "alphaMode": mm.get("alphaMode", "OPAQUE")} for mm in js.get("materials", [])}, "meshes_exported": len(js.get("meshes", [])),
               "primitives": [{"mesh": mh.get("name"), "primitive": k, "material": (js["materials"][pr["material"]].get("name") if pr.get("material") is not None else None), "indices": (js["accessors"][pr["indices"]]["count"] if pr.get("indices") is not None else None), "triangles": (js["accessors"][pr["indices"]]["count"] // 3 if pr.get("indices") is not None else None), "attributes": sorted(pr.get("attributes", {}))} for mh in js.get("meshes", []) for k, pr in enumerate(mh.get("primitives", []))]}
    L.finish({"materials": out, "skipped": skipped, "export_check": chk, "dry_run": dry, "notes": ["geometry and the objects' custom properties (e.g. blockout_status) are untouched", "base_color_linear is what Blender stores and the GLB's baseColorFactor carries"]}, save=not dry)


L.run(main)
