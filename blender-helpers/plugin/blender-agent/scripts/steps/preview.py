"""preview — orthographic stills of the character, stitched into one sheet.

Renders with Cycles on the CPU by default: no VRAM, so no GPU coordination
needed (the 4080 is shared). device "GPU" is allowed only when the caller has
cleared it in the room.

params:
  views     default ["front", "side", "back", "three_quarter"]
  frames    default [first, middle of the scene range]
  res       pixels per view, default 512
  samples   default 24
  device    "CPU" (default) | "GPU"
  name      sheet stem, default "preview"
  focus     optional close-up: {center: [fx, fy, fz] as fractions of the model's box,
            size: fraction of its largest side} (e.g. the back strap: center [0.5, 0.5, 0.7], size 0.4)
  light_from_camera   light each view from its camera side (default false: one fixed key)
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402

DIRS = {  # camera direction FROM the character (it faces -Y)
    "front": Vector((0, -1, 0)), "back": Vector((0, 1, 0)),
    "side": Vector((1, 0, 0)), "left": Vector((1, 0, 0)), "right": Vector((-1, 0, 0)), "three_quarter": Vector((0.7, -0.7, 0)),
}


def main():
    scn = bpy.context.scene
    views = L.param("views", list(DIRS))
    frames = L.param("frames", [scn.frame_start, (scn.frame_start + scn.frame_end) // 2])
    res = int(L.param("res", 512))
    name = L.param("name", "preview")
    ms = L.meshes()
    for o in scn.objects:
        o.hide_render = o not in ms

    scn.render.engine = "CYCLES"
    scn.cycles.device = L.param("device", "CPU")
    scn.cycles.samples = int(L.param("samples", 24))
    scn.cycles.use_denoising = True
    scn.render.resolution_x = scn.render.resolution_y = res
    scn.render.film_transparent = False
    scn.render.image_settings.file_format = "PNG"
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    scn.world.node_tree.nodes["Background"].inputs[0].default_value = (0.18, 0.18, 0.2, 1)
    scn.world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    sun = bpy.data.objects.new("PreviewSun", bpy.data.lights.new("PreviewSun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scn.collection.objects.link(sun)
    cam = bpy.data.objects.new("PreviewCam", bpy.data.cameras.new("PreviewCam"))
    cam.data.type = "ORTHO"
    scn.collection.objects.link(cam)
    scn.camera = cam

    tiles = []
    for f in frames:
        scn.frame_set(f)
        lo, hi = L.world_bbox(ms)
        centre, size = (lo + hi) / 2, hi - lo
        cam.data.ortho_scale = max(size.x, size.y, size.z) * 1.1
        focus = L.param("focus")
        if focus:
            fx, fy, fz = focus.get("center", [0.5, 0.5, 0.5])
            centre = Vector((lo.x + fx * size.x, lo.y + fy * size.y, lo.z + fz * size.z))
            cam.data.ortho_scale = max(size.x, size.y, size.z) * float(focus.get("size", 0.4))
        for v in views:
            d = DIRS[v].normalized()
            cam.location = centre + d * (size.length * 2)
            cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
            if L.param("light_from_camera"):
                sun.rotation_euler = (-(d + Vector((0.3, 0, 0.6))).normalized()).to_track_quat("-Z", "Y").to_euler()
            path = os.path.join(L.ARGS["out_dir"], f"{name}_{v}_f{f}.png")
            scn.render.filepath = path
            bpy.ops.render.render(write_still=True)
            tiles.append(path)

    # stitch: one row per frame, one column per view
    imgs = []
    for p in tiles:
        im = bpy.data.images.load(p)
        imgs.append(np.array(im.pixels[:], dtype=np.float32).reshape(res, res, 4))
    rows = [np.concatenate(imgs[i * len(views):(i + 1) * len(views)], axis=1) for i in range(len(frames))]
    sheet = np.concatenate(rows[::-1], axis=0)  # Blender pixels are bottom-up
    h, w = sheet.shape[:2]
    out = bpy.data.images.new(name, w, h, alpha=True)
    out.pixels = sheet.ravel()
    sheet_path = os.path.join(L.ARGS["out_dir"], f"{name}.png")
    out.filepath_raw = sheet_path
    out.file_format = "PNG"
    out.save()
    L.finish({"sheet": os.path.basename(sheet_path), "views": views, "frames": frames,
              "device": scn.cycles.device}, files=[sheet_path] + tiles)


L.run(main)
