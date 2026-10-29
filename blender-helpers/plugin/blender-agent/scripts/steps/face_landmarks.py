"""face_landmarks — run MediaPipe FaceMesh (scripts/face_landmarks.py, in the
tools/facevenv venv) on an image, as a recorded step so the recipe replays.
Typically on render_front's output, so the landmarks map back to the mesh exactly.

params:
  image   default "{job_dir}/out/front_clay.png"
  out     default "{job_dir}/landmarks.json"
  python  default "tools/facevenv/Scripts/python.exe"
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import _lib as L  # noqa: E402


def main():
    image = L.resolve(L.param("image", "{job_dir}/out/front_clay.png"))
    out = L.resolve(L.param("out", "{job_dir}/landmarks.json"))
    py = L.resolve(L.param("python", "tools/facevenv/Scripts/python.exe"))
    script = os.path.join(L.ARGS["tool_root"], "scripts", "face_landmarks.py")
    r = subprocess.run([py, script, image, out], capture_output=True, text=True, timeout=300)
    last = (r.stdout.strip().splitlines() or ["{}"])[-1]
    try:
        res = json.loads(last)
    except ValueError:
        res = {"ok": False, "error": (r.stderr or last)[-300:]}
    if r.returncode != 0 or not res.get("ok"):
        L.finish(res, ok=False, error=res.get("error", f"exit {r.returncode}"))
        return
    L.finish({"landmarks": os.path.basename(out), "points": res["points"], "mouth_px": res["mouth_px"]}, files=[out])


L.run(main)
