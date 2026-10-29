"""preview_keys — close-up sheet of the face: columns = rest + each shape key at
1.0, rows = front and three-quarter. Cycles CPU. Framing centres on the mouth
(mesh["mouth"]) or on the upper third of the mesh.

params:
  keys     default: every key except Basis
  size     framed height in metres, default 0.45 * mesh height
  res      default 384
  samples  default 16
  name     default "keys"
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def main():
    scn = bpy.context.scene
    mesh = L.the_mesh()
    kbs = mesh.data.shape_keys.key_blocks if mesh.data.shape_keys else []
    keys = L.param("keys") or [k.name for k in kbs if k.name != "Basis"]
    res, name = int(L.param("res", 384)), L.param("name", "keys")
    lo, hi = L.world_bbox([mesh])
    if "mouth" in mesh:
        m = json.loads(mesh["mouth"])
        mid = m["line"][len(m["line"]) // 2]
        centre = Vector((m["center_x"], mid[1], mid[2] + 0.02 * (hi.z - lo.z)))
    else:
        centre = Vector(((lo.x + hi.x) / 2, lo.y, lo.z + 0.8 * (hi.z - lo.z)))
    size = float(L.param("size", 0.45 * (hi.z - lo.z)))

    for o in scn.objects:
        o.hide_render = o is not mesh
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = int(L.param("samples", 16))
    scn.cycles.use_denoising = True
    scn.render.resolution_x = scn.render.resolution_y = res
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    scn.world.node_tree.nodes["Background"].inputs[0].default_value = (0.18, 0.18, 0.2, 1)
    scn.world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    sun = bpy.data.objects.new("KeySun", bpy.data.lights.new("KeySun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(55), 0, math.radians(20))
    scn.collection.objects.link(sun)
    cam = bpy.data.objects.new("KeyCam", bpy.data.cameras.new("KeyCam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = size
    scn.collection.objects.link(cam)
    scn.camera = cam

    saved = {k.name: k.value for k in kbs}
    views = {"front": Vector((0, -1, 0)), "three_quarter": Vector((0.7, -0.7, 0)).normalized()}
    cols = ["rest"] + keys
    tiles = []
    for vname, d in views.items():
        cam.location = centre + d * 1.0
        cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        for c in cols:
            for k in kbs:
                if k.name != "Basis":
                    k.value = saved[k.name] if c == "rest" else (1.0 if k.name == c else 0.0)
            path = os.path.join(L.ARGS["out_dir"], f"{name}_{vname}_{c}.png")
            scn.render.filepath = path
            bpy.ops.render.render(write_still=True)
            tiles.append(path)
    for k in kbs:
        k.value = saved[k.name]

    imgs = [np.array(bpy.data.images.load(p).pixels[:], dtype=np.float32).reshape(res, res, 4) for p in tiles]
    rows = [np.concatenate(imgs[i * len(cols):(i + 1) * len(cols)], axis=1) for i in range(len(views))]
    sheet = np.concatenate(rows[::-1], axis=0)
    out = bpy.data.images.new(name, sheet.shape[1], sheet.shape[0], alpha=True)
    out.pixels = sheet.ravel()
    sheet_path = os.path.join(L.ARGS["out_dir"], f"{name}.png")
    out.filepath_raw = sheet_path
    out.file_format = "PNG"
    out.save()
    L.finish({"sheet": os.path.basename(sheet_path), "columns": cols, "rows": list(views)}, files=[sheet_path])


L.run(main)
