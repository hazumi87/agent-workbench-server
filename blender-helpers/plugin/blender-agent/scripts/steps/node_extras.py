"""node_extras — save agreed metadata on ONE object so `export_scene` writes it as that glTF node's `extras` (nested objects, numbers, booleans, strings, lists). Nothing else changes: no other object, no geometry, no transform, no material. Saves a checkpoint (not with dry_run).

The JSON is stored on the object as the custom property `agent_extras` (a JSON string, kept exactly as given, so numbers such as 0.30 stay numbers and nothing is reordered or rounded by Blender's property system). `export_scene` then adds it, after the exporter has written the file, to the node of that name as `extras`; objects without `agent_extras` are exported exactly as before.
params:
  object   the object's exact name (required; an empty made by scene_tree is the usual target)
  extras   the JSON object to store (required unless `remove`), e.g. {"burner": {"length": 1, "width": 0.3, "corner_radius": 0.05}, "flame_height": {"low": 0.1, "typ": 0.22, "max": 0.35}, "base_clearance": 0, "estimate": true}
  merge    false (default: the stored value is REPLACED) | true: the new keys are merged into the stored object (nested objects merged key by key)
  remove   true: delete the stored metadata from the object
  dry_run  true: the report only
Returns: object (name, type, parent, children), `before` / `after` (the stored JSON, parsed), `serialized` (the exact string stored), `changed` (false when it is identical), and `other_objects_changed` 0 (the other objects' custom-property keys and the object's transform are compared before and after). Refuses a value that is not a JSON object, NaN / infinity, a name that does not exist, more than one object with that name pattern.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402

KEY = "agent_extras"


def check(v, path="extras"):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        raise RuntimeError(f"{path}: NaN / infinity is not JSON")
    if isinstance(v, dict):
        for k, x in v.items():
            if not isinstance(k, str):
                raise RuntimeError(f"{path}: keys must be strings")
            check(x, f"{path}.{k}")
    elif isinstance(v, list):
        for i, x in enumerate(v):
            check(x, f"{path}[{i}]")
    elif v is not None and not isinstance(v, (str, int, float, bool)):
        raise RuntimeError(f"{path}: {type(v).__name__} is not JSON")


def merge(a, b):
    out = dict(a)
    for k, v in b.items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def main():
    name = L.param("object")
    ob = bpy.data.objects.get(name or "")
    if ob is None:
        raise RuntimeError(f"object: no object named {name!r}")
    dry = bool(L.param("dry_run", False))
    before_s = ob.get(KEY)
    before = json.loads(before_s) if before_s else None
    snap = {o.name: sorted(o.keys()) for o in bpy.data.objects if o is not ob}
    mat0 = [list(r) for r in ob.matrix_world]
    if L.param("remove"):
        after = None
        ser = None
    else:
        ex = L.param("extras")
        if not isinstance(ex, dict):
            raise RuntimeError("extras: give a JSON object")
        check(ex)
        after = merge(before, ex) if (L.param("merge") and isinstance(before, dict)) else ex
        ser = json.dumps(after, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    changed = (before != after)
    if not dry:
        if ser is None:
            if KEY in ob:
                del ob[KEY]
        else:
            ob[KEY] = ser
    other = sum(1 for o in bpy.data.objects if o is not ob and sorted(o.keys()) != snap[o.name])
    L.finish({"object": {"name": ob.name, "type": ob.type, "parent": ob.parent.name if ob.parent else None, "children": [c.name for c in ob.children]},
              "dry_run": dry, "before": before, "after": after, "serialized": ser, "changed": changed, "other_objects_changed": other,
              "transform_unchanged": [list(r) for r in ob.matrix_world] == mat0,
              "note": "export_scene writes this as the node's `extras` (only for objects that carry it)"}, save=not dry)


L.run(main)
