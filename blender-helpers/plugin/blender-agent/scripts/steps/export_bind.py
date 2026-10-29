"""export_bind — the rigged character as ONE skinned GLB in its bind pose, with NO animation clips needed, then re-imported and checked. Saves no checkpoint.

For a character that is not animated yet (a rig you want to deliver, test or re-bind elsewhere): the mesh, its skin (the skeleton) and its materials, the armature at rest (any clip or NLA track on the rig is not
exported, and the pose is reset to rest), exported through the glTF Y-up conversion. Afterwards the file is read back (JSON and binary) and imported into a scratch scene to prove it.

params:
  name         file stem (default the job name)
  body         the mesh to export (default "body")
  tex          largest texture side in px (default 2048); a larger image is scaled down for the export only
  image_format "AUTO" (default: normal maps PNG, the rest JPEG), "PNG" (lossless everything) or "JPEG"
  jpeg_quality 1-100 (default 88)
  uv           name of the UV layer to export (made the active one first); default the active layer
  verify       true (default): re-import the file and compare it with the scene
Only the images that the body's own materials use are converted and listed under `mesh.images`; `images_in_glb` lists what the file really contains (name, mime type, bytes) and `images_in_scene_not_exported` the images
of other materials (an earlier material, a hidden copy) that are in the file but are not exported.
Returns: skin_joints (the exported joint order: index, name, parent index and name), materials_uv (per material: each texture slot's image and texCoord, the primitives using it and their TEXCOORD attributes, and which Blender UV layer each TEXCOORD set carries), glb (file, bytes), skin (joints, order_parent_before_child, root bones), mesh (primitives, vertices, triangles, materials, images with size and format, the UV layers), weights (all vertices have joints,
finite, normalised: worst sum error, vertices with a zero sum, more_than_4_influences), animations (the file's animation count: 0), rest_pose (when verify: mesh_drift_mm: the largest distance from a sampled scene vertex to the
re-imported mesh; joint_drift_mm: the largest difference of a joint position; armature and mesh node scale; bones posed away from rest: 0 expected), axes, height_m, notes.
  scale_confidence, scale_note  stored in the export map written next to the GLB (<name>.glb.map.json; default "unknown")
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import _exportmap as EM  # noqa: E402
import rig_common as R  # noqa: E402


def read_glb(path):
    with open(path, "rb") as f:
        f.read(12)
        n, _ = struct.unpack("<I4s", f.read(8))
        js = json.loads(f.read(n))
        rest = f.read(8)
        bn, _ = struct.unpack("<I4s", rest) if len(rest) == 8 else (0, b"")
        return js, f.read(bn)


CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def accessor(js, binb, i):
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    dt, nc = np.dtype(CT[a["componentType"]]), NC[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride")
    if stride and stride != dt.itemsize * nc:
        raw = np.frombuffer(binb, dtype=np.uint8, count=a["count"] * stride, offset=off).reshape(a["count"], stride)[:, :dt.itemsize * nc]
        arr = np.frombuffer(np.ascontiguousarray(raw).tobytes(), dtype=dt).reshape(a["count"], nc)
    else:
        arr = np.frombuffer(binb, dtype=dt, count=a["count"] * nc, offset=off).reshape(a["count"], nc)
    if a.get("normalized"):
        arr = arr.astype(np.float64) / np.iinfo(dt).max
    return arr


def glb_images(js, binb):
    """the images actually inside the GLB: name, mime type, bytes"""
    out = []
    for im in js.get("images", []):
        bv = js["bufferViews"][im["bufferView"]] if "bufferView" in im else None
        out.append({"name": im.get("name"), "mime": im.get("mimeType"), "bytes": bv["byteLength"] if bv else None, "uri": im.get("uri")})
    return out


def main():
    arm = R.find_rig()
    body = bpy.data.objects.get(L.param("body", "body"))
    if body is None or body.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('body', 'body')}")
    if not body.vertex_groups:
        raise RuntimeError("the body has no vertex weights: run rig_biped (bind) first")
    fmt = str(L.param("image_format", "AUTO")).upper()
    if fmt not in ("AUTO", "PNG", "JPEG"):
        raise RuntimeError('image_format must be "AUTO", "PNG" or "JPEG"')
    uvn = L.param("uv")
    if uvn:
        if uvn not in body.data.uv_layers:
            raise RuntimeError(f"no UV layer named {uvn}; the layers are {', '.join(u.name for u in body.data.uv_layers)}")
        body.data.uv_layers.active = body.data.uv_layers[uvn]
    ad = arm.animation_data
    if ad:
        for t in ad.nla_tracks:
            t.mute = True
        ad.action = None
    R.reset_pose(arm)
    tex = int(L.param("tex", 2048))
    q = int(L.param("jpeg_quality", 88))
    imgs, other = [], []
    # only the images the body's own materials use are converted and reported: the file also holds the images of materials that are not on the body (an earlier material, a hidden copy), and those are not exported
    used = set()

    def walk(nt, seen=()):
        for nd in nt.nodes:
            if nd.type == "TEX_IMAGE" and nd.image:
                used.add(nd.image.name)
            elif nd.type == "GROUP" and nd.node_tree and nd.node_tree.name not in seen:
                walk(nd.node_tree, seen + (nd.node_tree.name,))
    for slot in body.material_slots:
        if slot.material and slot.material.use_nodes:
            walk(slot.material.node_tree)
    for img in bpy.data.images:
        if img.users == 0 or img.size[0] == 0:
            continue
        if img.name not in used:
            other.append(img.name)
            continue
        if max(img.size) > tex:
            img.scale(max(1, round(img.size[0] * tex / max(img.size))), max(1, round(img.size[1] * tex / max(img.size))))
        img.file_format = ("PNG" if "normal" in img.name.lower() else "JPEG") if fmt == "AUTO" else fmt
        imgs.append({"name": img.name, "size": list(img.size), "format": img.file_format})
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    snap = EM.capture([body, arm])
    name = L.param("name", L.ARGS["job"])
    path = os.path.join(L.ARGS["out_dir"], f"{name}.glb")
    # Blender 4.5 has AUTO/JPEG/WEBP/NONE, no PNG: AUTO writes each image in the file_format set above, so "PNG" = every image PNG
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_image_format=("JPEG" if fmt == "JPEG" else "AUTO"), export_jpeg_quality=q,
                              export_skins=True, export_animations=False, export_def_bones=False, export_apply=False)
    emap = EM.write(path, snap, "export_bind", job=L.ARGS["job"], step=L.ARGS["step"], scale_confidence=L.param("scale_confidence", "unknown"), scale_note=L.param("scale_note"))
    js, binb = read_glb(path)
    nodes = js["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    skins = js.get("skins", [])
    joints = skins[0]["joints"] if skins else []
    pos = {j: k for k, j in enumerate(joints)}
    order_ok = all((parent.get(j) not in pos) or pos[parent[j]] < pos[j] for j in joints)
    roots = [j for j in joints if parent.get(j) not in pos]
    prims = [p for m in js.get("meshes", []) for p in m["primitives"]]
    nv = ntri = 0
    wsum_err, zero_sum, more4, finite = 0.0, 0, False, True
    for p in prims:
        at = p["attributes"]
        nv += js["accessors"][at["POSITION"]]["count"]
        ntri += js["accessors"][p["indices"]]["count"] // 3 if "indices" in p else 0
        if "JOINTS_1" in at:
            more4 = True
        if "WEIGHTS_0" in at:
            w = accessor(js, binb, at["WEIGHTS_0"]).astype(np.float64)
            if "WEIGHTS_1" in at:
                w = np.concatenate([w, accessor(js, binb, at["WEIGHTS_1"]).astype(np.float64)], axis=1)
            s = w.sum(1)
            finite = finite and bool(np.isfinite(w).all())
            zero_sum += int((s < 1e-6).sum())
            wsum_err = max(wsum_err, float(np.abs(s - 1)[s > 1e-6].max()) if (s > 1e-6).any() else 0.0)
    out = {"glb": {"file": f"{name}.glb", "bytes": os.path.getsize(path)}, "map": emap, "skin": {"skins": len(skins), "joints": len(joints), "order_parent_before_child": order_ok, "root_joints": len(roots)},
           "mesh": {"primitives": len(prims), "vertices": nv, "triangles": ntri, "materials": len(js.get("materials", [])), "images": imgs, "images_in_glb": glb_images(js, binb), "images_in_scene_not_exported": other, "uv_layers": [u.name for u in body.data.uv_layers],
                    "uv_exported": body.data.uv_layers.active.name if body.data.uv_layers.active else None},
           "weights": {"primitives_with_weights": sum(1 for p in prims if "WEIGHTS_0" in p["attributes"]), "finite": finite, "worst_sum_error": round(wsum_err, 6), "vertices_with_zero_sum": zero_sum,
                       "more_than_4_influences": more4},
           "animations": len(js.get("animations", [])), "axes": "glTF Y-up, -Z forward (Blender Z-up, -Y forward converted by the exporter); no animated armature scale", "notes": []}
    # ---- what the file really says: the skin's joint order with parents, and each material's textures with the TEXCOORD set they use (and which Blender UV layer that set is)
    jn = []
    for k, j in enumerate(joints):
        pj = parent.get(j)
        jn.append({"index": k, "name": nodes[j].get("name"), "parent_index": pos.get(pj), "parent_name": nodes[pj].get("name") if pj in pos else None})
    out["skin_joints"] = jn
    uvsets = {}
    for pi_, p in enumerate(prims):
        for ak in p["attributes"]:
            if ak.startswith("TEXCOORD_"):
                uvsets.setdefault(ak, []).append(pi_)
    tc_to_layer = {}
    layer_sets = {}
    for lay in body.data.uv_layers:
        arr = np.empty(len(body.data.loops) * 2)
        lay.data.foreach_get("uv", arr)
        arr = np.round(arr.reshape(-1, 2), 4)
        layer_sets[lay.name] = set(map(tuple, arr[:: max(len(arr) // 6000, 1)].tolist()))
    for ak, plist in uvsets.items():
        acc = np.concatenate([accessor(js, binb, prims[pj]["attributes"][ak]).astype(np.float64) for pj in plist])
        samp = np.round(np.stack([acc[:, 0], 1 - acc[:, 1]], 1), 3)
        samp = samp[(np.abs(samp[:, 0]) > 1e-9) | (np.abs(samp[:, 1] - 1.0) > 1e-9) & True] if False else samp[~((samp[:, 0] == 0) & (samp[:, 1] == 0))]  # the (0, 0) of loops that have no UV in this layer says nothing
        samp = samp[:: max(len(samp) // 4000, 1)]
        sc = {}
        allsets = {}
        for ln, st in layer_sets.items():
            arr = np.empty(len(body.data.loops) * 2)
            body.data.uv_layers[ln].data.foreach_get("uv", arr)
            allsets[ln] = set(map(tuple, np.round(arr.reshape(-1, 2), 3).tolist()))
            sc[ln] = float(np.mean([tuple(x) in allsets[ln] for x in samp.tolist()])) if len(samp) else 0.0
        best = max(sc, key=sc.get)
        tc_to_layer[ak] = {"best_layer": best, "match_fraction": {k_: round(v_, 3) for k_, v_ in sc.items()}, "primitives": plist}
    mats = []
    for mi, m in enumerate(js.get("materials", [])):
        pb = m.get("pbrMetallicRoughness", {})
        tex = {}
        for slot_name, ti in (("baseColor", pb.get("baseColorTexture")), ("metallicRoughness", pb.get("metallicRoughnessTexture")), ("normal", m.get("normalTexture")), ("occlusion", m.get("occlusionTexture")), ("emissive", m.get("emissiveTexture"))):
            if ti is not None:
                t = js["textures"][ti["index"]]
                im = js["images"][t["source"]] if t.get("source") is not None else {}
                tex[slot_name] = {"texCoord": ti.get("texCoord", 0), "image": im.get("name") or im.get("uri"), "image_index": t.get("source")}
        bm_ = bpy.data.materials.get(m.get("name", ""))
        blender_uv = None
        if bm_ is not None and bm_.use_nodes:
            blender_uv = sorted({(nd.uv_map if nd.type == "UVMAP" else None) for nd in bm_.node_tree.nodes if nd.type == "UVMAP"} - {None}) or ["(the active layer: no UV Map node)"]
        users = [pi_ for pi_, p in enumerate(prims) if p.get("material") == mi]
        mats.append({"index": mi, "name": m.get("name"), "textures": tex, "blender_uv_map": blender_uv, "primitives": users,
                     "primitive_texcoord_attributes": sorted({ak for pi_ in users for ak in prims[pi_]["attributes"] if ak.startswith("TEXCOORD_")})})
    out["materials_uv"] = {"materials": mats, "texcoord_sets": tc_to_layer, "note": "texCoord n = the file's TEXCOORD_n; texcoord_sets says which Blender UV layer each set carries (matched by value on a sample, v flipped)"}
    if L.param("verify", True):
        before = set(bpy.data.objects.keys())
        src_v = np.array([(body.matrix_world @ v.co)[:] for v in body.data.vertices])
        src_j = {b.name.split(":")[-1]: np.array((arm.matrix_world @ b.head_local)[:]) for b in arm.data.bones}
        bpy.ops.import_scene.gltf(filepath=path)
        new = [bpy.data.objects[n] for n in set(bpy.data.objects.keys()) - before]
        im = [o for o in new if o.type == "MESH"]
        ia = [o for o in new if o.type == "ARMATURE"]
        drift_m = drift_j = None
        posed = scales = None
        posed_list = []
        if im:
            iv = np.concatenate([np.array([(o.matrix_world @ v.co)[:] for v in o.data.vertices]) for o in im])
            from mathutils.kdtree import KDTree
            kd = KDTree(len(iv))
            for i, p in enumerate(iv):
                kd.insert(p, i)
            kd.balance()
            samp = src_v[np.random.default_rng(3).choice(len(src_v), min(4000, len(src_v)), replace=False)]
            drift_m = max(kd.find(p)[2] for p in samp)
        if ia:
            a2 = ia[0]
            jj = {b.name.split(":")[-1]: np.array((a2.matrix_world @ b.head_local)[:]) for b in a2.data.bones}
            common = [k for k in src_j if k in jj]
            drift_j = max(float(np.linalg.norm(src_j[k] - jj[k])) for k in common) if common else None
            dev = [(pb.name, float(np.abs(np.array(pb.matrix_basis) - np.eye(4)).max())) for pb in a2.pose.bones]
            posed_list = [{"bone": n, "max_matrix_deviation": round(x, 5)} for n, x in dev if x > 1e-4]
            posed = len(posed_list)
            scales = {"armature": [round(float(x), 5) for x in a2.matrix_world.to_scale()], "mesh": [round(float(x), 5) for x in im[0].matrix_world.to_scale()] if im else None,
                      "bones_matched": len(common), "bones_in_file": len(jj), "bones_in_scene": len(src_j)}
        for o in new:
            bpy.data.objects.remove(o)
        out["rest_pose"] = {"mesh_drift_mm": round(drift_m * 1000, 4) if drift_m is not None else None, "joint_drift_mm": round(drift_j * 1000, 4) if drift_j is not None else None,
                            "bones_posed_away_from_rest": posed, "posed_bones": (posed_list[:6] if ia else None), "scale": scales}
    v = np.array([(body.matrix_world @ x.co)[:] for x in body.data.vertices])
    out["height_m"] = round(float(v[:, 2].max() - v[:, 2].min()), 3)
    if more4:
        out["notes"].append("some vertices have more than 4 influences in the file (JOINTS_1): the consumer wants at most 4")
    L.finish(out, save=False)


L.run(main)
