"""export_static — write the job's one mesh (no rig) as a GLB with its textures embedded.

params:
  mesh      name of the one mesh to write when the scene holds more than one
  meshes    list of mesh names to write together as separate objects (e.g. ["HEAD", "TORSO", "COLLAR"]); other meshes are left out
  name      file stem, default the job name
  scale_confidence, scale_note  stored in the export map written next to the GLB (<name>.glb.map.json; default "unknown")
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import _exportmap as EM  # noqa: E402


def main():
    many = L.param("meshes")
    mesh = bpy.data.objects[many[0]] if many else (bpy.data.objects[L.param("mesh")] if L.param("mesh") else L.the_mesh())  # `mesh` names the object when the scene holds more than one
    name = L.param("name", L.ARGS["job"])
    path = os.path.join(L.ARGS["out_dir"], f"{name}.glb")
    L.activate(mesh)
    for nm in (many or [])[1:]:
        bpy.data.objects[nm].select_set(True)
    snap = EM.capture(list(bpy.context.selected_objects))
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True)
    emap = EM.write(path, snap, "export_static", job=L.ARGS["job"], step=L.ARGS["step"], scale_confidence=L.param("scale_confidence", "unknown"), scale_note=L.param("scale_note"))
    L.finish({"glb": {"file": os.path.basename(path), "bytes": os.path.getsize(path)}, "map": emap,
              "tris": sum(L.tris(o) for o in bpy.context.selected_objects if o.type == "MESH"), "objects": [o.name for o in bpy.context.selected_objects], "materials": sorted({m.name for o in bpy.context.selected_objects if o.type == "MESH" for m in o.data.materials if m})}, files={"glb": path, "map": path + ".map.json"})


L.run(main)