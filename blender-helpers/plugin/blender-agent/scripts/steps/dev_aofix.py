"""dev_aofix — DEV TOOL: a fixture to test lightmap_ao. phase "build": a 10 x 10 m receiver floor `ao_floor` (UV layers UVMap and LightmapUV = 0..1) with an opaque ceiling over x > 0 and a fully transparent (Principled alpha 0) ceiling over x < 0, y > 0, both 0.5 m up; x < 0, y < 0 is open. phase "check": reads <name>.ao.bin and reports the mean AO in the three regions."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def quad(name, x0, x1, y0, y1, z, uv=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z))]
    f = bm.faces.new(vs)
    if uv:
        for nm in uv:
            lay = bm.loops.layers.uv.new(nm)
            for lp, c in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
                lp[lay].uv = c
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build():
    L.drop_factory_objects()
    quad("ao_floor", -5, 5, -5, 5, 0.0, ("UVMap", "LightmapUV"))
    quad("ao_ceiling_opaque", 0, 5, -5, 5, 0.5)
    c = quad("ao_ceiling_alpha0", -5, 0, 0, 5, 0.5)
    m = bpy.data.materials.new("alpha0")
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Alpha"].default_value = 0.0
    c.data.materials.append(m)
    L.finish({"built": True}, save=True)


def check():
    j = L.param("meta")
    import json
    meta = json.load(open(L.resolve(j), encoding="utf-8"))
    W = meta["width"]
    a = np.fromfile(L.resolve(L.param("bin")), dtype="<f2").reshape(W, W).astype(np.float64)
    a = np.flipud(a)  # back to Blender rows: row 0 = v 0 = y -5
    xs = (np.arange(W) + 0.5) / W * 10 - 5
    X, Y = np.meshgrid(xs, xs)

    def reg(m):
        return {"texels": int(m.sum()), "mean": round(float(a[m].mean()), 4), "min": round(float(a[m].min()), 4), "max": round(float(a[m].max()), 4)}
    L.finish({"under_opaque_ceiling(x 1..4)": reg((X > 1) & (X < 4) & (np.abs(Y) < 4)), "under_alpha0_ceiling(x -4..-1,y 1..4)": reg((X < -1) & (X > -4) & (Y > 1) & (Y < 4)),
              "open_control(x -4..-1,y -4..-1)": reg((X < -1) & (X > -4) & (Y < -1) & (Y > -4)), "distance_m": meta["distance_m"]}, save=False)


def main():
    if L.param("phase") == "build":
        build()
    else:
        check()


L.run(main)
