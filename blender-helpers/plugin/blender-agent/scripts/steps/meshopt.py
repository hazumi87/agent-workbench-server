"""meshopt — compress every exported GLB in out/ for three.js (<name>.meshopt.glb)
and check it loads in three.js with the right skeleton, morph targets, animation
and height (scripts/meshopt.mjs). The uncompressed GLB stays as the broad-compat copy.

params:
  scene        true: a static SCENE (no skinned mesh, no animation) is ok when three.js loads it; the report adds nodes / meshes / lights counted by three.js (default false: the character check)
  positions    "default" (gltfpack's 14-bit quantised positions: it WARNS when the error is large, e.g. on a big scene) | "float" (-vpf: full float positions, recommended for scenes) | "16bit" (-vp 16)
  files        names of the GLBs in out/ to compress (default: every .glb that is not already .meshopt.glb)
  height_m     expected height (optional; fails if three.js sees more than 5 % off)
  morphs       morph target names that must survive (optional)
  animations   the exact clip names three.js must see (optional; catches leaked
               authoring actions)
"""
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import _lib as L  # noqa: E402


def main():
    out_dir = L.ARGS["out_dir"]
    srcs = [p for p in sorted(glob.glob(os.path.join(out_dir, "*.glb"))) if not p.endswith(".meshopt.glb")]
    if L.param("files"):
        want_files = set(L.param("files"))
        srcs = [p for p in srcs if os.path.basename(p) in want_files]
    pos = L.param("positions", "default")
    if pos not in ("default", "float", "16bit"):
        raise RuntimeError('positions must be "default", "float" or "16bit"')
    extra = (["--scene"] if L.param("scene", False) else []) + {"default": [], "float": ["-vpf"], "16bit": ["-vp", "16"]}[pos]
    if not srcs:
        raise RuntimeError("no .glb in out/: run export first")
    node = L.param("node", "node")
    script = os.path.join(L.ARGS["tool_root"], "scripts", "meshopt.mjs")
    results, fails = {}, []
    for src in srcs:
        dst = src[:-4] + ".meshopt.glb"
        r = subprocess.run([node, script, src, dst] + extra, capture_output=True, text=True, timeout=300)
        line = (r.stdout.strip().splitlines() or ["{}"])[-1]
        try:
            res = json.loads(line)
        except ValueError:
            res = {"ok": False, "error": (r.stderr or line)[-300:]}
        name = os.path.basename(dst)
        results[name] = res
        if not res.get("ok"):
            fails.append(f"{name}: {res.get('error', 'no skinned mesh or animation in three.js')}")
            continue
        want = L.param("height_m")
        if want and abs(res["three"]["height"] - want) > 0.05 * want:
            fails.append(f"{name}: three.js height {res['three']['height']} vs {want}")
        clips = sorted(a["name"] for a in res["three"]["animations"])
        want_clips = L.param("animations")
        if want_clips is not None and clips != sorted(want_clips):
            fails.append(f"{name}: animations {clips}, expected {sorted(want_clips)}")
        missing = [m for m in L.param("morphs", []) if m not in res["three"]["morphs"]]
        if missing:
            fails.append(f"{name}: missing morphs {missing}")
    summary = {k: {"bytes": v.get("out_bytes"), "ratio": v.get("ratio"), **(v.get("three") or {})} for k, v in results.items()}
    L.finish(summary, ok=not fails, error="; ".join(fails) or None, results=results)


L.run(main)
