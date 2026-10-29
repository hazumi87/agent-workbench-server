"""export_check — verify a PUBLISHED GLB file, not the scene: read it, import it into a scratch scene, count what it really contains, measure it and render it from four directions. Read-only (nothing is saved; the checkpoint is not touched).

params:
  glb      the file: a path under the tool root or absolute, "out:<file>" for a file in this job's out/, or a Library id / {"library_id": id}
  views    four renders from the FILE: default ["front", "back", "side", "three_quarter"] (front = the camera on the -Y side); res px (default 640); shading "pbr" (default: the file's own materials, Cycles CPU, `samples` default 16) or "clay"
  size_m   the picture width in metres (default 1.4 x the file's largest extent)
Returns: file (bytes, sha256), counts (nodes, meshes, primitives, vertices, triangles, materials, textures, images, skins and joints, animations with seconds), images (name, mime, bytes, width x height), materials (name, base colour factor, roughness / metallic, which texture slots), generator and extensions, imported (objects, meshes, armatures, triangles after the import), bounds_m (min, max, size, height, in the Blender frame after import), problems (a list: external textures, materials without texture or colour, missing normals, empty meshes ...), map (when <file>.map.json is beside it: whether its sha256 matches this file), pictures.
"""
import hashlib
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
from _handview import render_views, render_views_pbr  # noqa: E402


def read_glb(path):
    with open(path, "rb") as f:
        b = f.read()
    if b[:4] != b"glTF":
        raise RuntimeError("not a binary glTF (.glb)")
    off, js, binb = 12, None, b""
    while off < len(b):
        ln, kind = struct.unpack_from("<II", b, off)
        chunk = b[off + 8: off + 8 + ln]
        if kind == 0x4E4F534A:
            js = json.loads(chunk.decode("utf8"))
        elif kind == 0x004E4942:
            binb = chunk
        off += 8 + ln
    return js, binb


def image_size(data):
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:2] == b"\xff\xd8":
            i = 2
            while i < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                m = data[i + 1]
                if m in (0xC0, 0xC1, 0xC2):
                    h, w = struct.unpack(">HH", data[i + 5: i + 9])
                    return w, h
                i += 2 + struct.unpack(">H", data[i + 2: i + 4])[0]
    except Exception:
        pass
    return None


def main():
    g = L.param("glb")
    if not g:
        raise RuntimeError("give `glb`")
    if isinstance(g, str) and g.startswith("out:"):
        path = os.path.join(L.ARGS["out_dir"], g[4:])
    else:
        path = L.resolve(g, what="glb")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    js, binb = read_glb(path)
    with open(path, "rb") as f:
        raw = f.read()
    sha = hashlib.sha256(raw).hexdigest()
    problems = []
    prims = [p for m in js.get("meshes", []) for p in m.get("primitives", [])]
    nv = sum(js["accessors"][p["attributes"]["POSITION"]]["count"] for p in prims if "POSITION" in p["attributes"])
    ntri = sum((js["accessors"][p["indices"]]["count"] if "indices" in p else js["accessors"][p["attributes"]["POSITION"]]["count"]) // 3 for p in prims)
    imgs = []
    for i, im in enumerate(js.get("images", [])):
        if "bufferView" in im:
            bv = js["bufferViews"][im["bufferView"]]
            data = binb[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
            sz = image_size(data)
            imgs.append({"index": i, "name": im.get("name"), "mime": im.get("mimeType"), "bytes": bv["byteLength"], "size_px": list(sz) if sz else None})
        else:
            imgs.append({"index": i, "name": im.get("name"), "uri": im.get("uri", "")[:80]})
            problems.append(f"image {i} is an external file ({im.get('uri', '')[:60]}), not embedded")
    mats = []
    for mi, m in enumerate(js.get("materials", [])):
        pb = m.get("pbrMetallicRoughness", {})
        slots = {}
        for nm, ti in (("baseColor", pb.get("baseColorTexture")), ("metallicRoughness", pb.get("metallicRoughnessTexture")), ("normal", m.get("normalTexture")), ("occlusion", m.get("occlusionTexture")), ("emissive", m.get("emissiveTexture"))):
            if ti is not None:
                slots[nm] = {"image": js["textures"][ti["index"]].get("source"), "texCoord": ti.get("texCoord", 0)}
        mats.append({"index": mi, "name": m.get("name"), "baseColorFactor": [round(x, 4) for x in pb.get("baseColorFactor", [1, 1, 1, 1])], "roughness": pb.get("roughnessFactor"), "metallic": pb.get("metallicFactor"), "textures": slots, "double_sided": bool(m.get("doubleSided")), "emissive_factor": m.get("emissiveFactor"), "emissive_strength": (m.get("extensions", {}).get("KHR_materials_emissive_strength") or {}).get("emissiveStrength")})
        if not slots and "baseColorFactor" not in pb:
            problems.append(f"material {m.get('name')} has no texture and no colour factor (white)")
    for mi, m in enumerate(js.get("meshes", [])):
        if not m.get("primitives"):
            problems.append(f"mesh {mi} has no primitives")
    if any("NORMAL" not in p["attributes"] for p in prims):
        problems.append("some primitives carry no normals")
    anim = []
    for a in js.get("animations", []):
        t = 0.0
        for s in a.get("samplers", []):
            acc = js["accessors"][s["input"]]
            t = max(t, float(acc.get("max", [0])[0]) if acc.get("max") else 0.0)
        anim.append({"name": a.get("name"), "seconds": round(t, 3), "channels": len(a.get("channels", []))})
    out = {"file": {"name": os.path.basename(path), "bytes": len(raw), "sha256": sha},
           "counts": {"nodes": len(js.get("nodes", [])), "meshes": len(js.get("meshes", [])), "primitives": len(prims), "vertices": nv, "triangles": ntri, "materials": len(mats), "textures": len(js.get("textures", [])), "images": len(imgs),
                      "skins": len(js.get("skins", [])), "joints": sum(len(s.get("joints", [])) for s in js.get("skins", [])), "animations": len(anim)},
           "uv_sets": {"primitives_with_TEXCOORD_0": sum(1 for p in prims if "TEXCOORD_0" in p["attributes"]), "primitives_with_TEXCOORD_1": sum(1 for p in prims if "TEXCOORD_1" in p["attributes"]),
                       "primitives_with_TEXCOORD_1_only": sum(1 for p in prims if "TEXCOORD_1" in p["attributes"] and "TEXCOORD_0" not in p["attributes"])},
           "images": imgs, "materials": mats, "animations": anim, "generator": js.get("asset", {}).get("generator"), "extensions_used": js.get("extensionsUsed", [])}
    mp = path + ".map.json"
    if os.path.isfile(mp):
        try:
            mm = json.load(open(mp, encoding="utf-8"))
            out["map"] = {"file": os.path.basename(mp), "sha256_matches_this_file": mm.get("glb", {}).get("sha256") == sha, "scale_confidence": mm.get("scale_confidence"), "objects": mm.get("summary", {}).get("objects")}
            if not out["map"]["sha256_matches_this_file"]:
                problems.append("the map's sha256 does not match this file (a different export)")
        except Exception as e:
            out["map"] = {"error": str(e)[:100]}
    # ---- import it in a scratch state (the step saves nothing) and look
    before = set(bpy.data.objects.keys())
    acts_before = set(bpy.data.actions.keys())
    bpy.ops.import_scene.gltf(filepath=path)
    new = [bpy.data.objects[n] for n in bpy.data.objects.keys() if n not in before]
    ms = [o for o in new if o.type == "MESH"]
    ar = [o for o in new if o.type == "ARMATURE"]
    out["imported"] = {"objects": len(new), "meshes": len(ms), "armatures": len(ar), "triangles": sum(L.tris(o) for o in ms)}
    lights_in = [o for o in new if o.type == "LIGHT"]
    out["imported"]["lights"] = len(lights_in)
    out["imported"]["empties"] = len([o for o in new if o.type == "EMPTY"])
    out["imported_animations"] = [{"name": a.name, "frames": [round(a.frame_range[0], 2), round(a.frame_range[1], 2)], "fcurves": len(a.fcurves)} for a in bpy.data.actions if a.name not in acts_before][:60]
    if not ms:
        problems.append("the file imports no mesh")
    bpy.context.view_layer.update()
    if ms:
        pts = np.array([(o.matrix_world @ Vector(c))[:] for o in ms for c in o.bound_box])
        mn, mx = pts.min(0), pts.max(0)
        out["bounds_m"] = {"min": [round(float(x), 4) for x in mn], "max": [round(float(x), 4) for x in mx], "size": [round(float(x), 4) for x in (mx - mn)], "height": round(float(mx[2] - mn[2]), 4)}
        ctr = Vector(((mn + mx) / 2).tolist())
        ext = float(max(mx - mn))
        size = float(L.param("size_m", ext * 1.4))
        res = int(L.param("res", 640))
        dirs = {"front": Vector((0, -1, 0.15)), "back": Vector((0, 1, 0.15)), "side": Vector((-1, 0, 0.15)), "three_quarter": Vector((-0.6, -0.75, 0.4))}
        views = L.param("views") or ["front", "back", "side", "three_quarter"]
        dd = {v: dirs[v] for v in views}
        os.makedirs(L.ARGS["out_dir"], exist_ok=True)
        if L.param("shading", "pbr") == "pbr":
            files = render_views_pbr(new, ctr, size, "exportcheck", res, dd, samples=int(L.param("samples", 16)))
        else:
            files = render_views(new, ctr, size, "exportcheck", res, dd)
        out["pictures"] = [os.path.basename(f) for f in files]
    else:
        files = []
    out["problems"] = problems
    out["notes"] = ["read-only: the imported copy lives only in this step; the checkpoint is not touched", "the pictures are the FILE as Blender's glTF importer reads it, not the authoring scene"]
    # the node tree and the lights as the FILE has them (KHR_lights_punctual): names, parents, type, colour, intensity
    nodes = js.get("nodes", [])
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    ldefs = js.get("extensions", {}).get("KHR_lights_punctual", {}).get("lights", [])
    lrows = []
    for i, n in enumerate(nodes):
        li = n.get("extensions", {}).get("KHR_lights_punctual", {}).get("light")
        if li is not None and li < len(ldefs):
            d = ldefs[li]
            pn = nodes[parent[i]].get("name") if i in parent else None
            lrows.append({"node": n.get("name"), "parent": pn, "type": d.get("type"), "color": d.get("color"), "intensity": d.get("intensity"), "range": d.get("range")})

    def depth(i):
        k = 0
        while i in parent:
            i, k = parent[i], k + 1
        return k
    names = [n.get("name") for n in nodes]
    dup = sorted({x for x in names if x is not None and names.count(x) > 1})
    out["tree"] = {"nodes": len(nodes), "roots": [nodes[i].get("name") for i in range(len(nodes)) if i not in parent][:40], "max_depth": max([depth(i) for i in range(len(nodes))] or [0]), "duplicate_names": dup[:20]}
    out["lights"] = {"count": len(lrows), "types": {t: sum(1 for r in lrows if r["type"] == t) for t in {r["type"] for r in lrows}}, "listed": lrows[:80], "extension_declared": "KHR_lights_punctual" in js.get("extensionsUsed", [])}
    if dup:
        problems.append(f"{len(dup)} node name(s) used more than once, e.g. {dup[:3]}: individually addressable parts need unique names")
    L.finish(out, save=False, files=files)


L.run(main)
