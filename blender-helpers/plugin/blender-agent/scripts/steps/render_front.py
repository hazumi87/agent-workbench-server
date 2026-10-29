"""render_front — an orthographic front render of the head (clay, Cycles CPU) plus
its exact camera, so face landmarks found on the render map straight back to
mesh coordinates (no guessing how a drawing is framed against the mesh).

Writes out/<name>.png and work/<job>/<name>.camera.json {center, scale, res}:
  pixel (px, py) -> x = cx + (px/res - 0.5) * scale,  z = cz - (py/res - 0.5) * scale
params:
  z_from, z_to   framed height range as fractions of mesh height, default 0.25 .. 1.0
  res            default 1024
  name           default "front_clay"
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def main():
    scn = bpy.context.scene
    mesh = L.the_mesh()
    lo, hi = L.world_bbox([mesh])
    H = hi.z - lo.z
    z0 = lo.z + float(L.param("z_from", 0.25)) * H
    z1 = lo.z + float(L.param("z_to", 1.0)) * H
    scale = z1 - z0
    centre = Vector(((lo.x + hi.x) / 2, lo.y, (z0 + z1) / 2))
    res = int(L.param("res", 1024))
    name = L.param("name", "front_clay")

    for o in scn.objects:
        o.hide_render = o is not mesh
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = 24
    scn.cycles.use_denoising = True
    scn.render.resolution_x = scn.render.resolution_y = res
    scn.render.image_settings.file_format = "PNG"
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    scn.world.node_tree.nodes["Background"].inputs[0].default_value = (0.9, 0.9, 0.9, 1)
    clay = bpy.data.materials.new("LandmarkClay")
    clay.use_nodes = True
    clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.75, 0.62, 0.55, 1)
    saved = [s.material for s in mesh.material_slots]
    for s in mesh.material_slots:
        s.material = clay
    if not mesh.material_slots:
        mesh.data.materials.append(clay)
    sun = bpy.data.objects.new("FrontSun", bpy.data.lights.new("FrontSun", "SUN"))
    sun.data.energy = 2.5
    sun.rotation_euler = (math.radians(35), 0, math.radians(-15))
    scn.collection.objects.link(sun)
    cam = bpy.data.objects.new("FrontCam", bpy.data.cameras.new("FrontCam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = scale
    cam.location = centre + Vector((0, -1.0, 0))
    cam.rotation_euler = (math.radians(90), 0, 0)
    scn.collection.objects.link(cam)
    scn.camera = cam
    path = os.path.join(L.ARGS["out_dir"], f"{name}.png")
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for s, m in zip(mesh.material_slots, saved):
        s.material = m
    cam_path = os.path.join(L.ARGS["job_dir"], f"{name}.camera.json")
    with open(cam_path, "w", encoding="utf-8") as f:
        json.dump({"center": [centre.x, centre.y, centre.z], "scale": scale, "res": res, "image": path}, f)
    L.finish({"image": os.path.basename(path), "camera": os.path.basename(cam_path), "scale": round(scale, 4)},
             files=[path, cam_path])


L.run(main)
