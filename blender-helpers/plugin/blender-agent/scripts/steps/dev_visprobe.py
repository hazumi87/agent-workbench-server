"""dev_visprobe — DEV TOOL (read-only, saves nothing): for texel-sized square patches on a horizontal surface, compare (A) solid-ray visibility of a light over an N x N midpoint grid (origin lifted `lift_m`) with (B) a Cycles DIRECT bake of a temporary N x N plane at the same place (same lights, same casters, the named `hide` objects off). Reports mean transport with shadows / without for each, so the ratios compare directly.
params: cases [{id, light, centre:[x,y,z]}], size_m, n (17), lift_m (0.002), hide (object globs switched off for rays and Cycles), samples (256)"""
import fnmatch
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
from mathutils import Vector  # noqa: E402


def bake_patch(centre, size, n, samples, shadows):
    me = bpy.data.meshes.new("vp")
    h = size / 2
    me.from_pydata([(centre[0] - h, centre[1] - h, centre[2]), (centre[0] + h, centre[1] - h, centre[2]), (centre[0] + h, centre[1] + h, centre[2]), (centre[0] - h, centre[1] + h, centre[2])], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name="UVMap")
    for lp, c in zip(me.polygons[0].loop_indices, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[lp].uv = c
    ob = bpy.data.objects.new("vp", me)
    bpy.context.scene.collection.objects.link(ob)
    img = bpy.data.images.new("vp_img", n, n, alpha=False, float_buffer=True, is_data=True)
    m = bpy.data.materials.new("vp_m")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    d = nt.nodes.new("ShaderNodeBsdfDiffuse")
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(d.outputs["BSDF"], o.inputs["Surface"])
    nt.nodes.active = tex
    me.materials.append(m)
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = samples
    scn.cycles.use_denoising = False
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT"}, margin=0, use_clear=True, target="IMAGE_TEXTURES")
    px = np.array(img.pixels[:], np.float64).reshape(n, n, 4)[:, :, 0]
    bpy.data.objects.remove(ob)
    return px


def main():
    scn = bpy.context.scene
    n = int(L.param("n", 17))
    size = float(L.param("size_m", 0.05764))
    lift = float(L.param("lift_m", 0.002))
    samples = int(L.param("samples", 256))
    hide = L.param("hide") or []
    hidden = [o for o in scn.objects if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, g) for g in hide)]
    for o in hidden:
        o.hide_viewport = True
        o.hide_render = True
    w = bpy.data.worlds.new("vp_black")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    scn.world = w
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    lights = {o.name: o for o in scn.objects if o.type == "LIGHT"}
    rows = []
    for cs in L.param("cases"):
        lo = lights[cs["light"]]
        lp = np.array(lo.matrix_world.translation)
        c = np.array(cs["centre"], float)
        step = size / n
        pts = [c + np.array([-size / 2 + (i + 0.5) * step, -size / 2 + (j + 0.5) * step, 0.0]) for j in range(n) for i in range(n)]
        trans, vis = [], []
        for p in pts:
            dv = lp - p
            d = float(np.linalg.norm(dv))
            t = max(0.0, dv[2] / d) / d ** 2
            o = Vector(p + np.array([0, 0, lift]))
            dd = Vector(lp) - o
            hit, loc, nrm, idx, ob_, mat = scn.ray_cast(dg, o, dd.normalized(), distance=dd.length - 1e-4)
            trans.append(t)
            vis.append(0 if hit else 1)
        trans, vis = np.array(trans), np.array(vis)
        # Cycles: only this light on
        e0 = {k: v.data.energy for k, v in lights.items()}
        for k, v in lights.items():
            v.data.energy = 100.0 if k == cs["light"] else 0.0
        sh = bake_patch(c, size, n, samples, True)
        casters = [o for o in scn.objects if o.type == "MESH" and not o.hide_render]
        for o in casters:
            o.hide_render = True
        un = bake_patch(c, size, n, samples, False)
        for o in casters:
            o.hide_render = False
        for k, v in lights.items():
            v.data.energy = e0[k]
        rows.append({"id": cs["id"], "ray_visible_fraction": round(float(vis.mean()), 4), "ray_ratio_shadow_over_open": round(float((trans * vis).mean() / trans.mean()), 4), "cycles_ratio_shadow_over_open": round(float(sh.mean() / un.mean()), 4),
                     "cycles_pixels_lit_fraction": round(float((sh > 1e-4 * un.mean()).mean()), 4), "ray_transport_mean_shadowed": round(float((trans * vis).mean()), 5), "ray_transport_mean_open": round(float(trans.mean()), 5)})
    L.finish({"size_m": size, "n": n, "lift_m": lift, "hidden": [o.name for o in hidden], "rows": rows}, save=False)


L.run(main)
