"""kit2_camera — save (or delete) a NAMED camera position for this job. Saves no checkpoint.

The saved cameras belong to the job. They are rendered, in the order they were saved, after the stored default cameras, in the
live view that people follow (and you can render them yourself with kit2_view `saved`). Saving an id that exists replaces its
pose and keeps its place in the order.

params:
  id         name of the camera: lowercase letters, digits and `-`, at most 31 characters; not "agent" (required)
  label      a short title for people (default: the id)
  fov        vertical field of view in degrees, 3 .. 100 (default 30). The frame is square.
  Either give the pose:
    position   [x, y, z] metres, the camera's place
    target     [x, y, z] metres, the point it looks at   (+X = the character's left, +Y = backwards, +Z = up)
  or ask to frame parts:
    frame      list of object names; the camera looks at their bounding-box centre from far enough that they just fit
    direction  where the camera sits relative to them: front|back|left|right|top|bottom|below|three_quarter, or [x, y, z]
               (default front)
    margin     how much room around them (default 1.2 = 20 % extra)
  delete     true: remove the saved camera `id`
Returns the saved pose (position, target, fov), the distance, the list of saved cameras in order, and for `frame` the box that was framed.
"""
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402

DIRS = {"front": (0, -1, 0), "back": (0, 1, 0), "left": (1, 0, 0), "right": (-1, 0, 0), "top": (0, 0, 1), "bottom": (0, 0, -1),
        "below": (0, -0.6, -0.8), "three_quarter": (0.7, -0.7, 0)}


def vec3(v, what):
    if not (isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in v)):
        raise RuntimeError(f"{what} must be three numbers [x, y, z] in metres")
    return [round(float(x), 4) for x in v]


def main():
    cid = L.param("id")
    if not isinstance(cid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", cid) or cid == "agent":
        raise RuntimeError('id must be lowercase letters, digits and "-" (at most 31 characters), and not "agent"')
    path = os.path.join(L.ARGS["job_dir"], "cameras.json")
    store = {"cameras": []}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            store = json.load(f)
    cams = store["cameras"]
    if L.param("delete"):
        if not any(c["id"] == cid for c in cams):
            raise RuntimeError(f"no saved camera named {cid}")
        cams[:] = [c for c in cams if c["id"] != cid]
        _write(path, store)
        L.finish({"deleted": cid, "saved_cameras": [c["id"] for c in cams]}, save=False)
        return
    fov = float(L.param("fov", 30))
    if not 3 <= fov <= 100:
        raise RuntimeError("fov must be between 3 and 100 degrees")
    label = str(L.param("label", cid))[:40]
    framed = None
    if L.param("frame"):
        names = L.param("frame")
        pts = []
        for n in names:
            if n not in bpy.data.objects:
                raise RuntimeError(f"no object named {n}")
            pts.append(K.verts(bpy.data.objects[n]))
        v = np.concatenate(pts)
        lo, hi = v.min(0), v.max(0)
        centre = (lo + hi) / 2
        radius = float(np.linalg.norm(hi - lo) / 2)
        d = L.param("direction", "front")
        dv = np.array(DIRS[d] if isinstance(d, str) else vec3(d, "direction"), dtype=float)
        if isinstance(d, str) and d not in DIRS:
            raise RuntimeError(f"direction must be one of {sorted(DIRS)} or [x, y, z]")
        dv = dv / np.linalg.norm(dv)
        dist = radius * float(L.param("margin", 1.2)) / math.tan(math.radians(fov) / 2)
        target = [round(float(x), 4) for x in centre]
        position = [round(float(x), 4) for x in centre + dv * dist]
        framed = {"box_min_mm": [K.mm(x) for x in lo], "box_max_mm": [K.mm(x) for x in hi], "distance_m": round(dist, 3)}
    else:
        position, target = vec3(L.param("position"), "position"), vec3(L.param("target"), "target")
        if position == target:
            raise RuntimeError("position and target are the same point")
    cam = {"id": cid, "label": label, "position": position, "target": target, "fov": round(fov, 2)}
    for i, c in enumerate(cams):
        if c["id"] == cid:
            cams[i] = cam
            break
    else:
        cams.append(cam)
    _write(path, store)
    L.finish({"saved": cam, "framed": framed, "saved_cameras": [c["id"] for c in cams]}, save=False)


def _write(path, store):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=1)
    os.replace(tmp, path)


L.run(main)