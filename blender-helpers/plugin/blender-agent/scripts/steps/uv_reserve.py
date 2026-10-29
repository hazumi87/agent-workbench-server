"""uv_reserve — put an EMPTY first UV layer before LightmapUV on meshes where LightmapUV is the first layer (a mesh that had no UV0), so the glTF export writes LightmapUV as TEXCOORD_1 and an empty TEXCOORD_0. Only layer ORDER changes: the LightmapUV values are copied unchanged, so every baked map still matches. Saves a checkpoint (not with dry_run). Run it on a COPY of the bake checkpoint.
Why: lightmap_bake with weld_uv_only (before the added LightmapUV as the ONLY layer on receivers that had no UV0, so such meshes exported it as TEXCOORD_0 while the manifest says TEXCOORD_1.
params:
  objects  name globs (default every mesh that has a layer named LightmapUV)
  layer    the lightmap layer name (default "LightmapUV")
  dry_run  true: list what would change
Returns: changed (object names, count), already_ok, and `check`: every changed mesh's LightmapUV equals the old values (max difference), the layer order now (first, second), and which layer is render-active (the first).
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def main():
    lm = L.param("layer", "LightmapUV")
    pats = L.param("objects")
    dry = bool(L.param("dry_run", False))
    changed, ok, rows = [], 0, []
    seen = {}
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or "blender_agent_marker" in o:
            continue
        me = o.data
        if lm not in me.uv_layers or (pats and not any(fnmatch.fnmatchcase(o.name, p) for p in pats)):
            continue
        if me.name in seen:
            continue
        seen[me.name] = o.name
        layers = [u.name for u in me.uv_layers]
        if layers[0] != lm:
            ok += 1
            continue
        changed.append(o.name)
        if dry:
            continue
        n = len(me.uv_layers[lm].data)
        old = np.empty(n * 2, dtype=np.float32)
        me.uv_layers[lm].data.foreach_get("uv", old)
        me.uv_layers.remove(me.uv_layers[lm])
        me.uv_layers.new(name="UVMap")
        me.uv_layers.new(name=lm)
        me.uv_layers[lm].data.foreach_set("uv", old)  # looked up again by name: references to layers go stale when a layer is added
        chk = np.empty(n * 2, dtype=np.float32)
        me.uv_layers[lm].data.foreach_get("uv", chk)
        me.uv_layers["UVMap"].active_render = True
        me.uv_layers.active = me.uv_layers[lm]
        rows.append({"object": o.name, "max_uv_difference": float(np.abs(chk - old).max()) if n else 0.0, "layers": [u.name for u in me.uv_layers],
                     "render_active": next((u.name for u in me.uv_layers if u.active_render), None)})
    L.finish({"dry_run": dry, "changed": len(changed), "already_ok": ok, "objects": changed[:100],
              "check": {"max_uv_difference": max([r["max_uv_difference"] for r in rows] or [0]), "all_second": all(r["layers"][1] == lm for r in rows), "all_first_render_active": all(r["render_active"] == "UVMap" for r in rows)}},
             save=not dry, rows=rows[:60])


L.run(main)
