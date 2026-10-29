"""import_mesh — start a job from a GLB/glTF/FBX/OBJ file.

params:
  src         path to the file (absolute, or relative to the tool root)   [required]
  keep        optional list of mesh object names to keep; other meshes are deleted
              (armatures are kept — strip_rig removes them)
  as_ref      true: name the imported mesh "ref" (the reference the part verbs fit to: kit2_part, kit2_probe, kit2_region, kit2_view ...), so a job can be parts-only, without kit2_body.
              Refused when more than one mesh remains (leave one with `keep`). Without it a part verb still finds the reference when it is the ONLY mesh in the scene, and names it "ref" then.
  base_color  optional image path assigned as base colour on every kept mesh's materials
              (for packs whose FBX points at textures that are not beside it, e.g. third-party asset packs)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    src = L.resolve(L.param("src"), what="src")
    if not os.path.isfile(src):
        raise FileNotFoundError(src)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(src)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=src)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    else:
        raise ValueError(f"unsupported format: {ext}")

    keep = L.param("keep")
    if keep:
        missing = [k for k in keep if k not in bpy.data.objects]
        if missing:
            raise RuntimeError(f"keep: not in file: {missing}")
        for o in L.meshes():
            if o.name not in keep:
                bpy.data.objects.remove(o, do_unlink=True)
        for o in list(bpy.context.scene.objects):  # drop empties/cameras/lights that came along
            if o.type not in ("MESH", "ARMATURE"):
                bpy.data.objects.remove(o, do_unlink=True)

    ref_info = None
    if L.param("as_ref"):
        ms_ = L.meshes()
        if len(ms_) != 1:
            raise RuntimeError(f"as_ref: the file has {len(ms_)} meshes {[m.name for m in ms_][:8]}: leave one with keep:[name]")
        ref_info = {"was": ms_[0].name}
        ms_[0].name = "ref"
    base_color = L.param("base_color")
    if base_color:
        img = bpy.data.images.load(L.resolve(base_color))
        for o in L.meshes():
            for slot in o.material_slots:
                mat = slot.material
                if not mat:
                    continue
                mat.use_nodes = True
                nt = mat.node_tree
                bsdf = next((nd for nd in nt.nodes if nd.type == "BSDF_PRINCIPLED"), None)
                if bsdf is None:
                    continue
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img
                nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    objs = [{"type": o.type, "name": o.name, "tris": L.tris(o) if o.type == "MESH" else None,
             "bones": len(o.data.bones) if o.type == "ARMATURE" else None}
            for o in bpy.context.scene.objects]
    ms = L.meshes()
    summary = {"src": os.path.basename(src), "meshes": len(ms), "armatures": len(L.armatures()),
               "tris": sum(L.tris(o) for o in ms), **({"dims": L.dims(ms)} if ms else {})}
    if ref_info:
        summary["as_ref"] = ref_info
    L.finish(summary, save=True, objects=objs[:200])


L.run(main)
