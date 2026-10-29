"""dev_texelprobe — DEV TOOL (read-only, saves nothing): on a checkpoint that already carries the LightmapUV layer of a bake, bake `receiver` alone with Cycles (DIRECT diffuse, only the named light on, black world, the same temporary white material) at several sample counts, with and without the other meshes casting, and read the given texels; also the texel's footprint in 3D (its four corners mapped through the UV triangle that holds its centre).
params: receiver, atlas_px, uv ("LightmapUV"), cases [{id, light, texel:[x, y]}] (Blender image coordinates, y up), samples [128, 1024], hide (globs off for the bake)"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.geometry import barycentric_transform  # noqa: E402


def bake(ob, atlas, samples):
    img = bpy.data.images.new("tp_img", atlas, atlas, alpha=False, float_buffer=True, is_data=True)
    m = bpy.data.materials.new("tp_m")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    d = nt.nodes.new("ShaderNodeBsdfDiffuse")
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(d.outputs["BSDF"], o.inputs["Surface"])
    nt.nodes.active = tex
    mats = [sl.material for sl in ob.material_slots]
    for sl in ob.material_slots:
        sl.material = m
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = samples
    scn.cycles.use_denoising = False
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT"}, margin=0, margin_type="EXTEND", use_clear=True, target="IMAGE_TEXTURES")
    for sl, mm in zip(ob.material_slots, mats):
        sl.material = mm
    return np.array(img.pixels[:], np.float64).reshape(atlas, atlas, 4)[:, :, 0]


def footprint(ob, uvname, atlas, tx, ty):
    me = ob.data
    me.calc_loop_triangles()
    lay = me.uv_layers[uvname].data
    cu = ((tx + 0.5) / atlas, (ty + 0.5) / atlas)
    for t in me.loop_triangles:
        q = [lay[l].uv.copy() for l in t.loops]
        v = [me.vertices[i].co for i in t.vertices]
        a, b, c = [Vector((x[0], x[1], 0)) for x in q]
        p = Vector((cu[0], cu[1], 0))
        d = (b - a).cross(c - a).z
        if abs(d) < 1e-14:
            continue
        w1 = (p - a).cross(c - a).z / d
        w2 = (b - a).cross(p - a).z / d
        if w1 >= -1e-9 and w2 >= -1e-9 and w1 + w2 <= 1 + 1e-9:
            def to3(u, vv):
                return ob.matrix_world @ barycentric_transform(Vector((u, vv, 0)), a, b, c, v[0], v[1], v[2])
            hx = 0.5 / atlas
            c00, c10, c01 = to3(cu[0] - hx, cu[1] - hx), to3(cu[0] + hx, cu[1] - hx), to3(cu[0] - hx, cu[1] + hx)
            return {"triangle": t.index, "centre": [round(c, 5) for c in to3(*cu)], "texel_edge_u_mm": round((c10 - c00).length * 1000, 2), "texel_edge_v_mm": round((c01 - c00).length * 1000, 2), "normal": [round(c, 3) for c in t.normal]}
    return None


def main():
    scn = bpy.context.scene
    ob = bpy.data.objects[L.param("receiver")]
    atlas = int(L.param("atlas_px", 1024))
    uvn = L.param("uv", "LightmapUV")
    hide = L.param("hide") or []
    w = bpy.data.worlds.new("tp_black")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    scn.world = w
    lights = {o.name: o for o in scn.objects if o.type == "LIGHT"}
    others = [o for o in scn.objects if o.type == "MESH" and o is not ob]
    for o in others:
        if any(fnmatch.fnmatchcase(o.name, g) for g in hide):
            o.visible_shadow = False
    lay = ob.data.uv_layers[uvn]
    lay.active_render = True
    ob.data.uv_layers.active = lay
    rows = []
    for cs in L.param("cases"):
        for k, v in lights.items():
            v.data.energy = 100.0 if k == cs["light"] else 0.0
        row = {"id": cs["id"], "texel": cs["texel"], "footprint": footprint(ob, uvn, atlas, *cs["texel"]), "shadowed": {}, "open": {}}
        tx, ty = cs["texel"]
        for s in L.param("samples", [128, 1024]):
            img = bake(ob, atlas, s)
            row["shadowed"][str(s)] = [round(float(img[ty + dy, tx + dx]), 5) for dy, dx in ((0, 0), (0, 1), (1, 0), (0, -1), (-1, 0))]
        fw0 = scn.cycles.filter_width
        row["filter"] = {"default_px": fw0}
        for fw in L.param("filter_widths", []):
            scn.cycles.filter_width = float(fw)
            img = bake(ob, atlas, 128)
            row["filter"][str(fw)] = round(float(img[ty, tx]), 5)
        scn.cycles.filter_width = fw0
        vis0 = {o.name: o.visible_shadow for o in others}
        for o in others:
            o.visible_shadow = False
        img = bake(ob, atlas, 128)
        row["open"]["128"] = [round(float(img[ty + dy, tx + dx]), 5) for dy, dx in ((0, 0), (0, 1), (1, 0), (0, -1), (-1, 0))]
        for o in others:
            o.visible_shadow = vis0[o.name]
        rows.append(row)
    L.finish({"rows": rows, "order": "[texel, +x, +y, -x, -y]"}, save=False)


L.run(main)
