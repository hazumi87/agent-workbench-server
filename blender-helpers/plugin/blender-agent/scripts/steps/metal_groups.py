"""metal_groups — vertex groups for METAL and for ROUGHNESS BANDS of a generated part, from its packed metallic-roughness map seen through the UVs (the glTF layout: green = roughness, blue = metallic). Writes vertex groups only; saves a checkpoint, or nothing with dry_run.

params:
  part              the object (required); uv: the UV layer (default the active one)
  image             the picture to sample (default the image feeding the material's Metallic input); metal_channel "B" (default) | "R" | "G"; rough_channel "G" (default) | "R" | "B"
  metal_threshold   a vertex is metal when its metallic value (0..1) is at least this (default 0.5)
  rough_bands       thresholds on roughness (0..1) that cut the part into bands, e.g. [0.35, 0.65] gives rough_0 (smooth, below 0.35), rough_1, rough_2 (default none: no roughness groups)
  prefix            the group name prefix (default "mat_"): <prefix>metal, <prefix>nonmetal, <prefix>rough_<n>
  clean_rings       majority-vote passes against speckle (default 2)
  dry_run, pictures, res   as colour_groups (the picture: metal in gold, the rest grey; the bands in grey-blue steps)
Returns: image and channels used, value statistics (min, mean, max of metallic and roughness), groups (name, vertices, share), speckle_removed, pictures.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import _matsample as MS  # noqa: E402

CH = {"R": 0, "G": 1, "B": 2}


def main():
    obj = bpy.data.objects.get(L.param("part", ""))
    if obj is None or obj.type != "MESH":
        raise RuntimeError("give `part`: a mesh object")
    me = obj.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None:
        raise RuntimeError("the part has no UV layer")
    im = MS.image_for(obj, "metallic", L.param("image"))
    img = MS.pixels(im)[..., :3]
    vals = MS.vertex_values(obj, img, uvn)
    mc, rc = CH[L.param("metal_channel", "B")], CH[L.param("rough_channel", "G")]
    metallic, rough = vals[:, mc], vals[:, rc]
    thr = float(L.param("metal_threshold", 0.5))
    pre = L.param("prefix", "mat_")
    pid, nbr, npos = MS.adjacency(obj)
    rings = int(L.param("clean_rings", 2))
    m0 = (metallic >= thr).astype(np.int64)
    m1 = MS.mode_filter(m0, pid, nbr, npos, rings) if rings > 0 else m0
    groups = [{"name": pre + "metal", "idx": np.nonzero(m1 == 1)[0]}, {"name": pre + "nonmetal", "idx": np.nonzero(m1 == 0)[0]}]
    bands = L.param("rough_bands") or []
    rl = np.zeros(len(rough), dtype=np.int64)
    if bands:
        rl = np.digitize(rough, sorted(bands))
        rl2 = MS.mode_filter(rl, pid, nbr, npos, rings) if rings > 0 else rl
        for b in range(len(bands) + 1):
            groups.append({"name": f"{pre}rough_{b}", "idx": np.nonzero(rl2 == b)[0]})
    changed = int((m1 != m0).sum())
    dry = bool(L.param("dry_run", False))
    if not dry:
        for g in groups:
            MS.set_group(obj, g["name"], g["idx"])
    files = []
    if L.param("pictures", True):
        lab = m1.copy()
        cols = [[150, 150, 150], [230, 180, 40]]
        files = MS.flat_pictures(obj, lab, cols, "metalgroups", int(L.param("res", 600)), names=[pre + "nonmetal", pre + "metal"], palette=False)
        if bands:
            steps = [[60 + 40 * b, 80 + 40 * b, 120 + 30 * b] for b in range(len(bands) + 1)]
            files += MS.flat_pictures(obj, rl2 if rings > 0 else rl, steps, "roughbands", int(L.param("res", 600)), names=[f"{pre}rough_{b}" for b in range(len(bands) + 1)], palette=False)
    out = {"part": obj.name, "image": im.name, "channels": {"metallic": L.param("metal_channel", "B"), "roughness": L.param("rough_channel", "G")}, "uv": uvn,
           "stats": {"metallic": [round(float(metallic.min()), 3), round(float(metallic.mean()), 3), round(float(metallic.max()), 3)], "roughness": [round(float(rough.min()), 3), round(float(rough.mean()), 3), round(float(rough.max()), 3)]},
           "metal_threshold": thr, "groups": [{"name": g["name"], "vertices": int(len(g["idx"])), "share_pct": round(float(len(g["idx"]) / len(vals) * 100), 1)} for g in groups], "speckle_removed": changed, "dry_run": dry,
           "pictures": [os.path.basename(f) for f in files], "notes": ["glTF packs roughness in green and metallic in blue; override the channels if this part's map is laid out differently", "a packed map is NOT sRGB: values are read as stored"]}
    L.finish(out, save=not dry, files=files)


L.run(main)
