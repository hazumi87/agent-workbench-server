"""texture_cap — cap the size of the textures the scene's materials use, keeping the aspect ratio and the alpha channel. Saves a checkpoint (not with dry_run). The node tree, lights, names, parents, UVs and materials are not touched: only the pixel size of images, so export_scene still writes the whole hierarchy.

Run it on a COPY of the assembly (job_copy, verb 87): the images in the checkpoint are replaced by smaller ones; the earlier checkpoint keeps the full-size ones. Each image used by a material is scaled once (images shared by many materials are scaled once). UVs are normalised, so a smaller image maps the same.
params:
  max_px   longest side in px (default 2048)
  images   name globs: only these images (default: every image a material uses)
  keep     name globs never scaled
  dry_run  true: the list of what would be scaled, nothing changes
Returns: `images` (name, size before, size after, has_alpha, colour space, packed or file), counts, pixels before / after (4 bytes per pixel in memory), and the list of images left as they are. Check the file size after export_scene / export_check: PNG size depends on content (a large flat-colour or alpha image can still be big).
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def used_images():
    seen = {}
    for m in bpy.data.materials:
        if not (m.use_nodes and m.node_tree):
            continue
        stack = [m.node_tree]
        while stack:
            nt = stack.pop()
            for n in nt.nodes:
                if n.type == "TEX_IMAGE" and n.image:
                    seen[n.image.name] = n.image
                elif n.type == "GROUP" and n.node_tree:
                    stack.append(n.node_tree)
    return list(seen.values())


def main():
    cap = int(L.param("max_px", 2048))
    pats = L.param("images")
    keep = L.param("keep") or []
    dry = bool(L.param("dry_run", False))
    rows, left = [], []
    px0 = px1 = 0
    for img in sorted(used_images(), key=lambda i: -i.size[0] * i.size[1]):
        w, h = img.size
        if w == 0 or h == 0:
            left.append({"name": img.name, "why": "no pixel data (missing file?)"})
            continue
        if (pats and not any(fnmatch.fnmatchcase(img.name, p) for p in pats)) or any(fnmatch.fnmatchcase(img.name, p) for p in keep):
            left.append({"name": img.name, "why": "not selected", "size": [w, h]})
            continue
        px0 += w * h
        if max(w, h) <= cap:
            px1 += w * h
            left.append({"name": img.name, "why": "within the cap", "size": [w, h]})
            continue
        k = cap / max(w, h)
        nw, nh = max(1, round(w * k)), max(1, round(h * k))
        px1 += nw * nh
        row = {"name": img.name, "before": [w, h], "after": [nw, nh], "alpha": bool(img.alpha_mode != "NONE" and img.channels == 4),
               "colorspace": img.colorspace_settings.name, "packed": bool(img.packed_file)}
        if not dry:
            if not img.packed_file and img.source == "FILE":
                img.pack()
            img.scale(nw, nh)
            img.pack()
        rows.append(row)
    L.finish({"dry_run": dry, "max_px": cap, "images_scaled": len(rows), "images_left": len(left),
              "megapixels_before": round(px0 / 1e6, 2), "megapixels_after": round(px1 / 1e6, 2)}, save=not dry, images=rows[:100], left=left[:100])


L.run(main)
