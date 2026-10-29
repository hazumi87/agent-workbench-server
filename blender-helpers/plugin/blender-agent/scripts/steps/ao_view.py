"""ao_view — READ-ONLY look at a stored AO map (lightmap_ao) on the real mesh, plus per-receiver statistics. Uses the EXISTING .ao.bin and the receivers' LightmapUV: no bake, no checkpoint, nothing in the scene stays changed (temporary materials and camera are removed, hidden objects restored). Run it on a copy of the bake checkpoint.
For each view three pictures (Cycles CPU, orthographic): `<prefix>-<view>-neutral.png` (white diffuse clay lit by a sun, no AO), `-ao.png` (the AO map shown flat as emission: 0 black = occluded, 1 white = open), `-applied.png` (the same clay with the AO as its colour, i.e. what AO does to the shading).
params:
  ao         path of the <name>.ao.json written by lightmap_ao (the .ao.bin beside it is read)   [required]
  receivers  name globs for the statistics (default: the receivers listed in the json)
  views      list of {"name": "roof", "objects": ["Frame_*", "Mesh_A"], "dir": [0.3, -0.5, -1.0] (the direction the camera stands in, from the centre), "margin": 1.15 (optional)}; only the named objects are rendered (the others are hidden); the camera frames their bounding box
  res        pixels (default 800); samples (default 16); sun_dir [x, y, z] (default from above and the side)
  prefix     file prefix (default "aoview")
Returns: per group the same split by face direction (`by_face_direction`: up = normal Z > 0.5, side, down = Z < -0.5; texels, AO mean, share below 0.5), so hidden undersides can be told from visible faces; per receiver (name, area_m2, texels, AO mean, p10 / p50 / p90, share below 0.5 %), grouped totals by the part of the name before the first "." and "__" levels (louvers, deck, ...), the AO file's sha256 check against its json, the pictures.
"""
import fnmatch
import hashlib
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import lightmap_bake as LB  # noqa: E402


def mats(img):
    out = {}
    for kind in ("neutral", "ao", "applied"):
        m = bpy.data.materials.new("aov_" + kind)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        o = nt.nodes.new("ShaderNodeOutputMaterial")
        if kind == "neutral":
            d = nt.nodes.new("ShaderNodeBsdfDiffuse")
            d.inputs["Color"].default_value = (0.8, 0.8, 0.8, 1)
            nt.links.new(d.outputs["BSDF"], o.inputs["Surface"])
        else:
            uvn = nt.nodes.new("ShaderNodeUVMap")
            uvn.uv_map = LB.LM
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = img
            t.interpolation = "Closest"
            nt.links.new(uvn.outputs["UV"], t.inputs["Vector"])
            if kind == "ao":
                e = nt.nodes.new("ShaderNodeEmission")
                nt.links.new(t.outputs["Color"], e.inputs["Color"])
                nt.links.new(e.outputs["Emission"], o.inputs["Surface"])
            else:
                d = nt.nodes.new("ShaderNodeBsdfDiffuse")
                nt.links.new(t.outputs["Color"], d.inputs["Color"])
                nt.links.new(d.outputs["BSDF"], o.inputs["Surface"])
        out[kind] = m
    return out


def main():
    ajson = L.resolve(L.param("ao"), what="ao")
    meta = json.load(open(ajson, encoding="utf-8"))
    W = meta["width"]
    binp = os.path.join(os.path.dirname(ajson), meta["bin"]["name"])
    raw = open(binp, "rb").read()
    sha_ok = hashlib.sha256(raw).hexdigest() == meta["bin"]["sha256"]
    ao = np.flipud(np.frombuffer(raw, dtype="<f2").reshape(W, W).astype(np.float32))  # Blender rows
    rglobs = L.param("receivers")
    exact = set(meta["receivers"])  # the json lists exact names (some contain [ ] which a glob would misread)
    recv = [o for o in bpy.context.scene.objects if o.type == "MESH" and (any(fnmatch.fnmatchcase(o.name, g) for g in rglobs) if rglobs else o.name in exact)]
    missing = sorted(exact - {o.name for o in recv}) if not rglobs else []
    for o in recv:
        if LB.LM not in o.data.uv_layers:
            raise RuntimeError(f"{o.name}: no {LB.LM}")
    cover, pos, nrm, owner, stats, empty = LB.raster(recv, W)
    rows, groups, dirs_ = [], {}, {}
    for oi, o in enumerate(recv):
        m = (owner == oi) & (cover > 0)
        v = ao[m]
        st = stats[oi]
        r = {"receiver": o.name, "area_m2": st["area_m2"], "texels": int(m.sum()), "ao_mean": round(float(v.mean()), 4) if v.size else None,
             "ao_p10_p50_p90": [round(float(np.percentile(v, q)), 4) for q in (10, 50, 90)] if v.size else None, "below_half_percent": round(float((v < 0.5).mean()) * 100, 2) if v.size else None}
        rows.append(r)
        g = o.name.split(".")[0] if o.name.startswith("Louver") else "__".join(o.name.split("__")[:2])
        groups.setdefault(g, []).append(v)
        nz = nrm[m][:, 2]
        for dn, sel in (("up", nz > 0.5), ("side", (nz <= 0.5) & (nz >= -0.5)), ("down", nz < -0.5)):
            dirs_.setdefault(g, {}).setdefault(dn, []).append(v[sel])
    gs = []
    for g, vs in sorted(groups.items()):
        v = np.concatenate(vs) if vs else np.zeros(0)
        bd = {}
        for dn, lst in dirs_.get(g, {}).items():
            x = np.concatenate(lst) if lst else np.zeros(0)
            bd[dn] = {"texels": int(x.size), "ao_mean": round(float(x.mean()), 4) if x.size else None, "below_half_percent": round(float((x < 0.5).mean()) * 100, 2) if x.size else None}
        gs.append({"group": g, "by_face_direction": bd, "receivers": len(vs), "texels": int(v.size), "ao_mean": round(float(v.mean()), 4) if v.size else None, "ao_p10_p50_p90": [round(float(np.percentile(v, q)), 4) for q in (10, 50, 90)] if v.size else None,
                   "below_half_percent": round(float((v < 0.5).mean()) * 100, 2) if v.size else None})
    # --- pictures
    files = []
    views = L.param("views") or []
    if views:
        img = bpy.data.images.new("aov_img", W, W, alpha=False, float_buffer=True)
        img.colorspace_settings.name = "Non-Color"
        rgba = np.ones((W, W, 4), np.float32)
        rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = ao
        img.pixels.foreach_set(rgba.ravel())
        img.pack()
        M = mats(img)
        scn = bpy.context.scene
        res, spp = int(L.param("res", 800)), int(L.param("samples", 16))
        old = (scn.render.engine, scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage, scn.camera, scn.world, scn.view_settings.view_transform)
        scn.render.engine = "CYCLES"
        scn.cycles.device = "CPU"
        scn.cycles.samples = spp
        scn.cycles.use_denoising = False
        scn.render.resolution_x = scn.render.resolution_y = res
        scn.render.resolution_percentage = 100
        scn.view_settings.view_transform = "Standard"
        w = bpy.data.worlds.new("aov_world")
        w.use_nodes = True
        w.node_tree.nodes["Background"].inputs[0].default_value = (0.6, 0.6, 0.6, 1)
        w.node_tree.nodes["Background"].inputs[1].default_value = 0.5
        scn.world = w
        sd = bpy.data.lights.new("aov_sun", "SUN")
        sd.energy = 2.5
        sun = bpy.data.objects.new("aov_sun", sd)
        scn.collection.objects.link(sun)
        sdir = Vector(L.param("sun_dir", [0.4, -0.3, 1.0])).normalized()
        sun.rotation_euler = (-sdir).to_track_quat("-Z", "Y").to_euler()
        cd = bpy.data.cameras.new("aov_cam")
        cd.type = "ORTHO"
        cam = bpy.data.objects.new("aov_cam", cd)
        scn.collection.objects.link(cam)
        scn.camera = cam
        hid = {o.name: o.hide_render for o in scn.objects}
        slots0 = {}
        prefix = L.param("prefix", "aoview")
        try:
            for v in views:
                objs = [o for o in scn.objects if o.type == "MESH" and "blender_agent_marker" not in o and any(fnmatch.fnmatchcase(o.name, g) for g in v["objects"])]
                if not objs:
                    raise RuntimeError(f"view {v['name']}: nothing matches {v['objects']}")
                pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
                lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
                hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
                ctr = (lo + hi) / 2
                size = (hi - lo).length * float(v.get("margin", 1.15)) * 0.75
                cd.ortho_scale = size
                d = Vector(v.get("dir", [0.6, -0.8, 0.7])).normalized()
                cd.clip_start, cd.clip_end = 0.01, max(50.0, size * 6)
                cam.location = ctr + d * max(10.0, size * 2.5)
                cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
                for o in scn.objects:
                    o.hide_render = not (o in objs or o in (cam, sun))
                for o in objs:
                    slots0.setdefault(o.name, [sl.material for sl in o.material_slots])
                for kind in ("neutral", "ao", "applied"):
                    for o in objs:
                        if not o.material_slots:
                            o.data.materials.append(M[kind])
                        for sl in o.material_slots:
                            sl.material = M[kind]
                    path = os.path.join(L.ARGS["out_dir"], f"{prefix}-{v['name']}-{kind}.png")
                    scn.render.filepath = path
                    bpy.ops.render.render(write_still=True)
                    files.append(path)
        finally:
            for nm, ms in slots0.items():
                o = bpy.data.objects.get(nm)
                if o is not None:
                    if not ms:
                        o.data.materials.clear()
                    for sl, m in zip(o.material_slots, ms):
                        sl.material = m
            for o in scn.objects:
                if o.name in hid:
                    o.hide_render = hid[o.name]
            bpy.data.objects.remove(cam, do_unlink=True)
            bpy.data.objects.remove(sun, do_unlink=True)
            scn.render.engine, scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage, scn.camera, scn.world, scn.view_settings.view_transform = old
            for m in M.values():
                bpy.data.materials.remove(m)
    L.finish({"ao_json": os.path.basename(ajson), "bin_sha256_matches_json": sha_ok, "receivers": len(recv), "receivers_in_json_not_found": missing, "groups": gs, "pictures": [os.path.basename(f) for f in files]},
             save=False, files=files, per_receiver=sorted(rows, key=lambda r: -(r["area_m2"] or 0))[:60])


L.run(main)
