"""bulbs_make — build string-light BULB ASSEMBLIES, each one a named group of parts with its own point light, parented under a Lighting root. Saves a checkpoint (not with dry_run).

One assembly `bulb_<id>` (an empty at the mount's attachment point, +Z up, hanging DOWN from there):
  bulb_<id>.mount     a rectangular plastic mount (box)            (left out when the bulb has "mount": false)
  bulb_<id>.wire_a / bulb_<id>.wire_b   two thin cylinders hanging from the mount down to the socket
  bulb_<id>.socket    the plastic socket (cylinder)
  bulb_<id>.diffuser  the white plastic bulb (UV sphere) with its OWN material `bulb_diffuser_<id>`: white, emission colour white at strength 0 -> change the material's emission to light the bulb up
  bulb_<id>.light     a Blender POINT light at the centre of the diffuser (energy W, colour, radius)
Every name is unique and stable; the assemblies are parented under `Lighting` (made when missing). The mount / wire / socket share the materials bulb_mount_plastic, bulb_wire and bulb_socket_plastic.
Frame: world, Z up, metres (`units` "m" default or "mm" for every number).
params:
  bulbs        list of {"id": "A-01", "at": [x, y, z] (mount attachment point), "emission": 0.0 (the diffuser material's emission strength, 0 = off), "mount": true, "drop_mm": 650 (this bulb only), "yaw_deg": 0 (turns the mount about Z)}; or
  positions_file   a JSON file {"A-01": [x, y, z], ...} or [{"id": "A-01", "at": [x, y, z]}, ...] (a path under the tool root, absolute, or "out:<file>"), the same units; both may be given, `bulbs` wins on the same id
  bulb_shape   "sphere" (default) | "pear" (a teardrop: narrow neck at the socket, widest at about 60 % of its height, round bottom); bulb_height_mm: the pear's height (default 80); pear_neck_r_mm: its neck radius (default 10)
  wire_bow_mm  how far each wire bows OUTWARD at mid-length (default 0 = straight)
  mount_colour, socket_colour, wire_colour, diffuser_colour   [r, g, b] 0-1 (defaults: pale mount [0.82, 0.8, 0.74], black socket and wires, white diffuser)
  emission     emission strength every diffuser starts with (default 0 = off; a bulb's own "emission" wins)
  mount_mm     [width, depth, height] of the mount (default [34, 22, 14])
  wire_r_mm    wire radius (default 0.8); wire_gap_mm: distance between the two wires (default 14); drop_mm: from the mount's bottom to the top of the socket (default 600)
  socket_mm    [radius, height] (default [9, 16]); bulb_r_mm: the diffuser's largest radius (default 28)
  light        {"energy_w": 6.0 (or "intensity_cd": 7: the glTF file stores candela, and W = cd x 4 pi / 683; the report gives both), "colour": [1, 1, 1], "radius_mm": 25, "shadow": false}
  parent_root  the group the assemblies go under (default "Lighting")
  replace      true: rebuild an assembly of the same id that this verb made (default false: an existing one is left as it is and reported)
  diffuser_blocks_light  false (default): the diffuser does not cast shadows, so the light inside it reaches its surroundings in Cycles; true: it is a normal shadow-casting shell (it then blocks the light inside)
  spill_test   true: after building, a Cycles check on the first built bulb: a grey plane 0.4 m below it, black world, is rendered with the diffuser as built, with the diffuser blocking and with no diffuser; the brightnesses are reported (spill_test)
  views        clay pictures: "iso" | "front" | "top" (default ["iso", "front"]); res px (default 640)
  dry_run      true: nothing is made; the report lists what would be built
Returns: built / existing / refused ids, per-assembly part names, the triangle count of one assembly, bounds of the set, pictures.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402
import _handview as HV  # noqa: E402

MM = 0.001


def mat(name, rgba, rough=0.5, emit=None):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    m.diffuse_color = rgba
    if emit is not None:
        b.inputs["Emission Color"].default_value = emit
        b.inputs["Emission Strength"].default_value = 0.0
    return m


def mesh_obj(name, bm, material, parent):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    me.materials.append(material)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    return o


def box(w, d, h):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((w, d, h)), verts=bm.verts)
    return bm


def cyl(r, h, seg=12):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=h)
    return bm


def sphere(r, us=16, vs=10):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=us, v_segments=vs, radius=r)
    return bm


def tube(pts, r, seg=8):
    """a thin tube along the polyline `pts` (list of Vector), closed at both ends"""
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        u = t.cross(Vector((1, 0, 0)) if abs(t.x) < 0.9 else Vector((0, 1, 0))).normalized()
        v = t.cross(u)
        rings.append([bm.verts.new(p + (u * math.cos(2 * math.pi * k / seg) + v * math.sin(2 * math.pi * k / seg)) * r) for k in range(seg)])
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(seg):
            bm.faces.new([a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]])
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def pear(R, H, rn, steps=16):
    """a pear / teardrop bulb: a surface of revolution about Z, narrow neck at the top (z = +H/2), widest at about 60 % of the height, rounded bottom (z = -H/2)"""
    prof = [(0.0, 0.0), (rn, 0.0), (rn * 1.15, 0.06), (0.5 * R, 0.17), (0.82 * R, 0.33), (R, 0.55), (0.88 * R, 0.76), (0.55 * R, 0.91), (0.0, 1.0)]
    bm = bmesh.new()
    vs = [bm.verts.new(Vector((x, 0.0, H / 2 - t * H))) for x, t in prof]
    for a, b in zip(vs[:-1], vs[1:]):
        bm.edges.new((a, b))
    bmesh.ops.spin(bm, geom=bm.verts[:] + bm.edges[:], cent=(0, 0, 0), axis=(0, 0, 1), angle=2 * math.pi, steps=steps, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def positions():
    k = 0.001 if L.param("units", "m") == "mm" else 1.0
    out = {}
    pf = L.param("positions_file")
    if pf:
        path = os.path.join(L.ARGS["out_dir"], pf[4:]) if pf.startswith("out:") else L.resolve(pf, what="positions_file")
        data = json.load(open(path, encoding="utf8"))
        rows = data if isinstance(data, list) else [{"id": i, "at": v} for i, v in data.items()]
        for r in rows:
            out[str(r["id"])] = {"id": str(r["id"]), "at": r["at"]}
    for b in L.param("bulbs") or []:
        out[str(b["id"])] = {**out.get(str(b["id"]), {}), **b, "id": str(b["id"])}
    for b in out.values():
        b["at"] = [float(x) * k for x in b["at"]]
        if "drop_mm" in b:
            b["drop_mm"] = float(b["drop_mm"])
    return out


def spill_test(bid):
    """Cycles check on ONE built bulb: the mean brightness a neutral grey plane 0.4 m below the diffuser receives (black world, nothing else lit) with the diffuser as built (not blocking), with the diffuser blocking light (shadow on) and without a diffuser: a bulb whose number is far below the 'no diffuser' one cannot light its surroundings"""
    import numpy as np
    scn = bpy.context.scene
    name = f"bulb_{bid}"
    dif = bpy.data.objects[f"{name}.diffuser"]
    ld = bpy.data.objects[f"{name}.light"].data
    ld_keep = (ld.energy, ld.use_shadow)
    ld.energy, ld.use_shadow = 6.0, True  # the test always runs at a fixed 6 W with the light's shadows ON (the hard case), whatever the bulb's own power: at a real bulb power the plane is too dark to compare
    keep = {"engine": scn.render.engine, "world": scn.world, "res": (scn.render.resolution_x, scn.render.resolution_y), "cam": scn.camera, "vt": scn.view_settings.view_transform, "samples": scn.cycles.samples}
    bpy.context.view_layer.update()
    c = dif.matrix_world.translation.copy()
    w = bpy.data.worlds.new("spill-black")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0, 0, 0, 1)
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    scn.world = w
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = 24
    scn.view_settings.view_transform = "Standard"
    scn.render.resolution_x = scn.render.resolution_y = 96
    scn.render.image_settings.file_format = "PNG"
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.4)
    pl = bpy.data.objects.new("spill-plane", bpy.data.meshes.new("spill-plane"))
    bm.to_mesh(pl.data)
    bm.free()
    pm = bpy.data.materials.new("spill-grey")
    pm.use_nodes = True
    pm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
    pl.data.materials.append(pm)
    scn.collection.objects.link(pl)
    pl.location = (c.x, c.y, c.z - 0.4)
    cam = bpy.data.objects.new("spill-cam", bpy.data.cameras.new("spill-cam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 0.8
    scn.collection.objects.link(cam)
    cam.location = (c.x, c.y, c.z - 0.4 + 0.25)
    cam.rotation_euler = (0, 0, 0)
    scn.camera = cam
    others = [o for o in scn.objects if o.type == "LIGHT" and o.name != f"{name}.light"]
    for o in others:
        o.hide_render = True
    out = {}
    path = os.path.join(L.ARGS["out_dir"], "spill.png")
    for label, vis, hidden in (("as_built", dif.visible_shadow, False), ("diffuser_blocking", True, False), ("no_diffuser", dif.visible_shadow, True)):
        dif.visible_shadow, dif.hide_render = vis, hidden
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)
        im = bpy.data.images.load(path)
        a = np.array(im.pixels[:]).reshape(-1, 4)[:, :3].mean()
        bpy.data.images.remove(im)
        out[label] = round(float(a), 5)
    dif.visible_shadow, dif.hide_render = bool(L.param("diffuser_blocks_light", False)), False
    ld.energy, ld.use_shadow = ld_keep
    for o in others:
        o.hide_render = False
    for o in (pl, cam):
        bpy.data.objects.remove(o, do_unlink=True)
    scn.world = keep["world"]
    bpy.data.worlds.remove(w)
    scn.render.engine, scn.camera, scn.view_settings.view_transform = keep["engine"], keep["cam"], keep["vt"]
    scn.render.resolution_x, scn.render.resolution_y = keep["res"]
    scn.cycles.samples = keep["samples"]
    out["note"] = "mean pixel value (0-1, Standard view) of a grey plane 0.4 m below the diffuser, black world; the light is set to 6 W with shadows ON for the test and put back; as_built = this verb's setting"
    return out


def main():
    dry = bool(L.param("dry_run", False))
    replace = bool(L.param("replace", False))
    scn = bpy.context.scene
    factory_removed = L.drop_factory_objects() if not L.param('dry_run', False) else []
    mount_mm = [float(x) for x in L.param("mount_mm", [34, 22, 14])]
    wire_r, wire_gap = float(L.param("wire_r_mm", 0.8)) * MM, float(L.param("wire_gap_mm", 14)) * MM
    drop_default = float(L.param("drop_mm", 600))
    sock_r, sock_h = [float(x) * MM for x in L.param("socket_mm", [9, 16])]
    bulb_r = float(L.param("bulb_r_mm", 28)) * MM
    lt = {"energy_w": 6.0, "colour": [1, 1, 1], "radius_mm": 25, "shadow": False, **(L.param("light") or {})}
    if "intensity_cd" in (L.param("light") or {}):  # the glTF file stores candela: W = cd * 4 pi / 683 (the exporter's standard conversion)
        lt["energy_w"] = float(lt["intensity_cd"]) * 4 * math.pi / 683.0
    root_name = L.param("parent_root", "Lighting")
    bulbs = positions()
    if not bulbs:
        raise RuntimeError("give `bulbs` or `positions_file`")
    rep = {"built": [], "existing": [], "refused": []}
    root = bpy.data.objects.get(root_name)
    if root is not None and root.type != "EMPTY":
        raise RuntimeError(f"{root_name} exists and is not an empty: give another parent_root")
    if not dry and root is None:
        root = bpy.data.objects.new(root_name, None)
        root["scene_tree_made"] = True
        scn.collection.objects.link(root)
    col = lambda key, d: tuple([float(x) for x in (L.param(key) or d)][:3]) + (1.0,)  # noqa: E731
    m_mount = mat("bulb_mount_plastic", col("mount_colour", (0.82, 0.80, 0.74)), 0.6)
    m_wire = mat("bulb_wire", col("wire_colour", (0.02, 0.02, 0.02)), 0.7)
    m_sock = mat("bulb_socket_plastic", col("socket_colour", (0.02, 0.02, 0.02)), 0.5)
    shape = L.param("bulb_shape", "sphere")
    if shape not in ("sphere", "pear"):
        raise RuntimeError('bulb_shape must be "sphere" or "pear"')
    pear_h = float(L.param("bulb_height_mm", 80)) * MM
    pear_rn = float(L.param("pear_neck_r_mm", 10)) * MM
    bow = float(L.param("wire_bow_mm", 0.0)) * MM
    diff_col = col("diffuser_colour", (0.95, 0.95, 0.95))
    parts_example = None
    for bid, b in bulbs.items():
        name = f"bulb_{bid}"
        ex = bpy.data.objects.get(name)
        if ex is not None and "bulbs_make" not in ex:
            rep["refused"].append({"id": bid, "why": f"an object named {name} exists and was not made by bulbs_make"})
            continue
        if ex is not None and not replace:
            rep["existing"].append(bid)
            continue
        has_mount = b.get("mount", True)
        drop = float(b.get("drop_mm", drop_default)) * MM
        parts = [f"{name}.mount"] * bool(has_mount) + [f"{name}.wire_a", f"{name}.wire_b", f"{name}.socket", f"{name}.diffuser", f"{name}.light"]
        rep["built"].append({"id": bid, "at_m": [round(x, 4) for x in b["at"]], "parts": parts, "mount": bool(has_mount), "drop_mm": round(drop / MM, 1)})
        parts_example = parts_example or parts
        if dry:
            continue
        if ex is not None:  # replace: remove the old assembly (own parts only)
            for c in list(ex.children_recursive):
                data = c.data
                bpy.data.objects.remove(c, do_unlink=True)
                if data is not None and data.users == 0:
                    (bpy.data.meshes if isinstance(data, bpy.types.Mesh) else bpy.data.lights).remove(data)
            bpy.data.objects.remove(ex, do_unlink=True)
        o = bpy.data.objects.new(name, None)
        o.empty_display_type = "PLAIN_AXES"
        o.empty_display_size = 0.03
        o["bulbs_make"] = True
        o["bulb_id"] = bid
        scn.collection.objects.link(o)
        o.location = Vector(b["at"])
        o.rotation_euler = (0, 0, math.radians(float(b.get("yaw_deg", 0))))
        o.parent = root
        o.matrix_parent_inverse = root.matrix_world.inverted()
        mh = mount_mm[2] * MM if has_mount else 0.0
        if has_mount:
            mo = mesh_obj(f"{name}.mount", box(mount_mm[0] * MM, mount_mm[1] * MM, mount_mm[2] * MM), m_mount, o)
            mo.location = (0, 0, -mh / 2)
        top_z = -mh
        for tag, sx in (("wire_a", -wire_gap / 2), ("wire_b", wire_gap / 2)):
            if bow > 0:
                sg = 1.0 if sx > 0 else -1.0
                path = [Vector((sx + sg * bow * math.sin(math.pi * k / 8), 0, top_z - drop * k / 8)) for k in range(9)]
                w = mesh_obj(f"{name}.{tag}", tube(path, wire_r, 6), m_wire, o)
            else:
                w = mesh_obj(f"{name}.{tag}", cyl(wire_r, drop, 8), m_wire, o)
                w.location = (sx, 0, top_z - drop / 2)
        so = mesh_obj(f"{name}.socket", cyl(sock_r, sock_h, 12), m_sock, o)
        so.location = (0, 0, top_z - drop - sock_h / 2)
        dm = mat(f"bulb_diffuser_{bid}", diff_col, 0.35, emit=(1, 1, 1, 1))
        pb = next(n for n in dm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        pb.inputs["Emission Strength"].default_value = float(b.get("emission", L.param("emission", 0.0)))
        if shape == "pear":
            dif = mesh_obj(f"{name}.diffuser", pear(bulb_r, pear_h, pear_rn), dm, o)
            cz = top_z - drop - sock_h - pear_h / 2 + 0.003
        else:
            dif = mesh_obj(f"{name}.diffuser", sphere(bulb_r), dm, o)
            cz = top_z - drop - sock_h - bulb_r * 0.85
        dif.location = (0, 0, cz)
        for p in dif.data.polygons:
            p.use_smooth = True
        dif.visible_shadow = bool(L.param("diffuser_blocks_light", False))  # the point light sits INSIDE the diffuser: if the closed white shell cast shadows it would block the light in Cycles
        ld = bpy.data.lights.new(f"{name}.light", "POINT")
        ld.energy = float(lt["energy_w"])
        ld.color = tuple(lt["colour"][:3])
        ld.shadow_soft_size = float(lt["radius_mm"]) * MM
        ld.use_shadow = bool(lt.get("shadow", False))
        lo = bpy.data.objects.new(f"{name}.light", ld)
        scn.collection.objects.link(lo)
        lo.parent = o
        lo.location = (0, 0, cz)
        for ob in [x for x in o.children_recursive]:
            ob.matrix_parent_inverse = Matrix.Identity(4)
    bpy.context.view_layer.update()  # new objects have no world matrix until the layer is updated
    files = []
    if not dry and L.param("views", ["iso", "front"]):
        objs = [x for x in scn.objects if x.name.startswith("bulb_")]
        pts = [Vector(x.matrix_world.translation) for x in objs if x.parent is None or x.parent is root]
        if pts:
            lo_ = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
            hi_ = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
            ctr = (lo_ + hi_) / 2 - Vector((0, 0, 0.3))
            size = max((hi_ - lo_).length * 1.2 + 0.45, 0.5)
            dirs = {"iso": (0.6, -0.8, 0.5), "front": (0, -1, 0.05), "top": (0, 0, 1)}
            sel = {v: dirs[v] for v in L.param("views", ["iso", "front"]) if v in dirs}
            files = HV.render_views([x for x in scn.objects if x.type in ("MESH",) and x.name.startswith("bulb_")], ctr, size, "bulbs", res=int(L.param("res", 640)), dirs=sel)
    spill = None
    if not dry and L.param("spill_test", False) and rep["built"]:
        spill = spill_test(rep["built"][0]["id"])
    ntri = None
    if parts_example and not dry:
        first = f"bulb_{rep['built'][0]['id']}"
        ntri = sum(sum(len(p.vertices) - 2 for p in c.data.polygons) for c in bpy.data.objects[first].children if c.type == "MESH")
    L.finish({"dry_run": dry, "built": len(rep["built"]), "existing": len(rep["existing"]), "refused": len(rep["refused"]), "triangles_per_assembly": ntri, "spill_test": spill, "light_energy_w": round(float(lt["energy_w"]), 5), "light_intensity_cd_in_glb": round(float(lt["energy_w"]) * 683 / (4 * math.pi), 3)}, save=not dry, files=files, **rep, factory_removed=factory_removed, pictures=[os.path.basename(f) for f in files])


L.run(main)
