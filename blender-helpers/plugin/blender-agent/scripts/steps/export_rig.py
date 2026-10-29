"""export_rig — the rigged body as ONE animated GLB: mesh, skin (the Mixamo-named skeleton) and every clip applied with rig_clip. No checkpoint.

Each clip is one glTF animation named after the clip (`idle`, `walking`, `mutant punch`): the Library viewer picks clips by that name.
Textures are scaled to `tex` px (normal maps stay PNG, the rest JPEG), as in export_kit. The published model KEEPS its normal maps.

params:
  name   file stem (default the job name)
  tex    texture size px (default 2048)
  body   the object to export (default "body")
Refuses when there is no rig, no clip, or the body has no vertex weights.
Returns: glb (file, bytes), animations (name, seconds), skin (joints, bones with weights), mesh (primitives with JOINTS_0/WEIGHTS_0), images_scaled.
After export, the file is read back and checked: `check` says whether every mesh primitive carries joints and weights and every animation channel
targets a joint of the skin.
  scale_confidence, scale_note  stored in the export map written next to the GLB (<name>.glb.map.json; default "unknown")
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import _exportmap as EM  # noqa: E402
import rig_common as R  # noqa: E402


def read_glb(path):
    with open(path, "rb") as f:
        f.read(12)
        n, _ = struct.unpack("<I4s", f.read(8))
        return json.loads(f.read(n))


def main():
    arm = R.find_rig()
    body = bpy.data.objects[L.param("body", "body")]
    ad = arm.animation_data
    tracks = [t for t in (ad.nla_tracks if ad else [])]
    if not tracks:
        raise RuntimeError("no clip on the rig: apply one with rig_clip first (a rig without a clip is exported by publishing it with rig_clip of any clip, or ask for a static skinned export)")
    if not body.vertex_groups:
        raise RuntimeError("the body has no vertex weights: run rig_biped (bind) first")
    for t in tracks:
        t.mute = False
    ad.action = None
    R.reset_pose(arm)
    tex = int(L.param("tex", 2048))
    scaled = 0
    for img in bpy.data.images:
        if img.users == 0 or img.size[0] == 0:
            continue
        if max(img.size) > tex:
            img.scale(tex, tex)
            scaled += 1
        img.file_format = "PNG" if "normal" in img.name.lower() else "JPEG"
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    snap = EM.capture([body, arm])
    name = L.param("name", L.ARGS["job"])
    path = os.path.join(L.ARGS["out_dir"], f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_image_format="AUTO", export_jpeg_quality=88,
                              export_skins=True, export_animations=True, export_animation_mode="NLA_TRACKS", export_force_sampling=True,
                              export_def_bones=False, export_optimize_animation_size=False)
    emap = EM.write(path, snap, "export_rig", job=L.ARGS["job"], step=L.ARGS["step"], scale_confidence=L.param("scale_confidence", "unknown"), scale_note=L.param("scale_note"))
    j = read_glb(path)
    skin_joints = set()
    for s in j.get("skins", []):
        skin_joints |= set(s.get("joints", []))
    prims = [p for m in j.get("meshes", []) for p in m["primitives"]]
    with_w = [p for p in prims if "JOINTS_0" in p["attributes"] and "WEIGHTS_0" in p["attributes"]]
    anims = []
    bad_channels = 0
    for a in j.get("animations", []):
        mx = 0.0
        for smp in a.get("samplers", []):
            acc = j["accessors"][smp["input"]]
            mx = max(mx, float(acc.get("max", [0])[0]))
        anims.append({"name": a.get("name"), "seconds": round(mx, 2), "channels": len(a.get("channels", []))})
        bad_channels += sum(1 for c in a.get("channels", []) if c["target"].get("node") not in skin_joints)
    names = [a["name"] for a in anims]
    check = {"primitives": len(prims), "primitives_with_joints_and_weights": len(with_w), "channels_not_on_a_joint": bad_channels,
             "ok": bool(prims) and len(with_w) == len(prims) and bool(j.get("skins")) and bool(anims)}
    L.finish({"glb": {"file": os.path.basename(path), "bytes": os.path.getsize(path)}, "map": emap, "animations": anims, "skin": {"skins": len(j.get("skins", [])), "joints": len(skin_joints)},
              "images_scaled": scaled, "tex": tex, "check": check,
              "note": "clip names in the file: " + ", ".join(names)}, files={"glb": path}, ok=check["ok"], error=None if check["ok"] else "the exported file failed its own check: " + json.dumps(check))


L.run(main)