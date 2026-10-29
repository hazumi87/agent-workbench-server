"""kit2_review — the final check: the finished assembly and the reference in the SAME cameras, in one call. Never saves.

params:
  cameras  list of camera ids from the default set and the cameras saved with kit2_camera (default front, back, left, right)
  layout   "pairs" (default): one PNG per camera, the assembly on the left and the reference on the right, same framing, both in colour
           "modes": per camera one PNG of mode `color` (A: reference grey, parts in colour) and one of `wire` (B: see-through reference,
           parts as wireframe); `modes` can name others (plain, color, wire, refwire, or A, B, C)
  res      panel size px (default 512 for pairs = 1024 x 512 files, 768 for modes)
  tex      texture size px (default 1536; downscaled copies are cached per job, like the watch does)
  wire_alpha  opacity of the reference in `wire` (default 0.5)
Files: out/review-<camera>.png (pairs) or out/review-<camera>-<mode>.png. Open them via `post`. The live watch never files these.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_modes as M  # noqa: E402
import kit2_cams as C  # noqa: E402

import math  # noqa: E402


def effective_cameras():
    base = json.load(open(L.resolve("scripts/lib/camera-sets/default.json"), encoding="utf-8"))["shots"]
    cams = {c["id"]: {"id": c["id"], "position": c["position"], "target": c["target"], "fov": c["fov"]} for c in base}
    pj = os.path.join(L.ARGS["job_dir"], "cameras.json")
    if os.path.isfile(pj):
        for c in json.load(open(pj, encoding="utf-8"))["cameras"]:
            cams[c["id"]] = c
    return cams


def saved_ids():
    pj = os.path.join(L.ARGS["job_dir"], "cameras.json")
    return {c["id"] for c in json.load(open(pj, encoding="utf-8"))["cameras"]} if os.path.isfile(pj) else set()


def main():
    scn = bpy.context.scene
    allc = effective_cameras()
    ids = L.param("cameras") or ["front", "back", "left", "right"]
    unknown = [i for i in ids if i not in allc]
    if unknown:
        raise RuntimeError(f"no such camera: {', '.join(unknown)}; available: {', '.join(allc)}")
    layout = L.param("layout", "pairs")
    if layout not in ("pairs", "modes"):
        raise RuntimeError('layout must be "pairs" or "modes"')
    modes = [M.norm(m) for m in (L.param("modes") or ["color", "wire"])]
    res = int(L.param("res", 512 if layout == "pairs" else 768))
    ms = L.meshes()
    ref, assets = M.split(ms)
    if not assets:
        raise RuntimeError("nothing to review: the job has only the reference")
    if not ref:
        raise RuntimeError("no reference object (`ref`) in this job")
    if ref is not None:
        for cid, d in C.derived(ref).items():  # feet cameras from this character's measurements
            if cid in allc and cid not in saved_ids():
                allc[cid].update(position=d["position"], target=d["target"], fov=d["fov"])
    for o in scn.objects:
        o.hide_render = True
    M.swap_textures(assets + [ref], os.path.join(L.ARGS["job_dir"], "watch", "cache"), int(L.param("tex", 1536)))
    M.workbench(scn, res)
    M.strip_normals(assets + [ref])
    scn.render.image_settings.file_format = "PNG"
    rig = M.Rig(ref, assets, wire_alpha=M.job_wire_alpha(L.ARGS["job_dir"], L.param("wire_alpha")))
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    cam.data.clip_start, cam.data.clip_end = 0.02, 60
    scn.collection.objects.link(cam)
    scn.camera = cam

    def shoot(c, path):
        cam.data.angle = math.radians(float(c["fov"]))
        cam.location = Vector(c["position"])
        cam.rotation_euler = (Vector(c["target"]) - Vector(c["position"])).normalized().to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)

    out_dir = L.ARGS["out_dir"]
    files = []
    if layout == "pairs":
        for cid in ids:
            c = allc[cid]
            halves = []
            for label, show_ref in (("assembly", False), ("reference", True)):
                for o in assets:
                    o.hide_render = show_ref
                ref.hide_render = not show_ref
                tmp = os.path.join(out_dir, f"_review-{cid}-{label}.png")
                shoot(c, tmp)
                im = bpy.data.images.load(tmp)
                w, h = im.size
                halves.append(np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4))
                os.remove(tmp)
            row = np.concatenate(halves, axis=1)
            img = bpy.data.images.new(f"pair-{cid}", row.shape[1], row.shape[0], alpha=True)
            img.pixels = row.ravel()
            p = os.path.join(out_dir, f"review-{cid}.png")
            img.filepath_raw = p
            img.file_format = "PNG"
            img.save()
            files.append(p)
    else:
        for mode in modes:
            rig.apply(mode)
            for cid in ids:
                p = os.path.join(out_dir, f"review-{cid}-{mode}.png")
                shoot(allc[cid], p)
                files.append(p)
    L.finish({"layout": layout, "cameras": ids, "modes": modes if layout == "modes" else None,
              "left_right": "assembly | reference" if layout == "pairs" else None, "rendered": [os.path.basename(f) for f in files]}, files=files, save=False)


L.run(main)