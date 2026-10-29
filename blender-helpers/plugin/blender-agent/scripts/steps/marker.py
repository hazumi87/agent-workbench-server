"""marker — put a labelled MARKER at a world point and see it: a small sphere with three axis arms and a text label, in the collection `markers`, plus a framed clay picture from a camera with the marker in view and its pixel position. Saves a checkpoint.

The markers are NOT production geometry: every object carries the property blender_agent_marker, and export_kit / export_rig / export_bind / export_static never write them (export_kit lists meshes with L.meshes(), which skips flagged objects; the other exporters take only the objects they name). Nothing else in the scene is changed.

params:
  points    list of {"name": "pin_a", "label": "A: door frame corner", "point": [x, y, z], "size": 0.04 (the sphere's radius in metres: default 0.03, arms 4x), "colour": [r, g, b] (default red), "label_offset": [dx, dy, dz] (default straight up by 5 x size)}
  units     "m" (default) | "mm" for every coordinate and size above
  camera    {"name": "cam_door"} an existing camera object of the scene, used as it is; or {"dir": [x, y, z], "distance": 2.0} a camera placed that far from the (first or mean of the) marked point(s) along that direction FROM the point, looking at it, with "fov_deg" (default 35) and "target": "first" | "mean" (default "mean"); default {"dir": [-0.5, -0.8, 0.45], "distance": 2.5}
  remove    names of markers to remove (only objects with the marker property are ever removed)
  show      "all" (default: the visible meshes and the markers) | "markers" (only the markers) | a list of object names to show with them
  res       px (default 900); name: file stem (default "marker")
Returns: markers (name, label, point_m, in_view, px [x, y] in the picture with the origin top-left, depth_m), camera (location, direction, fov, the matrix_world as 4 rows), picture, notes.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from bpy_extras.object_utils import world_to_camera_view  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_modes as M  # noqa: E402

PROP = "blender_agent_marker"


def clear(name):
    for suffix in ("", "_arm_x", "_arm_y", "_arm_z", "_label"):
        o = bpy.data.objects.get(name + suffix)
        if o is not None and PROP in o:
            bpy.data.objects.remove(o, do_unlink=True)


def make_mat(col):
    nm = "marker-" + "-".join(f"{c:.2f}" for c in col)
    m = bpy.data.materials.get(nm)
    if m is None:
        m = bpy.data.materials.new(nm)
        m.diffuse_color = (col[0], col[1], col[2], 1.0)
    return m


def main():
    k = 0.001 if L.param("units", "m") == "mm" else 1.0
    pts = L.param("points") or []
    removes = L.param("remove") or []
    scn = bpy.context.scene
    col = bpy.data.collections.get("markers")
    if col is None:
        col = bpy.data.collections.new("markers")
        scn.collection.children.link(col)
    report, removed = [], []
    for nm in removes:
        o = bpy.data.objects.get("marker_" + nm) or bpy.data.objects.get(nm)
        if o is not None and PROP in o:
            base = o["marker_name"] if "marker_name" in o else nm
            clear("marker_" + base)
            removed.append(nm)
    made_pts = []
    for p in pts:
        nm = p["name"]
        clear("marker_" + nm)
        P = Vector([float(x) * k for x in p["point"]])
        size = float(p.get("size", 0.03 / k if k != 1.0 else 0.03)) * k if "size" in p else 0.03
        colr = p.get("colour", [0.9, 0.1, 0.1])
        mat = make_mat(colr)
        parts = []
        bpy.ops.mesh.primitive_uv_sphere_add(radius=size, location=P, segments=16, ring_count=8)
        s = bpy.context.active_object
        s.name = "marker_" + nm
        parts.append(s)
        for ax, dims in (("x", (size * 8, size * 0.5, size * 0.5)), ("y", (size * 0.5, size * 8, size * 0.5)), ("z", (size * 0.5, size * 0.5, size * 8))):
            bpy.ops.mesh.primitive_cube_add(size=1.0, location=P)
            c = bpy.context.active_object
            c.scale = Vector(dims)
            c.name = f"marker_{nm}_arm_{ax}"
            parts.append(c)
        off = Vector([float(x) * k for x in p["label_offset"]]) if p.get("label_offset") else Vector((0, 0, size * 5))
        cu = bpy.data.curves.new("marker_" + nm + "_label", "FONT")
        cu.body = p.get("label", nm)
        cu.size = max(size * 2.2, 0.03)
        cu.align_x = "CENTER"
        lab = bpy.data.objects.new("marker_" + nm + "_label", cu)
        lab.location = P + off
        scn.collection.objects.link(lab)
        parts.append(lab)
        for o in parts:
            for c_ in list(o.users_collection):
                c_.objects.unlink(o)
            col.objects.link(o)
            o[PROP] = True
            o["marker_name"] = nm
            o["marker_label"] = p.get("label", nm)
            o["marker_point_m"] = [round(float(x), 6) for x in P]
            if o.type == "MESH":
                o.data.materials.clear()
                o.data.materials.append(mat)
        made_pts.append((nm, P, parts, lab))
    # ---- the camera
    cdef = L.param("camera") or {"dir": [-0.5, -0.8, 0.45], "distance": 2.5}
    allp = [x[1] for x in made_pts] or [Vector(o["marker_point_m"]) for o in bpy.data.objects if PROP in o and o.type == "MESH" and o.name.startswith("marker_") and "_arm_" not in o.name]
    tgt_mode = cdef.get("target", "mean")
    target = (allp[0] if tgt_mode == "first" else sum(allp, Vector()) / len(allp)) if allp else Vector()
    tmp_cam = None
    if "name" in cdef:
        cam = bpy.data.objects.get(cdef["name"])
        if cam is None or cam.type != "CAMERA":
            raise RuntimeError(f"no camera object named {cdef['name']}")
    else:
        d = Vector(cdef.get("dir", [-0.5, -0.8, 0.45])).normalized()
        dist = float(cdef.get("distance", 2.5)) * k
        cd = bpy.data.cameras.new("marker-cam")
        cd.lens_unit = "FOV"
        cd.angle = math.radians(float(cdef.get("fov_deg", 35)))
        cd.clip_start, cd.clip_end = 0.01, 500
        cam = bpy.data.objects.new("marker-cam", cd)
        scn.collection.objects.link(cam)
        cam.location = target + d * dist
        cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
        tmp_cam = cam
    bpy.context.view_layer.update()
    # label faces the camera
    for nm, P, parts, lab in made_pts:
        lab.rotation_euler = (cam.location - lab.location).to_track_quat("Z", "Y").to_euler()
    res = int(L.param("res", 900))
    old_cam = scn.camera
    scn.camera = cam
    M.workbench(scn, res)
    scn.display.shading.color_type = "MATERIAL"
    show = L.param("show", "all")
    hid = {o.name: o.hide_render for o in scn.objects}
    for o in scn.objects:
        if o is cam:
            continue
        is_marker = PROP in o
        if show == "markers":
            o.hide_render = not is_marker
        elif show == "all":
            o.hide_render = o.hide_render if not is_marker else False
        else:
            o.hide_render = not (is_marker or o.name in show)
    name = L.param("name", "marker")
    os.makedirs(L.ARGS["out_dir"], exist_ok=True)
    path = os.path.join(L.ARGS["out_dir"], f"{name}.png")
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    ms = []
    for o in bpy.data.objects:
        if PROP in o and o.type == "MESH" and o.name.startswith("marker_") and "_arm_" not in o.name:
            P = Vector(o["marker_point_m"])
            v = world_to_camera_view(scn, cam, P)
            inv = 0 <= v.x <= 1 and 0 <= v.y <= 1 and v.z > 0
            ms.append({"name": o["marker_name"], "label": o["marker_label"], "point_m": [round(float(x), 5) for x in P], "in_view": bool(inv), "px": [round(float(v.x) * res, 1), round(float((1 - v.y)) * res, 1)], "depth_m": round(float(v.z), 4)})
    camrep = {"location_m": [round(float(x), 4) for x in cam.matrix_world.translation], "direction": [round(float(x), 4) for x in (cam.matrix_world.to_3x3() @ Vector((0, 0, -1)))], "fov_deg": round(math.degrees(cam.data.angle), 2),
              "matrix_world": [[round(float(x), 6) for x in r] for r in cam.matrix_world], "named": "name" in cdef}
    for o in scn.objects:
        if o.name in hid:
            o.hide_render = hid[o.name]
    scn.camera = old_cam
    if tmp_cam is not None:
        bpy.data.objects.remove(tmp_cam, do_unlink=True)
    L.finish({"markers": ms, "removed": removed, "camera": camrep, "picture": os.path.basename(path),
              "notes": ["markers carry blender_agent_marker: no exporter writes them", "the picture is clay (Workbench) from the camera above; px origin is the top-left"]}, save=True, files=[path])


L.run(main)
