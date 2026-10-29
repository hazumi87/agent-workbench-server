"""view_capture — render named perspective views of chosen objects into MATCHED colour, depth and normal pictures plus one JSON with the exact cameras, so a runtime can use them as a cheap view (parallax, relighting) instead of carrying the dense scene. Saves NO checkpoint (the job is not changed); writes into work/<job>/out.

Colour is the surface colour as the materials define it (Cycles DIFFUSE COLOUR pass: texture and base colour, no lights, no shadows, no AO): it is NOT a lighting or ambient-occlusion bake and says nothing about light coming from outside. Depth and normals are exact (one sample per pixel, no denoise), so edges are not blurred across a depth jump.
params:
  views     [{"name": "dining-w1", "from": [x, y, z], "to": [x, y, z], "fov_deg": 60 (HORIZONTAL field of view), "res": [1024, 768]}]   [required]; world metres, camera up = world +Z
  objects   names / globs of the roots to render (each root's whole subtree is included, anything else is hidden for the render)   [required]
  near, far depth range in metres (defaults 0.1 and 20); the depth picture covers exactly this range
  prefix    file prefix (default "vcap")
  dry_run   true: nothing is rendered; reports which objects and triangles would be drawn and which files would be written
Outputs per view: <prefix>-<name>-colour.png (sRGB RGBA, alpha 0 where nothing is hit), <prefix>-<name>-depth16.png (16-bit grey: metres = near + v / 65535 * (far - near), clamped to the range), <prefix>-<name>-mask.png (8-bit grey: 255 = a surface was hit, 0 = background; the ONLY validity flag: a hit beyond `far` also reads v = 65535, and a hit nearer than `near` v = 0), <prefix>-<name>-normal.png (RGB: world-space normal n = pixel / 255 * 2 - 1; meaningless where the mask is 0), and <prefix>.capture.json (cameras: location, 4x4 matrix_world as 4 ROWS, fov horizontal / vertical, res, intrinsics fx fy cx cy in pixels; depth encoding; normal space; the objects drawn). Depth is the distance along the camera's forward axis (a z-depth), not along the pixel ray.
Limits: one viewpoint cannot show surfaces hidden from it; glass, reflection and transparency are not captured (a transparent material is drawn as its base colour); normals are WORLD-space only (the matrix in the json converts to camera space).
"""
import fnmatch
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def subtree(o, acc):
    acc.add(o)
    for c in o.children:
        subtree(c, acc)


def socket(node, *names):
    for n in names:
        s = node.outputs.get(n)
        if s is not None:
            return s
    raise RuntimeError(f"render layer has no {names[0]} output: {[s.name for s in node.outputs]}")


def main():
    scn = bpy.context.scene
    views = L.param("views") or []
    roots = L.param("objects") or []
    if not views or not roots:
        raise RuntimeError('give views [{"name": "w1", "from": [x,y,z], "to": [x,y,z], "fov_deg": 60, "res": [1024, 768]}] and objects ["RootName", ...]')
    near, far = float(L.param("near", 0.1)), float(L.param("far", 20.0))
    if not 0 < near < far:
        raise RuntimeError(f"near {near} and far {far}: need 0 < near < far")
    prefix = L.param("prefix", "vcap")
    dry = bool(L.param("dry_run", False))
    names = set()
    for v in views:
        nm = v.get("name", "")
        if not nm or not all(ch.isalnum() or ch in "-_." for ch in nm) or nm in names:
            raise RuntimeError(f"view name {nm!r}: letters, digits, - _ . only, and unique")
        names.add(nm)
        if len(v.get("from", [])) != 3 or len(v.get("to", [])) != 3 or Vector(v["from"]) == Vector(v["to"]):
            raise RuntimeError(f"view {nm}: from and to are two different [x, y, z] points")
        w, h = [int(x) for x in v.get("res", [1024, 768])]
        if not (16 <= w <= 4096 and 16 <= h <= 4096):
            raise RuntimeError(f"view {nm}: res {w}x{h} out of range 16..4096")
        if not 5 <= float(v.get("fov_deg", 60)) <= 150:
            raise RuntimeError(f"view {nm}: fov_deg must be 5..150")
    vis = set()
    unmatched = []
    for r in roots:
        hit = [o for o in bpy.data.objects if fnmatch.fnmatch(o.name, r)]
        if not hit:
            unmatched.append(r)
        for o in hit:
            subtree(o, vis)
    drawn = [o for o in vis if o.type == "MESH" and o.name in scn.objects]
    if not drawn:
        raise RuntimeError(f"no mesh under {roots} (unmatched: {unmatched})")
    tris = sum(len(o.data.polygons) for o in drawn)
    out_dir = L.ARGS["out_dir"]
    files = [f"{prefix}-{v['name']}-{k}.png" for v in views for k in ("colour", "depth16", "mask", "normal")] + [f"{prefix}.capture.json"]
    if dry:
        L.finish({"dry_run": True, "would_write": files, "objects_drawn": len(drawn), "faces_drawn": tris, "unmatched_roots": unmatched, "near": near, "far": far}, save=False)
        return
    os.makedirs(out_dir, exist_ok=True)
    for o in scn.objects:
        o.hide_render = o not in drawn
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = 1
    scn.cycles.use_denoising = False
    scn.cycles.film_exposure = 1.0
    scn.render.film_transparent = True
    scn.render.use_compositing = True
    scn.render.use_file_extension = True
    scn.view_settings.view_transform = "Standard"
    scn.view_settings.look = "None"
    scn.view_settings.exposure = 0.0
    scn.view_settings.gamma = 1.0
    vl = scn.view_layers[0]
    vl.use_pass_z = True
    vl.use_pass_normal = True
    vl.use_pass_diffuse_color = True
    scn.use_nodes = True
    nt = scn.node_tree
    nt.nodes.clear()
    rl = nt.nodes.new("CompositorNodeRLayers")
    rl.layer = vl.name
    # colour: diffuse colour + alpha
    sa = nt.nodes.new("CompositorNodeSetAlpha")
    nt.links.new(socket(rl, "DiffCol", "Diffuse Color"), sa.inputs[0])
    nt.links.new(socket(rl, "Alpha"), sa.inputs[1])
    o_col = nt.nodes.new("CompositorNodeOutputFile")
    o_col.base_path = out_dir
    o_col.format.file_format = "PNG"
    o_col.format.color_mode = "RGBA"
    o_col.format.color_depth = "8"
    o_col.format.color_management = "FOLLOW_SCENE"
    nt.links.new(sa.outputs[0], o_col.inputs[0])
    # depth: metres -> 0..1 over near..far; nothing hit -> 1
    mr = nt.nodes.new("CompositorNodeMapRange")
    mr.use_clamp = True
    mr.inputs[1].default_value = near
    mr.inputs[2].default_value = far
    mr.inputs[3].default_value = 0.0
    mr.inputs[4].default_value = 1.0
    nt.links.new(socket(rl, "Depth"), mr.inputs[0])
    o_dep = nt.nodes.new("CompositorNodeOutputFile")
    o_dep.base_path = out_dir
    o_dep.format.file_format = "PNG"
    o_dep.format.color_mode = "BW"
    o_dep.format.color_depth = "16"
    o_dep.format.color_management = "OVERRIDE"
    o_dep.format.view_settings.view_transform = "Raw"
    o_dep.format.view_settings.look = "None"
    nt.links.new(mr.outputs[0], o_dep.inputs[0])
    # mask: 1 where a surface was hit (the alpha pass; one sample per pixel, so exactly 0 or 1)
    o_msk = nt.nodes.new("CompositorNodeOutputFile")
    o_msk.base_path = out_dir
    o_msk.format.file_format = "PNG"
    o_msk.format.color_mode = "BW"
    o_msk.format.color_depth = "8"
    o_msk.format.color_management = "OVERRIDE"
    o_msk.format.view_settings.view_transform = "Raw"
    o_msk.format.view_settings.look = "None"
    nt.links.new(socket(rl, "Alpha"), o_msk.inputs[0])
    # normal: n * 0.5 + 0.5, stored raw
    m1 = nt.nodes.new("CompositorNodeMixRGB")
    m1.blend_type = "MULTIPLY"
    m1.inputs[0].default_value = 1.0
    m1.inputs[2].default_value = (0.5, 0.5, 0.5, 1.0)
    nt.links.new(socket(rl, "Normal"), m1.inputs[1])
    m2 = nt.nodes.new("CompositorNodeMixRGB")
    m2.blend_type = "ADD"
    m2.inputs[0].default_value = 1.0
    m2.inputs[2].default_value = (0.5, 0.5, 0.5, 0.0)
    nt.links.new(m1.outputs[0], m2.inputs[1])
    o_nor = nt.nodes.new("CompositorNodeOutputFile")
    o_nor.base_path = out_dir
    o_nor.format.file_format = "PNG"
    o_nor.format.color_mode = "RGB"
    o_nor.format.color_depth = "8"
    o_nor.format.color_management = "OVERRIDE"
    o_nor.format.view_settings.view_transform = "Raw"
    o_nor.format.view_settings.look = "None"
    nt.links.new(m2.outputs[0], o_nor.inputs[0])
    cam = bpy.data.objects.new("VCapCam", bpy.data.cameras.new("VCapCam"))
    scn.collection.objects.link(cam)
    scn.camera = cam
    cam.data.clip_start, cam.data.clip_end = near * 0.5, far * 2
    cam.data.sensor_fit = "HORIZONTAL"
    frame = 1
    scn.frame_set(frame)
    written, cams = [], []
    for v in views:
        nm = v["name"]
        w, h = [int(x) for x in v.get("res", [1024, 768])]
        fov = math.radians(float(v.get("fov_deg", 60)))
        scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = w, h, 100
        cam.data.angle = fov
        a, b = Vector(v["from"]), Vector(v["to"])
        cam.location = a
        cam.rotation_euler = (b - a).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        for node, kind in ((o_col, "colour"), (o_dep, "depth16"), (o_msk, "mask"), (o_nor, "normal")):
            node.file_slots[0].path = f"{prefix}-{nm}-{kind}-"
        bpy.ops.render.render(write_still=False)
        for kind in ("colour", "depth16", "mask", "normal"):
            raw = os.path.join(out_dir, f"{prefix}-{nm}-{kind}-{frame:04d}.png")
            fin = os.path.join(out_dir, f"{prefix}-{nm}-{kind}.png")
            if not os.path.exists(raw) and os.path.exists(raw[:-4]):
                os.rename(raw[:-4], raw)  # a build that leaves the extension off
            if not os.path.exists(raw):
                raise RuntimeError(f"the compositor wrote no {raw}")
            if os.path.exists(fin):
                os.remove(fin)
            os.rename(raw, fin)
            written.append(fin)
        fx = (w / 2) / math.tan(fov / 2)
        fvert = 2 * math.atan((h / 2) / fx)
        cams.append({"name": nm, "res": [w, h], "location": [round(x, 6) for x in cam.location], "matrix_world": [[round(x, 7) for x in row] for row in cam.matrix_world],
                     "fov_horizontal_deg": round(math.degrees(fov), 4), "fov_vertical_deg": round(math.degrees(fvert), 4), "intrinsics_px": {"fx": round(fx, 4), "fy": round(fx, 4), "cx": w / 2, "cy": h / 2},
                     "files": {k: f"{prefix}-{nm}-{k}.png" for k in ("colour", "depth16", "mask", "normal")}})
    meta = {"frame": "world metres, Z up; camera looks along its local -Z, local +Y is up, local +X is right; matrix_world is camera-to-world (4 rows)",
            "pixels": {"origin": "top-left of the PNG as stored: row 0 is the TOP, column 0 is the LEFT; no flip is needed", "ray": "for pixel (col u, row v) the camera-space direction is d = ((u + 0.5 - cx) / fx, -(v + 0.5 - cy) / fy, -1); world direction = matrix_world rotation x d; the point is camera_location + t * normalised(world d) with t = depth_along_axis * |d|"},
            "depth": {"encoding": "uint16 grey PNG", "metres": "near + v / 65535 * (far - near)", "near": near, "far": far, "kind": "z-depth: the distance along the camera's forward axis (-Z), NOT along the pixel ray", "clamped": "a hit nearer than near reads 0, a hit beyond far reads 65535; use the mask to tell a far hit from background"},
            "mask": {"encoding": "8-bit grey PNG", "meaning": "255 = a surface was hit (colour, depth and normal are valid), 0 = background (they are not)"},
            "normal": {"space": "world", "axes": "world X, Y, Z of the scene (Z up)", "decode": "n = pixel / 255 * 2 - 1", "encoding": "8-bit RGB PNG, stored raw (no colour transform)"},
            "colour": {"what": "diffuse colour pass (materials' own colour and textures, no lights): not a lighting or AO bake", "encoding": "sRGB 8-bit RGBA PNG; alpha 0 where nothing is hit, 255 where a surface is hit (one sample per pixel, no partial alpha)"},
            "objects_drawn": len(drawn), "faces_drawn": tris, "cameras": cams}
    jp = os.path.join(out_dir, f"{prefix}.capture.json")
    with open(jp, "w") as f:
        json.dump(meta, f, indent=1)
    written.append(jp)
    L.finish({"written": [os.path.basename(p) for p in written], "bytes": {os.path.basename(p): os.path.getsize(p) for p in written}, "objects_drawn": len(drawn), "faces_drawn": tris, "near": near, "far": far, "unmatched_roots": unmatched,
              "notes": ["no checkpoint was saved: the job is unchanged", "colour is the materials' own colour, not a lighting or AO bake", "normals are world-space; depth is a z-depth along the camera axis"]}, save=False, files=written)


L.run(main)
