"""kit2_view — render fixed world-space cameras of chosen objects; optionally one contact sheet. Never saves.

params:
  set     name of a stored camera set (scripts/lib/camera-sets/<name>.json); "default" = front, back, left, right, top, chest,
          waist, waist-below, waist-side, wrist-left, wrist-right, foot. Its shots are used when `shots` is not given.
  only    list of shot names: render just these (from the set or from `shots`)
  wire    true = wireframe render (Workbench, no textures); files get a "-wire" suffix. Use it on close-ups: on a whole
          character the lines merge
  shots   [{name, view, centre:[x,y,z] metres, size (ortho scale, metres)}]   view: front|back|left|right|top|below|bottom|three_quarter
  show    object names to render (default: every mesh); the rest are hidden. An unknown name is an error that lists the scene's
          objects; "ref" also works before kit2_body, when the imported mesh still has its own name
  paint   {name: [r, g, b, a]}  flat colour (and alpha) override per object, e.g. a translucent reference
  engine  "cycles" = the full-material render (CPU, slow; metals and lighting differ from the watch). Also used when `wire`, `paint`
          or `show` is given and no `mode`.
  mode    (default `plain` when none of engine/wire/paint/show is given) plain | color | wire | refwire (or A, B, C): a Workbench picture in one of the watch's four modes (see kit2_look), about 0.1 s each.
          The reference is then governed by the mode, so `show` names assets only. Files get the mode as suffix. wire_alpha (0.5) = how
          see-through the reference is in `wire`. Not combined with `wire`.
  wide    true/false: also render <name>-wide.png, the same view zoomed out `wide_factor` times (default 3). Default: on when at most
          3 views are rendered. The live watch files the close-up and the wide picture as two separate pictures.
  normal_maps  true: keep the materials' normal maps in the render (needs `engine`: "cycles"; the Workbench modes do not draw normal maps), for a full-material review of the real PBR look: base colour, roughness, metallic AND normal.
          Default false: the true-geometry views below. Compare the two renders of the same shot (`prefix` keeps the files apart). The report says which was used.
  Views never use normal maps (unless `normal_maps` is true) (cut from the materials in memory for the render, the file is untouched): they show the true
  geometry, with the glossy highlight kept. The published model keeps its normal maps.
  no_shadow  list of object names / globs: these objects stop CASTING shadows for this render only (Cycles ray visibility, set in memory; the file is never saved, so nothing changes). Use it with `engine` "cycles" and the same shot twice (with and without, different `prefix`) to tell a cast shadow from the object's own shading, e.g. a dark band on a crossed-card tree. Needs `engine` "cycles"; the report lists the objects switched. Everything else (camera, sun, world) is identical.
  use_saved_sun  true: render with the scene's SAVED solar rig (scene_sun: its Sun lamp and Nishita sky) instead of this view's temporary sun and world; `sun_strength`, `world_strength` and `world_colour` are then ignored. Needs `engine` "cycles". Refused if no rig is saved.
  world_strength  default 1.0: strength of the sky / world light in the Cycles render ONLY (the view's own world is built for the render and never saved; the scene's materials and lights are untouched). A shaded area under a roof is lit by this fill: 2-6 brightens it like open daylight. `world_colour` [r, g, b] default [0.18, 0.18, 0.2] (a blue-ish sky: [0.5, 0.65, 0.9] for a daylight sky). `sun_strength` default 3.0: the render's own sun (the one it adds; it is not the scene's lights). The report lists the values used. Needs `engine` "cycles". Render the before and after views with the SAME values to keep them comparable.
  saved   true: render the cameras saved with kit2_camera instead (perspective, same frame as the live view)
  sheet   {name, shots:[shot names]}  one PNG with those shots side by side
  res     default 768 (sheet panels use `sheet_res`, default 512)
  prefix  file prefix
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
import kit2_modes as M  # noqa: E402
import kit2_cams as C  # noqa: E402

DIRS = {"front": Vector((0, -1, 0)), "back": Vector((0, 1, 0)), "left": Vector((1, 0, 0)),
        "right": Vector((-1, 0, 0)), "top": Vector((0, 0, 1)), "bottom": Vector((0, 0, -1)),
        "below": Vector((0, -0.6, -0.8)), "three_quarter": Vector((0.7, -0.7, 0))}


def paint_material(rgba):
    m = bpy.data.materials.new("paint")
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (rgba[0], rgba[1], rgba[2], 1)
    b.inputs["Alpha"].default_value = rgba[3] if len(rgba) > 3 else 1.0
    b.inputs["Roughness"].default_value = 0.8
    return m


def main():
    scn = bpy.context.scene
    ms = L.meshes()
    # like the live watch (Workbench, same lighting, no normal maps) unless the caller asks for the old full-material Cycles look
    custom = L.param("wire") or L.param("paint") or L.param("show") or L.param("engine") == "cycles"
    mode = M.norm(L.param("mode")) if L.param("mode") else (None if custom else "plain")
    if mode and L.param("wire"):
        raise RuntimeError("use either `mode` or `wire`, not both")
    ref, _assets = M.split(ms)
    given = L.param("show")
    if given:
        names = {o.name for o in ms}
        # before kit2_body has named it, the reference is the imported mesh under its own name: "ref" means that mesh
        mapped = [ref.name if (n == "ref" and ref is not None) else n for n in given]
        bad = [n for n in mapped if n not in names]
        if bad:
            raise RuntimeError(f"show names no object: {', '.join(bad)}. Objects in the scene: {', '.join(sorted(names))}")
        show = set(mapped)
    else:
        show = set(o.name for o in ms if not (mode and o is ref))
    for o in bpy.context.scene.objects:
        o.hide_render = o not in ms or o.name not in show
    for name, rgba in (L.param("paint") or {}).items():
        o = bpy.data.objects[name]
        o.data.materials.clear()
        o.data.materials.append(paint_material(rgba))
    wire = bool(L.param("wire", False))
    keep_normals = bool(L.param("normal_maps", False))
    if keep_normals and mode:
        raise RuntimeError('normal_maps needs engine "cycles" (the Workbench modes do not draw normal maps)')
    normals_cut = 0 if keep_normals else M.strip_normals([o for o in ms if not o.hide_render])  # views show the true geometry: no normal maps
    shadow_off = []
    if L.param("no_shadow"):
        if mode:
            raise RuntimeError('no_shadow needs engine "cycles" (the Workbench modes draw no cast shadows)')
        import fnmatch
        pats = L.param("no_shadow")
        pats = [pats] if isinstance(pats, str) else pats
        for o in ms:
            if any(fnmatch.fnmatchcase(o.name, g) for g in pats):
                o.visible_shadow = False
                shadow_off.append(o.name)
        if not shadow_off:
            raise RuntimeError(f"no_shadow: no mesh matches {pats}")
    if mode:
        rig = M.Rig(ref, [o for o in ms if o.name in show and o is not ref], wire_alpha=M.job_wire_alpha(L.ARGS["job_dir"], L.param("wire_alpha")))
        rig.apply(mode)
        M.workbench(scn, int(L.param("res", 768)))
    else:
        scn.render.engine = "CYCLES"
        scn.cycles.device = "CPU"
        scn.cycles.samples = int(L.param("samples", 24 if not wire else 16))
        scn.cycles.use_denoising = not wire
        scn.cycles.transparent_max_bounces = 16
    if wire:  # every shown object gets a dark material with the mesh edges drawn as bright 1.2-pixel lines
        wm = bpy.data.materials.new("wire")
        wm.use_nodes = True
        nt = wm.node_tree
        nt.nodes.clear()
        wf = nt.nodes.new("ShaderNodeWireframe")
        wf.use_pixel_size = True
        wf.inputs["Size"].default_value = 1.2
        dark = nt.nodes.new("ShaderNodeBsdfDiffuse")
        dark.inputs["Color"].default_value = (0.05, 0.05, 0.06, 1)
        glow = nt.nodes.new("ShaderNodeEmission")
        glow.inputs["Color"].default_value = (0.9, 0.9, 0.9, 1)
        glow.inputs["Strength"].default_value = 3.0
        mix = nt.nodes.new("ShaderNodeMixShader")
        out_ = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(wf.outputs["Fac"], mix.inputs["Fac"])
        nt.links.new(dark.outputs["BSDF"], mix.inputs[1])
        nt.links.new(glow.outputs["Emission"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out_.inputs["Surface"])
        for o in ms:
            if not o.hide_render:
                o.data.materials.clear()
                o.data.materials.append(wm)
    scn.render.image_settings.file_format = "PNG"
    solar = bool(L.param("use_saved_sun", False))
    saved_sun = bpy.data.objects.get("Solar_Sun") if solar else None
    if solar and not (saved_sun and "solar" in saved_sun):
        raise RuntimeError("use_saved_sun: no saved solar rig in this scene (run scene_sun first)")
    if solar and L.param("engine") != "cycles":
        raise RuntimeError('use_saved_sun needs "engine": "cycles"')
    if not mode and not solar:
        # a FRESH world for this render (never saved): the scene's own world may hold a linked sky (scene_sun), whose colour socket would ignore a default value
        scn.world = bpy.data.worlds.new("KitViewTemp")
        scn.world.use_nodes = True
        wc = L.param("world_colour") or [0.18, 0.18, 0.2]
        scn.world.node_tree.nodes["Background"].inputs[0].default_value = (float(wc[0]), float(wc[1]), float(wc[2]), 1)
        scn.world.node_tree.nodes["Background"].inputs[1].default_value = float(L.param("world_strength", 1.0))
        scn.world.color = (float(wc[0]), float(wc[1]), float(wc[2]))
    if solar:
        sun = saved_sun  # the saved rig's own lamp and sky; this render adds no sun and never saves
    else:
        sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
        sun.data.energy = float(L.param("sun_strength", 3.0))
        scn.collection.objects.link(sun)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    cam.data.type = "ORTHO"
    cam.data.clip_end = 100
    scn.collection.objects.link(cam)
    scn.camera = cam
    prefix = L.param("prefix", "kit")
    sheet = L.param("sheet")
    wanted = L.param("shots")
    if L.param("saved"):  # the cameras saved with kit2_camera: perspective, the same frame the live view shows
        pj = os.path.join(L.ARGS["job_dir"], "cameras.json")
        saved = json.load(open(pj, encoding="utf-8"))["cameras"] if os.path.isfile(pj) else []
        if not saved:
            raise RuntimeError("no saved cameras in this job: save one with kit2_camera first")
        wanted = [{"name": c["id"], "pose": c} for c in saved]
    if not wanted:
        with open(L.resolve(f"scripts/lib/camera-sets/{L.param('set', 'default')}.json"), encoding="utf-8") as fh:
            wanted = json.load(fh)["shots"]
    if not L.param("shots") and not L.param("saved") and ref is not None:  # the feet cameras are placed from this character's measurements
        der = C.derived(ref)
        for sh in wanted:
            d = der.get(sh["name"])
            if d:
                sh["centre"], sh["size"], sh["view"] = d["target"], d["size"], d["direction"]
    if L.param("only"):
        wanted = [w for w in wanted if w["name"] in L.param("only")]
        if not wanted:
            raise RuntimeError("`only` names no shot of the set")
    files, paths = [], {}
    want_wide = bool(L.param("wide")) if L.param("wide") is not None else len(wanted) <= 3
    res_main = int(L.param("res", 768))
    res_sheet = int(L.param("sheet_res", 512))
    for sh in wanted:
        scn.render.resolution_x = scn.render.resolution_y = res_sheet if (sheet and sh["name"] in sheet["shots"] and not L.param("also_singles")) else res_main
        if "pose" in sh:
            p = sh["pose"]
            cam.data.type = "PERSP"
            cam.data.sensor_fit = "AUTO"
            cam.data.angle = math.radians(float(p["fov"]))
            cam.data.clip_start = 0.02
            cam.location = Vector(p["position"])
            cam.rotation_euler = (Vector(p["target"]) - Vector(p["position"])).normalized().to_track_quat("-Z", "Y").to_euler()
            d = (Vector(p["position"]) - Vector(p["target"])).normalized()
        else:
            cam.data.type = "ORTHO"
            d = (Vector(sh["view"]) if isinstance(sh["view"], list) else DIRS[sh["view"]]).normalized()
            cam.data.ortho_scale = float(sh["size"])
            cam.location = Vector(sh["centre"]) + d * 5
            cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        if not solar:
            sun.rotation_euler = (-(d + Vector((0.3, 0, 0.6))).normalized()).to_track_quat("-Z", "Y").to_euler()
        suffix = f"-{mode}" if mode else "-wire" if wire else ""
        path = os.path.join(L.ARGS["out_dir"], f"{prefix}-{sh['name']}{suffix}.png")
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths[sh["name"]] = path
        files.append(path)
        if want_wide:  # the same view, further away: so a reader sees what the close-up is part of
            k = float(L.param("wide_factor", 3))
            if cam.data.type == "ORTHO":
                cam.data.ortho_scale *= k
            else:
                tgt = Vector(sh["pose"]["target"])
                cam.location = tgt + (cam.location - tgt) * k
            scn.render.filepath = path[:-4] + "-wide.png"
            bpy.ops.render.render(write_still=True)
            files.append(scn.render.filepath)
    if sheet:
        imgs = []
        for n in sheet["shots"]:
            im = bpy.data.images.load(paths[n])
            w, h = im.size
            imgs.append(np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4))
        row = np.concatenate(imgs, axis=1)
        h, w = row.shape[:2]
        out = bpy.data.images.new("sheet", w, h, alpha=True)
        out.pixels = row.ravel()
        sp = os.path.join(L.ARGS["out_dir"], f"{sheet['name']}.png")
        out.filepath_raw = sp
        out.file_format = "PNG"
        out.save()
        files.append(sp)
    L.finish({"rendered": [os.path.basename(f) for f in files], "normal_maps_in_view": "on" if keep_normals else "off", "normal_links_cut": normals_cut, "shadow_casting_off_for_this_render": shadow_off[:50], "world_strength": (None if solar else float(L.param("world_strength", 1.0))), "world_colour": (None if solar else list(L.param("world_colour") or [0.18, 0.18, 0.2])), "sun_strength": (round(float(saved_sun.data.energy), 4) if solar else float(L.param("sun_strength", 3.0))), "sun_strength_source": "saved rig lamp" if solar else "this view", "use_saved_sun": solar, "saved_sun": json.loads(saved_sun["solar"])["result"] if solar else None}, files=files)


L.run(main)