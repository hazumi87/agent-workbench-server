"""material_audit — read-only audit of how the materials of chosen objects handle ALPHA: what is wired to the Principled node's Alpha socket, from which image and which output socket of the image node, the image's alpha, and what a Cycles shadow ray will therefore do. Saves nothing.
params:
  objects   name globs of the meshes whose materials are listed (default: all meshes)
  materials name globs: only these materials
  pixels    true (default): read the image and report how many pixels are transparent (alpha < 0.5) and the alpha range
Returns per material: users (objects, the first names), blend_method, show_transparent_back / use_backface_culling, the Principled node's Alpha (default value, `linked` true/false, `from`: "<node> (<image name>).<output socket>", the chain through Math / Mix / Invert / Color Ramp nodes), whether the Base Color comes from the same image, the image (size, channels, alpha_mode, colour space), `alpha_pixels` (min, mean, share below 0.5), and `shadow` = a plain-words verdict: "alpha from image alpha: cut-out casts a cut-out shadow", "alpha linked to the image COLOUR output (not alpha): ...", "alpha not linked and 1: solid shadow", "alpha < 1 constant: partial, stochastic" etc. A material the Cycles bake sees as transparent only through nodes other than Principled Alpha (a Transparent BSDF mix) is listed under `other_transparency`.
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def trace(sock, depth=0):
    """follow a socket's link upstream through simple nodes; returns a text chain and the image node (if any) with its output socket name"""
    if not sock.is_linked or depth > 6:
        return None, None, None
    lk = sock.links[0]
    n, out = lk.from_node, lk.from_socket.name
    if n.type == "TEX_IMAGE":
        return f"{n.name} ({n.image.name if n.image else 'no image'}).{out}", n, out
    chain = f"{n.type}.{out}"
    for i in n.inputs:
        if i.is_linked:
            sub, imn, imo = trace(i, depth + 1)
            if imn is not None:
                return f"{chain} <- {sub}", imn, imo
    return chain, None, None


def main():
    pats = L.param("objects")
    mpats = L.param("materials")
    pix = bool(L.param("pixels", True))
    mats = {}
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or "blender_agent_marker" in o:
            continue
        if pats and not any(fnmatch.fnmatchcase(o.name, p) for p in pats):
            continue
        used = {p.material_index for p in o.data.polygons}
        for mi in used:
            m = o.data.materials[mi] if mi < len(o.data.materials) else None
            if m and (not mpats or any(fnmatch.fnmatchcase(m.name, p) for p in mpats)):
                mats.setdefault(m, []).append(o.name)
    rows = []
    cache = {}
    for m, objs in sorted(mats.items(), key=lambda kv: kv[0].name):
        row = {"material": m.name, "users": len(objs), "objects": sorted(objs)[:3], "blend_method": getattr(m, "blend_method", None),
               "backface_culling": getattr(m, "use_backface_culling", None)}
        bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if m.use_nodes and m.node_tree else None
        other = [n.type for n in (m.node_tree.nodes if m.use_nodes and m.node_tree else []) if n.type in ("BSDF_TRANSPARENT", "MIX_SHADER", "ADD_SHADER")]
        if other:
            row["other_transparency"] = sorted(set(other))
        if bsdf is None:
            row["shadow"] = "no Principled node: look at the node tree (other_transparency)"
            rows.append(row)
            continue
        a = bsdf.inputs["Alpha"]
        row["alpha_default"] = round(float(a.default_value), 4)
        row["alpha_linked"] = a.is_linked
        verdict = ""
        if a.is_linked:
            chain, imn, out = trace(a)
            row["alpha_from"] = chain
            bc = bsdf.inputs["Base Color"]
            if bc.is_linked:
                row["base_colour_from"] = trace(bc)[0]
            if imn is not None and imn.image is not None:
                img = imn.image
                row["image"] = {"name": img.name, "size": list(img.size), "channels": img.channels, "alpha_mode": img.alpha_mode, "colorspace": img.colorspace_settings.name}
                if pix:
                    if img.name not in cache:
                        px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
                        img.pixels.foreach_get(px)
                        al = px.reshape(-1, 4)[:, 3]
                        cache[img.name] = {"min": round(float(al.min()), 3), "mean": round(float(al.mean()), 3), "below_half_percent": round(float((al < 0.5).mean()) * 100, 2)}
                    row["alpha_pixels"] = cache[img.name]
                if out == "Alpha":
                    verdict = "alpha from image alpha: cut-out casts a cut-out shadow" + (" (but the image has no transparent pixels: solid)" if pix and row["alpha_pixels"]["below_half_percent"] == 0 else "")
                else:
                    verdict = f"alpha linked to the image output '{out}' (NOT its Alpha): the shadow follows that, check"
            else:
                verdict = "alpha linked to a node chain without an image: " + str(chain)
        else:
            verdict = "alpha not linked, value %.2f: " % a.default_value + ("solid shadow" if a.default_value > 0.999 else "constant partial (stochastic) shadow")
        row["shadow"] = verdict
        rows.append(row)
    summary = {}
    for r in rows:
        summary[r["shadow"].split(":")[0]] = summary.get(r["shadow"].split(":")[0], 0) + 1
    L.finish({"materials": len(rows), "verdicts": summary}, save=False, rows=rows[:200])


L.run(main)
