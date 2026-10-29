"""dev_crosscards — DEV TOOL: N copies of a crossed-plane photo tree card (two vertical planes at 90 deg through one axis, picture with alpha MASK), to test foliage normals on the seam. params: image (path), names [..], size_m [w, h], gap_m (spacing)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import _lib as L  # noqa: E402


def main():
    img = bpy.data.images.load(L.param("image"), check_existing=True)
    img.alpha_mode = "STRAIGHT"
    names = L.param("names") or ["tA", "tB", "tC"]
    w, h = L.param("size_m", [1.0, 2.0])
    gap = float(L.param("gap_m", 1.6))
    mat = bpy.data.materials.new("cross-photo")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Roughness"].default_value = 0.8
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation = "GREATER_THAN"
    gt.inputs[1].default_value = 0.5
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(t.outputs["Alpha"], gt.inputs[0])
    nt.links.new(gt.outputs["Value"], b.inputs["Alpha"])
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    mat.use_backface_culling = False
    for i, nm in enumerate(names):
        bm = bmesh.new()
        lay = bm.loops.layers.uv.new("UVMap")
        for ax in ((1, 0), (0, 1)):
            vs = [bm.verts.new((ax[0] * sx * w / 2, ax[1] * sx * w / 2, z)) for sx, z in ((-1, 0), (1, 0), (1, h), (-1, h))]
            f = bm.faces.new(vs)
            for lp, uv in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
                lp[lay].uv = uv
        me = bpy.data.meshes.new(nm)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(mat)
        o = bpy.data.objects.new(nm, me)
        bpy.context.scene.collection.objects.link(o)
        o.location = (i * gap, 0, 0)
    bpy.context.view_layer.update()
    L.finish({"objects": names, "image": os.path.basename(L.param("image"))}, save=True)


L.run(main)
