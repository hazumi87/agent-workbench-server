"""dev_skydir — DEV ONLY: where does the Nishita sky of scene_sun put its sun disc, compared with the sun lamp? Renders from a camera looking along the lamp's horizontal direction and reports the angular offset of the brightest pixel (x right, y up). Saves nothing."""
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
    sun = bpy.data.objects["Solar_Sun"]
    toward = -(sun.matrix_world.to_3x3() @ Vector((0, 0, -1)))
    for o in scn.objects:
        if o.type == "MESH":
            o.hide_render = True
    sk = next(n for n in scn.world.node_tree.nodes if n.type == "TEX_SKY")
    sk.sun_disc = True
    sk.sun_size = math.radians(4)
    sun.hide_render = True
    out = []
    for name, rot in (("toward", 0.0), ("away", 180.0)):
        h = Vector((toward.x, toward.y, 0)).normalized()
        c = math.cos(math.radians(rot)), math.sin(math.radians(rot))
        h = Vector((h.x * c[0] - h.y * c[1], h.x * c[1] + h.y * c[0], 0))
        cam = bpy.data.objects.new("c", bpy.data.cameras.new("c"))
        scn.collection.objects.link(cam)
        cam.data.angle = math.radians(90)
        cam.location = (0, 0, 1.5)
        cam.rotation_euler = h.to_track_quat("-Z", "Y").to_euler()
        scn.camera = cam
        scn.render.engine = "CYCLES"
        scn.cycles.samples = 8
        scn.view_settings.view_transform = "Standard"
        scn.view_settings.exposure = -9.0
        scn.render.resolution_x = scn.render.resolution_y = 200
        scn.render.resolution_percentage = 100
        p = os.path.join(L.ARGS["out_dir"], f"skydir-{name}.png")
        scn.render.filepath = p
        bpy.ops.render.render(write_still=True)
        im = bpy.data.images.load(p)
        a = np.array(im.pixels[:]).reshape(200, 200, 4)[..., :3].sum(2)
        ys, xs = np.nonzero(a >= a.max() * 0.8)
        y, x = ys.mean(), xs.mean()
        out.append({"camera": name, "max": round(float(a.max()), 3), "n": int(len(xs)), "dx_deg": round(math.degrees(math.atan((x - 99.5) / 100)), 1), "dy_up_deg": round(math.degrees(math.atan((y - 99.5) / 100)), 1)})
    el = math.degrees(math.asin(toward.z))
    L.finish({"lamp_elevation_deg": round(el, 2), "views": out}, save=False)


L.run(main)
