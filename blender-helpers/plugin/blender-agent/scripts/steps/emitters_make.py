"""emitters_make — bare POINT-LIGHT emitters (no mesh, no fitting) at chosen places, for lights that are not string-light bulbs (a fire glow). Each is ONE light object whose name is its id, optionally parented to an existing object (placed in the PARENT's local glTF axes). Saves a checkpoint (not with dry_run). Geometry, UVs, materials and every other object are untouched.

params:
  emitters   list of {"id": "EMIT-1", "parent": "Parent_Object" (optional; the object's exact name), "local_gltf": [x, y, z] (metres, in the PARENT's glTF axes: the numbers the exported node's `translation` will hold) | "world_gltf": [x, y, z] (metres, glTF world axes, Y up), "expect_world_gltf": [x, y, z] (optional: refuse unless the result lands within 0.1 mm of it)}; give local_gltf or world_gltf. Without `parent`, local_gltf is the world position.
  light      {"intensity_cd": 1.0 (default; or "energy_w"), "colour": [1, 1, 1], "radius_mm": 0, "shadow": true}  the same for every emitter; an emitter may carry its own "light" to override keys
  replace    true: rebuild an emitter of the same id that this verb made (default false: an existing one is left alone and reported)
  dry_run    true: nothing is made; the report shows the positions that would result
Axes: Blender is Z up, glTF is Y up, (x, y, z)_gltf = (x, z, -y)_blender. A local_gltf position is converted to the Blender local position (x, -z, y) of a child with an identity parent inverse, so the exported node's translation is exactly what you gave (the parent's own rotation and scale are carried by the parent node).
The light object is named exactly the id and carries the custom property `agent_emitter`; `lightmap_bake` takes it by that exact name in `bulbs` (see verb 84) and the map id is the name.
Returns: built / existing / refused, per emitter: light name, parent, `local_gltf`, `world_gltf` (computed from the scene as built), `world_blender`, `intensity_cd` and `energy_w` (W = cd x 4 pi / 683), `expect_error_mm`; `other_objects_changed` 0.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
from mathutils import Vector  # noqa: E402

MARK = "agent_emitter"


def g2b(v):
    return Vector((v[0], -v[2], v[1]))


def b2g(v):
    return [float(v[0]), float(v[2]), float(-v[1])]


def vec3(v, what):
    if not (isinstance(v, (list, tuple)) and len(v) == 3 and all(isinstance(c, (int, float)) and math.isfinite(c) for c in v)):
        raise RuntimeError(f"{what}: give three finite numbers")
    return [float(c) for c in v]


def main():
    ems = L.param("emitters")
    if not isinstance(ems, list) or not ems:
        raise RuntimeError("emitters: give a list")
    dry = bool(L.param("dry_run", False))
    replace = bool(L.param("replace", False))
    base = {"intensity_cd": 1.0, "colour": [1, 1, 1], "radius_mm": 0.0, "shadow": True, **(L.param("light") or {})}
    scn = bpy.context.scene
    snap = {o.name: (tuple(o.location), o.parent.name if o.parent else None) for o in bpy.data.objects}
    ids = [e.get("id") for e in ems]
    if len(set(ids)) != len(ids) or not all(isinstance(i, str) and i for i in ids):
        raise RuntimeError("emitters: every id must be a distinct non-empty string")
    built, existing, refused, rows = [], [], [], []
    for e in ems:
        i = e["id"]
        lt = {**base, **(e.get("light") or {})}
        cd = float(lt["intensity_cd"]) if "energy_w" not in lt else float(lt["energy_w"]) * 683.0 / (4 * math.pi)
        w = cd * 4 * math.pi / 683.0
        par = None
        if e.get("parent"):
            par = bpy.data.objects.get(e["parent"])
            if par is None:
                raise RuntimeError(f"{i}: parent {e['parent']!r} does not exist")
        if (e.get("local_gltf") is None) == (e.get("world_gltf") is None):
            raise RuntimeError(f"{i}: give exactly one of local_gltf and world_gltf")
        if e.get("local_gltf") is not None:
            lg = vec3(e["local_gltf"], f"{i}.local_gltf")
            lb = g2b(lg)
        else:
            wg = vec3(e["world_gltf"], f"{i}.world_gltf")
            wb = g2b(wg)
            lb = (par.matrix_world.inverted() @ wb) if par else wb
            lg = b2g(lb)
        ob = bpy.data.objects.get(i)
        if ob is not None and not (replace and MARK in ob and ob.type == "LIGHT"):
            (existing if MARK in ob else refused).append(i)
            rows.append({"id": i, "status": "exists (left alone)" if MARK in ob else "refused: an object of that name exists and was not made by this verb"})
            continue
        pm = par.matrix_world if par else None
        wb_ = (pm @ lb) if pm else lb
        row = {"id": i, "parent": par.name if par else None, "local_gltf": [round(c, 6) for c in lg], "world_gltf": [round(c, 6) for c in b2g(wb_)], "world_blender": [round(float(c), 6) for c in wb_],
               "intensity_cd": round(cd, 6), "energy_w": round(w, 6), "colour": lt["colour"], "radius_mm": lt["radius_mm"], "shadow": bool(lt["shadow"])}
        if e.get("expect_world_gltf") is not None:
            ex = vec3(e["expect_world_gltf"], f"{i}.expect_world_gltf")
            err = max(abs(a - b) for a, b in zip(b2g(wb_), ex)) * 1000.0
            row["expect_error_mm"] = round(err, 4)
            if err > 0.1:
                raise RuntimeError(f"{i}: the result lands {err:.3f} mm from expect_world_gltf (more than 0.1 mm); nothing made")
        rows.append(row)
        if dry:
            continue
        if ob is not None:
            bpy.data.objects.remove(ob, do_unlink=True)
        ld = bpy.data.lights.new(i, "POINT")
        ld.energy = w
        ld.color = lt["colour"][:3]
        ld.shadow_soft_size = float(lt["radius_mm"]) / 1000.0
        ld.use_shadow = bool(lt["shadow"])
        ob = bpy.data.objects.new(i, ld)
        ob[MARK] = True
        (par.users_collection[0] if par and par.users_collection else scn.collection).objects.link(ob)
        if par:
            ob.parent = par  # matrix_parent_inverse stays identity: the local position is exactly the node translation
        ob.location = lb
        built.append(i)
    bpy.context.view_layer.update()
    for r in rows:
        o = bpy.data.objects.get(r["id"])
        if o is not None and r["id"] in built:
            r["world_gltf_as_built"] = [round(c, 6) for c in b2g(o.matrix_world.translation)]
    other = sum(1 for n, (loc, p) in snap.items() if n in bpy.data.objects and (tuple(bpy.data.objects[n].location) != loc or (bpy.data.objects[n].parent.name if bpy.data.objects[n].parent else None) != p))
    if refused:
        raise RuntimeError(f"refused (object of that name exists, not made by this verb): {refused}")
    L.finish({"dry_run": dry, "built": built, "existing": existing, "refused": refused, "emitters": rows, "other_objects_changed": other,
              "note": "bake them with lightmap_bake bulbs [... , 'FIRE-1', ...]: an exact light-object name is taken as the map id when no bulb_<id>.light exists"}, save=not dry)


L.run(main)
