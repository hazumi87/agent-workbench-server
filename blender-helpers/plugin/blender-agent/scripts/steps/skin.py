"""skin — bind the one mesh to the generated rig with automatic (heat) weights.

Heat weighting often fails on scan-like or multi-shell meshes (verts left with
no weight). When more than `max_unweighted` of the verts are unweighted, fall
back to a PROXY: a voxel-remeshed (watertight) copy is auto-weighted, and its
weights are transferred to the real mesh. Any vertex still unweighted then copies
its nearest weighted neighbour (reported as filled_from_neighbour). Weights are then limited to 4
influences per vertex (glTF / three.js / Unity) and normalised.

params:
  max_unweighted  fraction, default 0.001
  proxy_voxel     voxel size in metres for the fallback, default height / 150
  force_proxy     default false
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Matrix  # noqa: E402
from mathutils.kdtree import KDTree  # noqa: E402
import _lib as L  # noqa: E402


def rig_obj():
    rigs = [a for a in L.armatures() if a.name != "metarig"]
    if len(rigs) != 1:
        raise RuntimeError(f"expected one generated rig, found {[a.name for a in rigs]}")
    return rigs[0]


def auto_weight(mesh, rig):
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def unweighted(mesh, deform):
    idx = {g.index for g in mesh.vertex_groups if g.name in deform}
    return sum(1 for v in mesh.data.vertices if not any(g.group in idx and g.weight > 1e-4 for g in v.groups))


def fill_unweighted(mesh, deform):
    """Last pass: a vertex the solver left with no deform weight copies the weights
    of its nearest weighted vertex (proxy transfer can leave a few near seams)."""
    idx = {g.index for g in mesh.vertex_groups if g.name in deform}
    verts = mesh.data.vertices
    weighted = [v for v in verts if any(g.group in idx and g.weight > 1e-4 for g in v.groups)]
    empty = [v for v in verts if not any(g.group in idx and g.weight > 1e-4 for g in v.groups)]
    if not empty or not weighted:
        return 0
    tree = KDTree(len(weighted))
    for i, v in enumerate(weighted):
        tree.insert(v.co, i)
    tree.balance()
    for v in empty:
        _, i, _ = tree.find(v.co)
        for g in weighted[i].groups:
            if g.group in idx:
                mesh.vertex_groups[g.group].add([v.index], g.weight, "REPLACE")
    return len(empty)


def rescale(mesh, rig, k):
    """Scale mesh data (incl. shape keys) and the rig's rest bones by k about the origin."""
    mesh.data.transform(Matrix.Scale(k, 4), shape_keys=True)
    L.activate(rig, "EDIT")
    for eb in rig.data.edit_bones:
        eb.transform(Matrix.Scale(k, 4), scale=True, roll=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def main():
    mesh = L.the_mesh()
    rig = rig_obj()
    # Bone-heat weighting fails outright on small models (they get zero
    # weights). Weight at human scale, then scale back: weights don't depend on it.
    H0 = L.dims([mesh])["height"]
    k = 1.8 / H0 if H0 < 1.0 else 1.0
    if k != 1.0:
        rescale(mesh, rig, k)
    deform = {b.name for b in rig.data.bones if b.use_deform}
    n = len(mesh.data.vertices)
    limit = float(L.param("max_unweighted", 0.001))
    method = "heat"
    missing_heat = None

    if not L.param("force_proxy", False):
        auto_weight(mesh, rig)
        missing_heat = unweighted(mesh, deform)
    if L.param("force_proxy", False) or missing_heat > limit * n:
        method = "proxy"
        # undo the direct bind
        mesh.parent = None
        for m in [m for m in mesh.modifiers if m.type == "ARMATURE"]:
            mesh.modifiers.remove(m)
        mesh.vertex_groups.clear()
        # watertight proxy
        proxy = mesh.copy()
        proxy.data = mesh.data.copy()
        proxy.name = "skin_proxy"
        bpy.context.scene.collection.objects.link(proxy)
        proxy.shape_key_clear()  # modifiers can't be applied under shape keys; the proxy needs none
        H = L.dims([mesh])["height"]
        rm = proxy.modifiers.new("Remesh", "REMESH")
        rm.mode = "VOXEL"
        rm.voxel_size = float(L.param("proxy_voxel", H / 150))
        L.activate(proxy)
        bpy.ops.object.modifier_apply(modifier=rm.name)
        auto_weight(proxy, rig)
        # transfer weights proxy -> mesh with the operator (a modifier can't be
        # applied to a mesh with shape keys, e.g. a head with mouth keys)
        bpy.ops.object.select_all(action="DESELECT")
        mesh.select_set(True)
        proxy.select_set(True)
        bpy.context.view_layer.objects.active = proxy
        bpy.ops.object.data_transfer(data_type="VGROUP_WEIGHTS", use_create=True,
                                     vert_mapping="POLYINTERP_NEAREST",
                                     layers_select_src="ALL", layers_select_dst="NAME")
        bpy.data.objects.remove(proxy, do_unlink=True)
        bpy.ops.object.select_all(action="DESELECT")
        mesh.select_set(True)
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.parent_set(type="ARMATURE")  # keep the transferred groups

    filled = fill_unweighted(mesh, deform)
    if k != 1.0:
        rescale(mesh, rig, 1.0 / k)
    L.activate(mesh)
    bpy.ops.object.vertex_group_limit_total(group_select_mode="BONE_DEFORM", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="BONE_DEFORM", lock_active=False)
    missing = unweighted(mesh, deform)
    ok = missing <= limit * n
    L.finish({"method": method, "weighted_at_scale": round(k, 3), "filled_from_neighbour": filled, "verts": n, "unweighted": missing, "unweighted_heat": missing_heat,
              "groups": len(mesh.vertex_groups)}, save=True, ok=ok,
             error=None if ok else f"{missing}/{n} verts unweighted after {method}")


L.run(main)
