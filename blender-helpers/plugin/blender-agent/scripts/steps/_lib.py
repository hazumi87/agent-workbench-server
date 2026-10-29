"""Shared helpers for step scripts. A step is run by scripts/run-step.mjs as

    blender --factory-startup -b [input.blend] --python-exit-code 1 --python <step>.py -- <args.json>

and must end with finish(...). finish() writes the report run-step reads; with
save=True it also saves the scene as the job's next .blend.
"""
import json
import os
import re
import sys
import traceback

import bpy
from mathutils import Vector


def load_args():
    path = sys.argv[sys.argv.index("--") + 1]
    with open(path, encoding="utf-8") as f:
        return json.load(f)


ARGS = load_args()
PARAMS = ARGS.get("params") or {}


def param(name, default=None):
    return PARAMS.get(name, default)


ID_RE = re.compile(r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)  # Library ids are uuids
INPUTS = []  # how each named input was given and where it ended up: reported by finish() as "inputs"


def is_id(p):
    return isinstance(p, dict) and "library_id" in p or isinstance(p, str) and bool(ID_RE.match(p))


def library_file(i):
    """Download a Library asset (any category) into downloads/library/<id><ext>, once, and return the path.
    The extension is the record's own (a mesh, an image, a zip...). The same cache the fetch verb fills."""
    import glob
    import urllib.request
    dl = os.path.join(ARGS["tool_root"], "downloads", "library")
    hit = [f for f in glob.glob(os.path.join(dl, i + ".*")) if not f.endswith(".part")]
    if hit:
        return hit[0]
    url = ARGS.get("library_url") or "http://localhost/asset-management/library"
    try:
        with urllib.request.urlopen(f"{url}/api/assets/{i}", timeout=30) as r:
            rec = json.loads(r.read())
        ext = (os.path.splitext(rec.get("filename") or "")[1] or ".bin").lower()
        dst = os.path.join(dl, i + ext)
        os.makedirs(dl, exist_ok=True)
        with urllib.request.urlopen(f"{url}/api/assets/{i}/file", timeout=300) as r, open(dst + ".part", "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.replace(dst + ".part", dst)
        return dst
    except Exception as e:
        raise RuntimeError(f"could not fetch Library asset {i}: {e}")


def resolve(p, what=None):
    """An input is a path (relative to the tool root, or absolute; "{job_dir}" is this job's folder), a Library id (an id-shaped string),
    or {"library_id": id} / {"path": p}. A Library id is downloaded once into downloads/library/ and its path returned.
    With `what` (the parameter's name) the form used is recorded and reported by finish() under "inputs"."""
    if isinstance(p, dict):
        if "library_id" in p:
            out, form = library_file(str(p["library_id"])), "library_id"
        elif "path" in p:
            out, form = resolve(str(p["path"])), "path"
        else:
            raise ValueError(f'{what or "input"}: give {{"library_id": id}} or {{"path": p}}, not {json.dumps(p)[:80]}')
    elif ID_RE.match(p):
        out, form = library_file(p), "library_id"
    else:
        p = p.replace("{job_dir}", ARGS["job_dir"])
        out, form = (p if os.path.isabs(p) else os.path.join(ARGS["tool_root"], p)), "path"
    if what:
        INPUTS.append({"input": what, "form": form, "path": out})
    return out


def finish(summary, save=False, ok=True, error=None, **extra):
    if save and ok:
        bpy.ops.wm.save_as_mainfile(filepath=ARGS["output"], compress=True)
    if INPUTS:
        extra.setdefault("inputs", INPUTS)
    report = {"ok": ok, "step": ARGS["step"], "saved": bool(save and ok), "summary": summary, **extra}
    if error:
        report["error"] = error
    def clean(o):
        # the report must be valid JSON: a NaN or an infinity (a distance to a thing that does not exist) becomes null
        if isinstance(o, float):
            return o if o == o and o not in (float("inf"), float("-inf")) else None
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [clean(v) for v in o]
        return o
    with open(ARGS["report"], "w", encoding="utf-8") as f:
        json.dump(clean(report), f, indent=2, default=str)


def run(main):
    """Wrap a step: any exception becomes a failed report (and a non-zero exit)."""
    try:
        main()
    except Exception as e:  # noqa: BLE001 - report every failure
        traceback.print_exc()
        finish(None, ok=False, error=f"{type(e).__name__}: {e}")
        sys.exit(1)


# ---- scene helpers ---------------------------------------------------------

def is_widget(o):
    """Rigify's control shapes (WGT-*, in a WGTS_* collection) are meshes too; they are not the character."""
    return o.name.startswith("WGT-") or any(c.name.startswith("WGTS") for c in o.users_collection)


def drop_factory_objects():
    """a job whose FIRST step builds geometry (no input checkpoint) starts from Blender's factory scene: its default Cube, Light and Camera are not wanted and would be exported; remove them and return their names ([] when the job has an input or they are not there)"""
    gone = []
    if not ARGS.get("input"):
        for on in ("Cube", "Light", "Camera"):
            o = bpy.data.objects.get(on)
            if o is not None:
                bpy.data.objects.remove(o, do_unlink=True)
                gone.append(on)
    return gone


def meshes():
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and not is_widget(o) and "blender_agent_marker" not in o]


def armatures():
    return [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]


def ref_object():
    """the reference mesh: the object named "ref"; in a parts-only job (no kit2_body yet) the ONLY mesh in the scene, which is then named "ref" so every later step finds it"""
    o = bpy.data.objects.get("ref")
    if o is not None:
        return o
    ms = meshes()
    if len(ms) == 1:
        ms[0].name = "ref"
        return ms[0]
    raise RuntimeError(f"no object named 'ref' and the scene has {len(ms)} meshes {[m.name for m in ms][:8]}: import the reference with import_mesh as_ref:true (or keep:[name] to leave one mesh), or run kit2_body")


def the_mesh():
    ms = meshes()
    if len(ms) != 1:
        raise RuntimeError(f"expected exactly one mesh, found {len(ms)}: {[m.name for m in ms][:8]}")
    return ms[0]


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def world_bbox(objs):
    """World-space (min, max) over mesh vertices, evaluated (modifiers/pose applied)."""
    dg = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        ev = o.evaluated_get(dg)
        m = ev.to_mesh()
        mw = o.matrix_world
        for v in m.vertices:
            w = mw @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        ev.to_mesh_clear()
    return lo, hi


def dims(objs):
    lo, hi = world_bbox(objs)
    return {"min": [round(c, 4) for c in lo], "max": [round(c, 4) for c in hi],
            "size": [round(c, 4) for c in (hi - lo)], "height": round(hi.z - lo.z, 4)}


def activate(obj, mode="OBJECT"):
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if mode != "OBJECT":
        bpy.ops.object.mode_set(mode=mode)
