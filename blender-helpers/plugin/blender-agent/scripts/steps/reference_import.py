"""reference_import — bring the video-to-3d reference bundle into the job's scene as reference-only objects. Saves a checkpoint.

Wraps the bundle's own helper (scripts/lib/import_reference.py): a collection `VideoTo3D_MetaReference` with, for each selected pose, a baked captured body mesh (923 vertices) and a 127-bone position-derived armature
(`MetaJoints_<pose>`: bone heads are the measured joints, tails are a drawing convention, no skin, no twist). Nothing else in the scene is changed; run it on a job that already holds the character.
These are NOT a production Meta skin rig and the bones do not deform the meshes.

params:
  bundle   the bundle: the extracted folder (a path under the tool root, e.g. "downloads/bundles/my-bundle", or absolute), OR the bundle's .zip (a path, a Library id, or {"library_id": id}); a zip is verified against its MANIFEST.json first and unzipped into downloads/bundles/<name>/ (required)
  verify   true (default): check every file listed in MANIFEST.json (size and SHA-256) before importing; a mismatch fails the verb
  show     the pose labels that start visible (default ["000500ms"]); the others are imported hidden. Labels are like 000500ms (see `poses` in the result)
Returns: bundle (name, files verified, bytes), coordinates (system, unit, floor_z, forward and inverse 4x4 transforms), poses (label, time_s, inferred, mesh and armature object names, visible, mesh height m, lowest point m),
joint_count, objects (every object created, with its type), collection, scene (units, fps, frame range), notes.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import _bundle as B  # noqa: E402
import import_reference as IR  # noqa: E402


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    b = L.param("bundle")
    if not b:
        raise RuntimeError("bundle is required")
    d = B.bundle(b)
    if not (d / "reference.json").is_file():
        raise RuntimeError(f"no reference.json in {d}: give the extracted bundle folder")
    verified, nbytes = 0, 0
    if L.param("verify", True):
        man = json.loads((d / "MANIFEST.json").read_text())
        bad = []
        for f in man["files"]:
            p = d / f["file"]
            if not p.is_file() or p.stat().st_size != f["bytes"] or sha256(p) != f["sha256"]:
                bad.append(f["file"])
            else:
                verified += 1
                nbytes += f["bytes"]
        if bad:
            raise RuntimeError(f"bundle files do not match MANIFEST.json: {', '.join(bad[:8])}{' ...' if len(bad) > 8 else ''}")
    ref = json.loads((d / "reference.json").read_text())
    before = set(bpy.data.objects.keys())
    res = IR.import_reference(str(d))
    show = set(L.param("show", ["000500ms"]))
    poses = []
    unknown = show - {p["label"] for p in ref["poses"]}
    if unknown:
        raise RuntimeError(f"no such pose label: {', '.join(sorted(unknown))}; the labels are {', '.join(p['label'] for p in ref['poses'])}")
    for p, made in zip(ref["poses"], res["poses"]):
        label = p["label"] + ("_INFERRED" if p["inferred"] else "")
        col = bpy.data.collections[made["collection"]]
        vis = p["label"] in show
        col.hide_viewport = not vis
        col.hide_render = not vis
        me = bpy.data.objects[made["mesh"]]
        v = np.array([x.co[:] for x in me.data.vertices])
        poses.append({"label": p["label"], "time_s": p["t_s"], "inferred": p["inferred"], "collection": col.name, "mesh": made["mesh"], "armature": made["armature"], "visible": vis,
                      "mesh_height_m": round(float(v[:, 2].max() - v[:, 2].min()), 3), "mesh_lowest_m": round(float(v[:, 2].min()), 3)})
    objs = [{"name": n, "type": bpy.data.objects[n].type} for n in sorted(set(bpy.data.objects.keys()) - before)]
    sc = bpy.context.scene
    co = ref["coordinates"]
    out = {"bundle": {"name": d.name, "files_verified": verified, "bytes": nbytes}, "coordinates": {"system": co["system"], "unit": co["unit"], "floor_z": co["floor_z"], "origin": co["origin"],
           "page_to_blender_4x4": co["page_to_blender_4x4"], "blender_to_page_4x4": co["blender_to_page_4x4"]}, "poses": poses, "joint_count": res["joint_count"], "collection": res["reference_collection"],
           "objects": objs, "scene": {"unit_system": sc.unit_settings.system, "scale_length": sc.unit_settings.scale_length, "fps": sc.render.fps, "frames": [sc.frame_start, sc.frame_end]},
           "notes": ref.get("limitations", [])[:5]}
    L.finish(out, save=True)


L.run(main)
