"""uv_check — inspect a UV layer: islands, coverage and overlap, stretch, texel density, a layout picture and checker renders. Saves nothing.

params:
  body      the mesh (default "body")
  uv        the layer to check (default the active one)
  size      raster size for coverage / overlap (default 1024)
  layout    true (default): write out/uvcheck-layout.png (each island's edges in its own colour)
  checker   list of views to render with a colour-grid texture on the skin (default []), as in rig_view: "front", "back", "left", "right", "top", "three_quarter" or
            {"name": "face", "view": "front", "c": [x,y,z], "size": metres}; pictures out/uvcheck-<name>.png; "tiles": the grid's repeat count (default 16 squares across the sheet)
  res       checker picture px (default 768)
Returns: layer, layers, islands (count, sizes: largest/smallest share of the UV area), coverage_pct (of the 0-1 sheet), overlap_pct (texels covered by more than one triangle: islands lying over each other or folded UVs),
outside_pct (UV area outside 0-1), flipped_uv_triangles (mirrored against the surface: UV winding reversed), stretch (area-weighted median / p95 / max of the singular-value ratio: 1 = no distortion),
density (texel density relative to the median: p5 / p50 / p95 as multiples, and the face-to-body ratio when vertex groups name a Head), seams (edges).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_modes as M  # noqa: E402
import uv_common as UC  # noqa: E402

DIRS = {"front": (0, -1, 0), "back": (0, 1, 0), "left": (1, 0, 0), "right": (-1, 0, 0), "top": (0, 0, 1), "three_quarter": (0.6, -0.8, 0.35)}


def wquant(x, w, q):
    o = np.argsort(x)
    c = np.cumsum(w[o])
    return float(x[o][np.searchsorted(c, q * c[-1])])


def main():
    o = bpy.data.objects.get(L.param("body", "body"))
    if o is None or o.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('body', 'body')}")
    me = o.data
    lay = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if lay is None or lay not in me.uv_layers:
        raise RuntimeError(f"no such UV layer; the layers are {', '.join(u.name for u in me.uv_layers)}")
    tv, P, U, tl = UC.uv_arrays(me, lay)
    a3, a2, st = UC.tri_stretch(P, U)
    ok = np.isfinite(st) & (a3 > 1e-12)
    w = a3[ok]
    lab, n = UC.islands(me, lay)
    pt = np.array([me.loop_triangles[i].polygon_index for i in range(len(me.loop_triangles))])
    tri_isl = lab[pt]
    uvarea = np.bincount(tri_isl, weights=a2, minlength=n)
    size = int(L.param("size", 1024))
    cnt = UC.raster_counts(U, size)
    # winding: the UV triangle's orientation against the surface's
    cr = (U[:, 1, 0] - U[:, 0, 0]) * (U[:, 2, 1] - U[:, 0, 1]) - (U[:, 1, 1] - U[:, 0, 1]) * (U[:, 2, 0] - U[:, 0, 0])
    flipped = int((cr < 0).sum())
    dens = np.sqrt(a2[ok] / a3[ok])
    med = float(np.median(dens))
    dn = dens / max(med, 1e-12)
    outside = float(a2[((U < -0.001) | (U > 1.001)).any(axis=(1, 2))].sum() / max(a2.sum(), 1e-12) * 100)
    out = {"layer": lay, "layers": [u.name for u in me.uv_layers], "islands": {"count": int(n), "largest_share_pct": round(float(uvarea.max() / uvarea.sum() * 100), 1), "smallest_share_pct": round(float(uvarea.min() / uvarea.sum() * 100), 3)},
           "coverage_pct": round(float((cnt >= 1).mean() * 100), 1), "overlap_pct": round(float((cnt >= 2).mean() * 100), 2), "outside_pct": round(outside, 2), "flipped_uv_triangles": flipped,
           "stretch": {"median": round(wquant(st[ok], w, 0.5), 3), "p95": round(wquant(st[ok], w, 0.95), 3), "max": round(float(st[ok].max()), 2)},
           "density": {"p5": round(wquant(dn, w, 0.05), 3), "p50": round(wquant(dn, w, 0.5), 3), "p95": round(wquant(dn, w, 0.95), 3)}, "seams": int(sum(1 for e in me.edges if e.use_seam))}
    if o.vertex_groups:
        names = [g.name for g in o.vertex_groups]
        hg = [i for i, nme in enumerate(names) if nme.endswith("Head")]
        if hg:
            W = np.zeros(len(me.vertices))
            for v in me.vertices:
                for g in v.groups:
                    if g.group == hg[0]:
                        W[v.index] = g.weight
            tw = W[tv].mean(1)[ok]
            if (tw > 0.5).any() and (tw <= 0.5).any():
                out["density"]["head_to_body"] = round(float(np.average(dn[tw > 0.5], weights=w[tw > 0.5]) / np.average(dn[tw <= 0.5], weights=w[tw <= 0.5])), 2)
    files = []
    if L.param("layout", True):
        p = os.path.join(L.ARGS["out_dir"], "uvcheck-layout.png")
        UC.draw_layout(U, tri_isl, 2048, p)
        files.append(p)
    views = L.param("checker") or []
    if views:
        scn = bpy.context.scene
        res = int(L.param("res", 768))
        M.workbench(scn, res)
        scn.render.image_settings.file_format = "PNG"
        for ob in scn.objects:
            if ob is not o:
                ob.hide_render = True
        o.hide_render = False
        img = bpy.data.images.new("uvcheck-grid", 1024, 1024)
        img.generated_type = "COLOR_GRID"
        mat = bpy.data.materials.new("uvcheck")
        mat.use_nodes = True
        nt = mat.node_tree
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
        # show the chosen layer
        me.uv_layers.active = me.uv_layers[lay]
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = lay
        tm = nt.nodes.new("ShaderNodeMapping")
        t = float(L.param("tiles", 16)) / 8.0
        tm.inputs["Scale"].default_value = (t, t, t)
        nt.links.new(uvn.outputs["UV"], tm.inputs["Vector"])
        nt.links.new(tm.outputs["Vector"], tex.inputs["Vector"])
        o.data.materials.clear()
        o.data.materials.append(mat)
        scn.display.shading.color_type = "TEXTURE"
        cam = bpy.data.objects.new("uvcam", bpy.data.cameras.new("uvcam"))
        scn.collection.objects.link(cam)
        scn.camera = cam
        cam.data.type = "ORTHO"
        cam.data.clip_start, cam.data.clip_end = 0.01, 60
        V = np.array([(o.matrix_world @ v.co)[:] for v in me.vertices])
        H = float(V[:, 2].max() - V[:, 2].min())
        mid = (V.max(0) + V.min(0)) / 2
        for v in views:
            if isinstance(v, str):
                name, view, c, sz = v, v, mid, H * 1.15
            else:
                name, view, c, sz = v.get("name", v.get("view", "view")), v.get("view", "front"), np.array(v.get("c", mid), float), float(v.get("size", H * 1.15))
            if view not in DIRS:
                raise RuntimeError(f"view must be one of {', '.join(DIRS)}")
            d = Vector(DIRS[view]).normalized()
            cam.location = Vector(c) + d * 6
            cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
            cam.data.ortho_scale = sz
            p = os.path.join(L.ARGS["out_dir"], f"uvcheck-{name}.png")
            scn.render.filepath = p
            bpy.ops.render.render(write_still=True)
            files.append(p)
    out["files"] = [os.path.basename(f) for f in files]
    L.finish(out, files=files, save=False)


L.run(main)
