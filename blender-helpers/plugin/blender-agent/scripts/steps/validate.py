"""validate — re-import every exported file into an empty scene and check it.

Checks per file: exactly one armature with ONE root bone, one skinned mesh, bone count within
budget, every vertex weighted, at least one action, height within tolerance,
triangle count within budget. Leaves the job's .blend untouched (no save).

params:
  files          default: every .glb/.fbx in out/
  height_m       expected height (default: none -> just reported)
  height_tol     fraction, default 0.05
  max_bones      default 128
  max_tris       default 50000
  shape_keys     names that must survive the round trip (default none)
  clips          clip names every imported action must be (FBX imports as "arm|take")
"""
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def check(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if path.endswith(".glb"):
        bpy.ops.import_scene.gltf(filepath=path, disable_bone_shape=True)
    else:
        bpy.ops.import_scene.fbx(filepath=path)
    arms, ms = L.armatures(), L.meshes()
    r = {"file": os.path.basename(path), "armatures": len(arms), "meshes": len(ms),
         "bones": len(arms[0].data.bones) if arms else 0,
         "roots": [b.name for b in arms[0].data.bones if not b.parent] if arms else [],
         "tris": sum(L.tris(m) for m in ms), "actions": [a.name for a in bpy.data.actions],
         "shape_keys": [k.name for m in ms if m.data.shape_keys for k in m.data.shape_keys.key_blocks if k.name != "Basis"]}
    if ms:
        r["height"] = L.dims(ms)["height"]
        m = ms[0]
        r["unweighted"] = sum(1 for v in m.data.vertices if not any(g.weight > 1e-4 for g in v.groups))
    fails = []
    if len(arms) != 1:
        fails.append("armature count")
    if len(ms) != 1:
        fails.append("mesh count")
    if len(r["roots"]) != 1:
        fails.append(f"{len(r['roots'])} root bones")
    if r["bones"] > int(L.param("max_bones", 128)):
        fails.append(f"bones {r['bones']}")
    if r["tris"] > int(L.param("max_tris", 50000)):
        fails.append(f"tris {r['tris']}")
    if not r["actions"]:
        fails.append("no animation")
    want_clips = L.param("clips")  # e.g. ["Idle"]: every imported action must end in one of these
    if want_clips and not all(any(a.split("|")[-1] == c for c in want_clips) for a in r["actions"]):
        fails.append(f"clips {r['actions']} not in {want_clips}")
    if r.get("unweighted"):
        fails.append(f"{r['unweighted']} unweighted verts")
    missing_keys = [k for k in L.param("shape_keys", []) if k not in r["shape_keys"]]
    if missing_keys:
        fails.append(f"missing shape keys {missing_keys}")
    want = L.param("height_m")
    if want and abs(r.get("height", 0) - want) > float(L.param("height_tol", 0.05)) * want:
        fails.append(f"height {r.get('height')} vs {want}")
    r["pass"] = not fails
    r["fails"] = fails
    return r


def main():
    files = L.param("files") or sorted([p for p in glob.glob(os.path.join(L.ARGS["out_dir"], "*.glb"))
                                        if not p.endswith(".meshopt.glb")]  # meshopt is checked in three.js by the meshopt step
                                       + glob.glob(os.path.join(L.ARGS["out_dir"], "*.fbx")))
    if not files:
        raise RuntimeError("nothing to validate in out/")
    results = [check(L.resolve(f)) for f in files]
    ok = all(r["pass"] for r in results)
    L.finish({r["file"]: ("pass" if r["pass"] else r["fails"]) for r in results}, ok=ok,
             error=None if ok else "validation failed", results=results)


L.run(main)
