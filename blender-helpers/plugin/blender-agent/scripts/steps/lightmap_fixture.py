"""lightmap_fixture — a TINY standalone fixture for a lightmap LOADER: one named receiver quad with exported TEXCOORD_1 (skewed, asymmetric) different from TEXCOORD_0, and a matching packed .bin whose values encode the fixture, the texel (u, v), the layer and the channel. Not the site; no bake. Saves no checkpoint.
Files written into the step's output folder `lightmap-fixture/` (names start with `name`, default "lmfix-v1_1"): <name>.glb, <name>.bin, <name>.mask.u8, <name>.manifest.json (the exact the target runtime v1.1 fields), <name>.expected.json (samples to compare against).
Layout (32 x 32 texels, 2 layers = 8 fixtures F0..F7):
  value of fixture f at the texel in row y, column x:  T = (f + 1) + 0.5 * (x + 0.5) / 32 + 0.25 * (y + 0.5) / 32   (y = the ROW, row 0 = glTF v 0) for mask 1 and 2 texels, 0 for mask 0.
  decode: f = floor(T) - 1, then (x, y) from the fractions. Stored as half float, so decode with tolerance 0.001. Layer k = f div 4, channel c = f mod 4.
  The quad's TEXCOORD_1 corners (glTF u, v) in node order bottom-left, bottom-right, top-right, top-left: (0.125, 0.25) (0.875, 0.125) (0.75, 0.875) (0.25, 0.75); TEXCOORD_0 is the plain square (0,0) (1,0) (1,1) (0,1).
  Mask: 1 where a texel centre lies inside the skewed quad in UV1, 2 for texels within 2 of that region, else 0.
params: name (default "lmfix-v1_1"), pose / pose_angles (copied into the manifest; default closed/closed, 0/0)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import _lmpack as P  # noqa: E402

W = H = 32
LAYERS = 2
CORNERS_UV1 = [(0.125, 0.25), (0.875, 0.125), (0.75, 0.875), (0.25, 0.75)]  # exported glTF (u, v)
CORNERS_UV0 = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]


def inside(poly, p):
    c = False
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]:
            c = not c
    return c


def main():
    name = L.param("name", "lmfix-v1_1")
    L.drop_factory_objects()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    me = bpy.data.meshes.new("uvfix_quad")
    me.from_pydata([(-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 0, 0.5), (-0.5, 0, 0.5)], [], [(0, 1, 2, 3)])  # a quad standing in the XZ plane, facing -Y (Blender)
    me.update()
    for lname, corners in (("UVMap", CORNERS_UV0), ("LightmapUV", CORNERS_UV1)):
        uv = me.uv_layers.new(name=lname)
        for li, (u, v) in zip(me.polygons[0].loop_indices, corners):
            uv.data[li].uv = (u, 1.0 - v)  # Blender v is the flip of the exported glTF v
    mat = bpy.data.materials.new("uvfix_mat")
    mat.diffuse_color = (0.5, 0.5, 0.5, 1)
    me.materials.append(mat)
    o = bpy.data.objects.new("uvfix_quad", me)
    bpy.context.scene.collection.objects.link(o)
    # mask and data
    poly = [(u * W, v * H) for u, v in CORNERS_UV1]
    ys, xs = np.mgrid[0:H, 0:W]
    cen = np.stack([xs + 0.5, ys + 0.5], axis=-1)
    one = np.array([[inside(poly, tuple(cen[y, x])) for x in range(W)] for y in range(H)])
    near = one.copy()
    for _ in range(2):
        grown = near.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                grown |= np.roll(np.roll(near, dy, 0), dx, 1)
        near = grown
    label = np.where(one, 1, np.where(near, 2, 0)).astype(np.uint8)
    arr = np.zeros((LAYERS, H, W, 4), np.float32)
    for f in range(8):
        t = (f + 1) + 0.5 * (xs + 0.5) / W + 0.25 * (ys + 0.5) / H
        arr[f // 4, :, :, f % 4] = np.where(label > 0, t, 0.0)
    out = os.path.join(L.ARGS["out_dir"], "lightmap-fixture")
    os.makedirs(out, exist_ok=True)
    pb = os.path.join(out, name + ".bin")
    pm = os.path.join(out, name + ".mask.u8")
    pg = os.path.join(out, name + ".glb")
    with open(pb, "wb") as f:
        f.write(arr.astype("<f2").tobytes())
    with open(pm, "wb") as f:
        f.write(label.tobytes())
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.export_scene.gltf(filepath=pg, export_format="GLB", use_selection=True, export_yup=True, export_lights=False, export_apply=False, export_animations=False)
    man = P.hearth_manifest(W, H, LAYERS, [f"F{i}" for i in range(8)], L.param("pose", {"A": "closed", "B": "closed"}), L.param("pose_angles", {"A": 0, "B": 0}),
                            [{"node": "uvfix_quad", "primitive": 0}], 2, 0, pb, pm, pg)
    man["fixture"] = "standalone loader fixture, not the site: values encode fixture, texel, layer, channel (see expected.json)"
    with open(os.path.join(out, name + ".manifest.json"), "w", encoding="utf-8") as f:
        json.dump(man, f, indent=2)
    h16 = arr.astype(np.float16).astype(np.float64)
    samples = []
    cx = sum(c[0] for c in CORNERS_UV1) / 4
    cy = sum(c[1] for c in CORNERS_UV1) / 4
    pts = [("corner_%d_inset" % i, (c[0] + 0.12 * (cx - c[0]), c[1] + 0.12 * (cy - c[1]))) for i, c in enumerate(CORNERS_UV1)] + [("centre", (cx, cy))]
    for nm, (u, v) in pts:
        x, y = int(u * W), int(v * H)
        samples.append({"name": nm, "uv1_gltf": [round(u, 4), round(v, 4)], "texel_x": x, "texel_row_y": y, "mask": int(label[y, x]),
                        "per_fixture_decoded": [{"fixture": f"F{f}", "layer": f // 4, "channel": f % 4, "value": round(float(h16[f // 4, y, x, f % 4]), 4)} for f in range(8)]})
    exp = {"name": name, "note": "decode f = floor(T) - 1; T - (f+1) = 0.5*(x+0.5)/32 + 0.25*(y+0.5)/32 with x the column and y the ROW (row 0 = glTF v 0); stored as half float",
           "uv1_corners_gltf_in_node_order_BL_BR_TR_TL": CORNERS_UV1, "uv0_corners": CORNERS_UV0, "mask_counts": {str(k): int((label == k).sum()) for k in (0, 1, 2)}, "samples": samples,
           "wrong_orientation_looks_like": "flipping v reads row 31-y: the decoded y differs for every sample",
           "wrong_channel_looks_like": "UV0 is the plain square: reading TEXCOORD_0 gives different texels from TEXCOORD_1 for every corner"}
    with open(os.path.join(out, name + ".expected.json"), "w", encoding="utf-8") as f:
        json.dump(exp, f, indent=2)
    L.finish("fixture written", save=False, folder=out, files_written=sorted(os.listdir(out)), mask_counts=exp["mask_counts"], glb=P.meta(pg), bin=P.meta(pb), mask=P.meta(pm))


L.run(main)
