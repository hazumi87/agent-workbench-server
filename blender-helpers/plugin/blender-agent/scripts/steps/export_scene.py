"""export_scene — write named objects WITH their children, the node hierarchy and the Blender lights as one GLB (KHR_lights_punctual), and a `<name>.glb.map.json` next to it. Writes no checkpoint.

Where the other exporters write one mesh, this one keeps the tree: the empties made by scene_tree, the assemblies made by bulbs_make and their point lights go into the file as real nodes with the same names (so a runtime can find `bulb_1.light` or `Lighting`). Markers are never exported. Read the result back with export_check (its `tree` and `lights` sections).
params:
  roots    the objects to export, each with everything below it (default: every object that has no parent, markers excluded)
  name     file stem (default the job name)
  animations  "auto" (default: NLA tracks such as the louver_anim clips are written, one glTF animation per track name; with no animation nothing is written) | "none"
  lights   true (default): include the Blender lights; false leaves them out
  scale_confidence, scale_note   stored in the export map
  (node extras) an exported object that carries the custom property `agent_extras` (set by node_extras) gets that JSON as its node's `extras` in the file; nothing else is added, other nodes are exactly as before; the report lists `node_extras`
Returns: the file (name, bytes), the objects written (count by type), light count, the map summary, and a note on units: Blender point lights are in watts; glTF stores candela, converted by the exporter's standard lighting mode (check the runtime's convention).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import _exportmap as EM  # noqa: E402


def patch_extras(path, objs):
    """after the exporter has written the GLB: for every exported object that carries the custom property `agent_extras` (set by node_extras), put that JSON on the node of the same name as `extras` (merged with extras the exporter wrote). Only the JSON chunk changes; the binary chunk and all other nodes stay as they are. Returns {node name: extras}."""
    import json
    import struct
    want = {}
    for o in objs:
        raw = o.get("agent_extras")
        if raw:
            want[o.name] = json.loads(raw)
    if not want:
        return {}
    with open(path, "rb") as f:
        data = f.read()
    jl = struct.unpack("<I", data[12:16])[0]
    js = json.loads(data[20:20 + jl].decode("utf-8"))
    rest = data[20 + jl:]
    done = {}
    for n in js.get("nodes", []):
        if n.get("name") in want:
            ex = dict(n.get("extras") or {})
            ex.update(want[n["name"]])
            n["extras"] = ex
            done[n["name"]] = ex
    missing = sorted(set(want) - set(done))
    if missing:
        raise RuntimeError(f"agent_extras: no node named {missing} in the written file")
    body = json.dumps(js, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    body += b" " * ((4 - len(body) % 4) % 4)
    out = data[:12] + struct.pack("<I", len(body)) + data[16:20] + body + rest
    out = out[:8] + struct.pack("<I", len(out)) + out[12:]
    with open(path, "wb") as f:
        f.write(out)
    return done


def main():
    scn = bpy.context.scene
    names = L.param("roots")
    live = set(scn.objects)   # only the working scene: objects set aside by scene_archive keep their parent link but are not exported
    if names:
        roots = [bpy.data.objects[n] for n in names]
        gone = [r.name for r in roots if r not in live]
        if gone:
            raise RuntimeError(f"roots: not in the working scene (archived?): {gone}")
    else:
        roots = [o for o in scn.objects if o.parent is None and "blender_agent_marker" not in o]
    sel = []
    archived_skipped = 0
    for r in roots:
        for o in [r] + list(r.children_recursive):
            if o not in live:
                archived_skipped += 1
                continue
            if "blender_agent_marker" in o or (o.type == "LIGHT" and L.param("lights", True) is False):
                continue
            sel.append(o)
    if not sel:
        raise RuntimeError("nothing to export")
    name = L.param("name", L.ARGS["job"])
    path = os.path.join(L.ARGS["out_dir"], f"{name}.glb")
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for o in sel:
        o.select_set(True)
    bpy.context.view_layer.objects.active = sel[0]
    snap = EM.capture(sel)
    anim = L.param("animations", "auto")
    has_nla = any(o.animation_data and o.animation_data.nla_tracks for o in sel)
    kw = {}
    if anim == "none" or (anim == "auto" and not has_nla and not any(o.animation_data and o.animation_data.action for o in sel)):
        kw["export_animations"] = False
    elif has_nla:
        kw.update(export_animations=True, export_animation_mode="NLA_TRACKS")  # one glTF animation per NLA track name, e.g. door.open
    ifmt = L.param("image_format", "AUTO")
    if ifmt not in ("AUTO", "WEBP", "JPEG"):
        raise RuntimeError('image_format must be "AUTO", "WEBP" or "JPEG"')
    if ifmt != "AUTO":
        kw["export_image_format"] = ifmt
        kw["export_image_quality"] = int(L.param("image_quality", 85))  # Blender 4.5 name (export_jpeg_quality is not applied to WebP)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, use_active_scene=True, export_yup=True, export_lights=bool(L.param("lights", True)), export_apply=False, **kw)  # use_active_scene: without it the exporter also writes every OTHER scene of the file (the archive__ scenes of scene_archive) as extra glTF scenes
    extras_written = patch_extras(path, sel)
    emap = EM.write(path, snap, "export_scene", job=L.ARGS["job"], step=L.ARGS["step"], scale_confidence=L.param("scale_confidence", "unknown"), scale_note=L.param("scale_note"))
    by = {}
    for o in sel:
        by[o.type] = by.get(o.type, 0) + 1
    L.finish({"glb": {"file": os.path.basename(path), "bytes": os.path.getsize(path)}, "objects": by, "archived_objects_ignored": archived_skipped, "node_extras": extras_written, "lights": by.get("LIGHT", 0), "light_nodes": [{"name": o.name, "parent": o.parent.name if o.parent else None, "world_gltf": [round(float(o.matrix_world.translation[0]), 6), round(float(o.matrix_world.translation[2]), 6), round(-float(o.matrix_world.translation[1]), 6)]} for o in sel if o.type == "LIGHT"], "map": emap,
              "note": "Blender point lights are in watts; the glTF file stores candela (the exporter's standard lighting mode): the runtime must use the same convention"}, files={"glb": path, "map": path + ".map.json"})


L.run(main)
