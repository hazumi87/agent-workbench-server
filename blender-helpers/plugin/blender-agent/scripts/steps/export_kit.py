"""export_kit — write every mesh in the scene (body + garments, no rig) as ONE GLB with the textures embedded.

The parts arrive with three 4096 maps each, which would make a GLB of hundreds of MB, so every texture is
scaled to `tex` px first, and written as JPEG (normal maps stay PNG).

params:
  name   file stem (default the job name)
  tex    texture size in px (default 2048)
  scale_confidence, scale_note  stored in the export map (<name>.glb.map.json, see docs verb: export map): how sure the scale is (default "unknown")
  exclude  extra object names to leave out. The reference (`ref`) is ALWAYS left out.
  expect   optional list of the mesh names the file must contain; any difference refuses the export
Refuses (nothing is written) when: more than one body would be exported (names `body`, `body.001`, ...);
a part (not the body) carries a Blender duplicate suffix (`.001`, `.002`, ...) that `expect` does not list; or `expect` does not match.
Returns the mesh list with triangles per mesh and the total.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import _exportmap as EM  # noqa: E402


def main():
    tex = int(L.param("tex", 2048))
    name = L.param("name", L.ARGS["job"])
    skip = set(L.param("exclude") or []) | {"ref"}
    ms = [o for o in L.meshes() if o.name not in skip]
    names = [o.name for o in ms]
    listing = {o.name: L.tris(o) for o in ms}
    bodies = [n for n in names if n.split(".")[0] == "body"]
    if len(bodies) > 1:
        raise RuntimeError(f"refused: more than one body would be exported: {bodies}. Exclude all but one. Meshes: {listing}")
    expect = L.param("expect")
    dupes = [n for n in names if n.split(".")[0] != "body" and len(n) > 4 and n[-4] == "." and n[-3:].isdigit() and (not expect or n not in expect)]
    if dupes:
        raise RuntimeError(f"refused: duplicate-looking meshes would be exported: {dupes}. Exclude them, or list them in expect. Meshes: {listing}")
    if expect is not None and sorted(expect) != sorted(names):
        raise RuntimeError(f"refused: the meshes do not match expect. Missing: {sorted(set(expect) - set(names))}; unexpected: {sorted(set(names) - set(expect))}")
    scaled = 0
    for img in bpy.data.images:
        if img.users == 0 or img.size[0] == 0:
            continue
        if max(img.size) > tex:
            img.scale(tex, tex)
            scaled += 1
        img.file_format = "PNG" if "normal" in img.name.lower() else "JPEG"
    bpy.ops.object.select_all(action="DESELECT")
    for o in ms:
        o.select_set(True)
    bpy.context.view_layer.objects.active = ms[0]
    snap = EM.capture(ms)
    path = os.path.join(L.ARGS["out_dir"], f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                              export_image_format="AUTO", export_jpeg_quality=88)
    emap = EM.write(path, snap, "export_kit", job=L.ARGS["job"], step=L.ARGS["step"], scale_confidence=L.param("scale_confidence", "unknown"), scale_note=L.param("scale_note"))
    L.finish({"glb": {"file": os.path.basename(path), "bytes": os.path.getsize(path)}, "map": emap, "meshes": listing,
              "tris": sum(listing.values()), "images_scaled": scaled, "tex": tex}, files={"glb": path, "map": path + ".map.json"})


L.run(main)