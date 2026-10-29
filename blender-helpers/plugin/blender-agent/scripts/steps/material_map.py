"""material_map — the part's MATERIAL MAP in one pass: a vertex group per material colour (as colour_groups), each with its metal fraction and roughness from the packed map (as metal_groups), and a flat-colour layer (a colour attribute "MatMap": every vertex in its material's flat colour) so the part can be seen, exported or rigged by material. Saves a checkpoint, or nothing with dry_run.

Also stores the table on the part as the property material_map (JSON: group -> rgb, vertices, metal_fraction, roughness_mean, metallic_mean), for later verbs (rigidity for rig_multi, recolour, a bake).

params:
  part, uv, image, ranges, prefix, clean_rings, other, dry_run, pictures, res   as colour_groups (ranges are required here: run colour_groups with no ranges first to discover the colours)
  orm_image    the packed metallic-roughness picture (default the image feeding the material's Metallic input; none = the metal / roughness columns are left out)
  metal_threshold   a group counts as metal when at least this share of its vertices is metal (default 0.5 of vertices, each judged at metallic >= 0.5)
  attribute    the colour attribute name (default "MatMap")
Returns: materials (group, rgb range, vertices, share, metal_fraction, metallic_mean, roughness_mean, is_metal), unassigned, speckle_removed, the colour attribute written, pictures, notes.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import _matsample as MS  # noqa: E402


def main():
    obj = bpy.data.objects.get(L.param("part", ""))
    if obj is None or obj.type != "MESH":
        raise RuntimeError("give `part`: a mesh object")
    ranges = L.param("ranges")
    if not ranges:
        raise RuntimeError("give `ranges` (run colour_groups without ranges to discover the colours)")
    me = obj.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None:
        raise RuntimeError("the part has no UV layer")
    im = MS.image_for(obj, "base", L.param("image"))
    vals = MS.vertex_values(obj, MS.pixels(im)[..., :3] * 255.0, uvn)
    pid, nbr, npos = MS.adjacency(obj)
    rings = int(L.param("clean_rings", 2))
    lab0, dist = MS.classify(vals, ranges)
    lab = MS.mode_filter(lab0, pid, nbr, npos, rings) if rings > 0 else lab0
    metallic = rough = None
    orm_name = None
    try:
        orm = MS.image_for(obj, "metallic", L.param("orm_image"))
        ov = MS.vertex_values(obj, MS.pixels(orm)[..., :3], uvn)
        metallic, rough = ov[:, 2], ov[:, 1]
        orm_name = orm.name
    except RuntimeError:
        pass
    pre = L.param("prefix", "mat_")
    thr = float(L.param("metal_threshold", 0.5))
    table, dry = [], bool(L.param("dry_run", False))
    colours = [r["rgb"] for r in ranges]
    for i, r in enumerate(ranges):
        idx = np.nonzero(lab == i)[0]
        row = {"group": pre + r["name"], "rgb": r["rgb"], "vertices": int(len(idx)), "share_pct": round(float(len(idx) / len(lab) * 100), 1)}
        if metallic is not None and len(idx):
            mf = float((metallic[idx] >= 0.5).mean())
            row.update({"metal_fraction": round(mf, 3), "metallic_mean": round(float(metallic[idx].mean()), 3), "roughness_mean": round(float(rough[idx].mean()), 3), "is_metal": bool(mf >= thr)})
        table.append(row)
        if not dry:
            MS.set_group(obj, pre + r["name"], idx)
    un = np.nonzero(lab < 0)[0]
    if not dry and L.param("other"):
        MS.set_group(obj, pre + L.param("other"), un)
    attr = L.param("attribute", "MatMap")
    if not dry:
        flat = np.tile(np.array([0.5, 0.5, 0.5, 1.0]), (len(lab), 1))
        for i, c in enumerate(colours):
            sel = lab == i
            flat[sel] = [(c[0] / 255.0) ** 2.2, (c[1] / 255.0) ** 2.2, (c[2] / 255.0) ** 2.2, 1.0]  # stored linear
        a = me.color_attributes.get(attr)
        if a is not None:
            me.color_attributes.remove(a)
        ca = me.color_attributes.new(attr, "FLOAT_COLOR", "POINT")
        ca.data.foreach_set("color", flat.astype(np.float32).ravel())
        obj["material_map"] = json.dumps({r["group"]: {k: v for k, v in r.items() if k != "group"} for r in table})
    files = []
    if L.param("pictures", True):
        files = MS.flat_pictures(obj, lab, colours, "materialmap", int(L.param("res", 600)), names=[pre + r["name"] for r in ranges], palette=L.param("picture_colours", "palette") == "palette")
    L.finish({"part": obj.name, "image": im.name, "orm_image": orm_name, "materials": table, "unassigned": {"vertices": int(len(un)), "share_pct": round(float(len(un) / len(lab) * 100), 1)},
              "speckle_removed": int((lab != lab0).sum()), "colour_attribute": None if dry else {"name": attr, "domain": "POINT", "type": "FLOAT_COLOR (linear)"}, "dry_run": dry, "pictures": [os.path.basename(f) for f in files],
              "notes": ["the table is also stored on the part as the property material_map", "grey in the picture = no group"]}, save=not dry, files=files)


L.run(main)
