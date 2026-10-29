"""job_copy — start a NEW job from a saved checkpoint of another job (the source is only read). Saves the copy as this job's first checkpoint.
params:
  source_job  the job to copy from (e.g. "<job>")
  n           the step number of the checkpoint (e.g. 12); the file work/<source_job>/<NN>-*.blend (NN zero-padded to 2+ digits)
Returns: the source file (name, bytes, sha256), object counts by type, and the new checkpoint.
Run it as the FIRST verb of a fresh job name; nothing in the source job changes.
"""
import glob
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    if L.ARGS.get("input"):
        raise RuntimeError("job_copy must be the first verb of a new job")
    src_job = str(L.param("source_job"))
    n = int(L.param("n"))
    jobs = os.path.join(L.ARGS["tool_root"], "work")
    hit = sorted(glob.glob(os.path.join(jobs, src_job, f"{n:02d}-*.blend")))
    if len(hit) != 1:
        raise RuntimeError(f"expected exactly one {n:02d}-*.blend in work/{src_job}, found {len(hit)}")
    path = hit[0]
    raw = open(path, "rb").read()
    bpy.ops.wm.open_mainfile(filepath=path)
    by = {}
    for o in bpy.context.scene.objects:
        by[o.type] = by.get(o.type, 0) + 1
    L.finish(f"copied {os.path.basename(path)} from {src_job}", save=True, source={"job": src_job, "file": os.path.basename(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}, objects_by_type=by)


L.run(main)
