"""dev_transfer_diag — DEV TOOL, read-only: run lightmap_bake's weld_uv_only UV transfer on the given receivers and report the per-receiver transfer rows (polygons / loops before and after the weld, mismatches, mode, duplicates kept apart) instead of only the refusal. Saves nothing."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import lightmap_bake as LB  # noqa: E402


def main():
    recv = LB.pick(L.param("receivers") or [], {"MESH"})
    LB.PACKER[0] = L.param("packer", "shelf")
    LB.TIE_RULE[0] = L.param("tie_rule", "inclusive")
    LB.SPLITOV[0] = bool(L.param("split_uv_overlaps", False))
    LB.SPARSE[:] = []
    LB.MINPX[0] = float(L.param("min_chart_px", 0))
    err = None
    try:
        LB.make_uvs(recv, int(L.param("atlas_px", 1024)), int(L.param("margin_px", 2)), L.param("density"), float(L.param("angle_limit_deg", 66)), float(L.param("weld_m", 0)), True)
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {e}"
    rows = {k: v for k, v in LB.TRANSFER.items()}
    info = {}
    for o in recv:
        me = o.data
        info[o.name] = {"vertices": len(me.vertices), "polygons": len(me.polygons), "loops": len(me.loops), "uv_layers": [u.name for u in me.uv_layers], "scale": [round(c, 4) for c in o.scale], "modifiers": [m.type for m in o.modifiers],
                        "users": me.users, "ngons": sum(1 for p in me.polygons if p.loop_total > 4), "zero_area": sum(1 for p in me.polygons if p.area < 1e-9)}
    L.finish({"error": err, "transfer": rows, "receivers": info}, save=False)


L.run(main)
