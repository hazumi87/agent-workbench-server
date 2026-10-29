"""colour_groups — vertex groups per MATERIAL COLOUR of a generated part, from its albedo seen through its UVs (before any bake): leather, metal, red strips, black sole. Writes vertex groups only (never moves or recolours anything); saves a checkpoint, or nothing with dry_run.

Each vertex takes the median albedo colour of the places its faces sample (a vertex on a UV seam has several). Without `ranges` the verb only DISCOVERS: it lists the `k` dominant colours of the part (k-means over its vertices) with their share and a flat-colour picture, so you can write the ranges. With `ranges` every vertex goes to the nearest range whose colour distance is within its `tol`, or to nothing; then `clean_rings` passes of a majority vote over each vertex's neighbours remove single-vertex speckle without moving a clean border.

params:
  part         the object (required); uv: the UV layer (default the active one); image: the picture to sample (default the base-colour image of the part's material)
  ranges       [{"name": "leather", "rgb": [120, 80, 50], "tol": 40}, ...] sRGB 0-255; tol is a colour distance (default 40). A group is named <prefix><name>
  prefix       the group name prefix (default "mat_")
  other        a group name for the vertices that match no range (default none: they get no group); a name there gives them that group
  clean_rings  majority-vote passes (default 2; 0 = none)
  k            how many dominant colours to list when there are no ranges (default 6)
  picture_colours  "palette" (default: each group in a distinct colour from a fixed palette, with a legend strip naming it) | "range" (the range's own rgb)
  dry_run      true: no group is written; the report and the picture only (always the case without ranges)
  pictures     true (default): the part with each group in its range colour (grey = no group); res px (default 600)
Returns: image used, discovered colours (rgb, share, vertices) when there are no ranges, groups (name, vertices, share, mean colour distance), unassigned, speckle_removed (vertices changed by the cleaning), pictures, notes.
"""
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
    me = obj.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None:
        raise RuntimeError("the part has no UV layer: the colours are read through its UVs")
    im = MS.image_for(obj, "base", L.param("image"))
    img = MS.pixels(im)[..., :3] * 255.0
    vals = MS.vertex_values(obj, img, uvn)
    ranges = L.param("ranges") or []
    pre = L.param("prefix", "mat_")
    out = {"part": obj.name, "image": im.name, "image_size": list(im.size), "uv": uvn, "vertices": len(me.vertices)}
    files = []
    res = int(L.param("res", 600))
    if not ranges:
        C, cnt = MS.kmeans(vals, int(L.param("k", 6)))
        lab = np.argmin(((vals[:, None, :] - C[None]) ** 2).sum(-1), axis=1) if len(vals) * len(C) < 6e7 else np.zeros(len(vals), int)
        out["discovered"] = [{"rgb": [int(round(x)) for x in c], "share_pct": round(float(n / cnt.sum() * 100), 1), "vertices_in_sample": int(n)} for c, n in zip(C, cnt)]
        if L.param("pictures", True):
            files = MS.flat_pictures(obj, lab, [list(c) for c in C], "colourgroups", res, names=[f"colour {i + 1}: rgb {int(round(c[0]))},{int(round(c[1]))},{int(round(c[2]))}" for i, c in enumerate(C)])
        out["pictures"] = [os.path.basename(f) for f in files]
        out["notes"] = ["no ranges given: nothing was written. Write ranges from these colours (rgb and a tol), then run again"]
        L.finish(out, save=False, files=files)
        return
    pid, nbr, npos = MS.adjacency(obj)
    lab0, dist = MS.classify(vals, ranges)
    lab = MS.mode_filter(lab0, pid, nbr, npos, int(L.param("clean_rings", 2))) if int(L.param("clean_rings", 2)) > 0 else lab0
    changed = int((lab != lab0).sum())
    groups = []
    for i, r in enumerate(ranges):
        idx = np.nonzero(lab == i)[0]
        groups.append({"name": pre + r["name"], "vertices": int(len(idx)), "share_pct": round(float(len(idx) / len(lab) * 100), 1), "mean_colour_distance": round(float(np.linalg.norm(vals[idx] - np.array(r["rgb"], float), axis=1).mean()), 1) if len(idx) else None,
                       "mean_rgb": [round(float(x), 1) for x in vals[idx].mean(0)] if len(idx) else None})
    un = np.nonzero(lab < 0)[0]
    oth = L.param("other")
    dry = bool(L.param("dry_run", False))
    if not dry:
        for i, r in enumerate(ranges):
            MS.set_group(obj, pre + r["name"], np.nonzero(lab == i)[0])
        if oth:
            MS.set_group(obj, pre + oth if not oth.startswith(pre) else oth, un)
    if L.param("pictures", True):
        files = MS.flat_pictures(obj, lab, [r["rgb"] for r in ranges], "colourgroups", res, names=[pre + r["name"] for r in ranges], palette=L.param("picture_colours", "palette") == "palette")
    out.update({"groups": groups, "unassigned": {"vertices": int(len(un)), "share_pct": round(float(len(un) / len(lab) * 100), 1)}, "speckle_removed": changed, "dry_run": dry, "pictures": [os.path.basename(f) for f in files],
                "notes": ["groups hold weight 1 on their vertices; an existing group of the same name is replaced", "grey in the picture = no group"]})
    L.finish(out, save=not dry, files=files)


L.run(main)
