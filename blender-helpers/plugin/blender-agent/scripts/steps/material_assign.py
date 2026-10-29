"""material_assign — give the body a NEW material built from image files: base colour, roughness, metallic (or one packed ORM image) and a normal map, each with the right colour space and the right UV layer. Saves a checkpoint.

For reviewing or exporting a corrected texture (a tex_stack export, a rebake with its misses filled) WITHOUT touching the master: the images are loaded from their files as new image datablocks (the files are never written),
and the earlier material stays in the file, unused (`kept_materials` names it). Assigning again with other files makes another material; the body points at the newest.

params:
  body              the mesh (default "body")
  name              the new material's name (default "<body>-review"); an existing name gets a numeric suffix
  uv                the UV layer the textures use (default the active layer); the normal map is told the same layer
  base_color        image file (sRGB)
  roughness         image file (Non-Color; the red channel is read)
  metallic          image file (Non-Color; the red channel is read)
  orm               ONE packed image: occlusion in R (not wired), roughness in G, metallic in B (Non-Color). Not combined with roughness or metallic
  normal            image file (Non-Color), a tangent-space normal map
  normal_convention "opengl" (default, Blender and glTF: green up) or "directx" (green flipped)
  pack              true: store the images inside the .blend (default false: they stay linked to their files, so keep the files where they are)
  slots             "all" (default): the new material replaces every material slot; or a slot number
Every image is given as a path (under the tool root or absolute; "{job_dir}" and "out:<name>" for a file in this job's out/ work), a Library id, or {"library_id": id}.
Returns: material, uv, images (role, file, size, colour space, node), links (which socket each image feeds), kept_materials, slots, notes. Refuses a missing file or a layer that does not exist; a texture size that differs between images is a note, not a refusal.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402

ROLES = {"base_color": "sRGB", "roughness": "Non-Color", "metallic": "Non-Color", "normal": "Non-Color", "orm": "Non-Color"}


def find(ref, what):
    if isinstance(ref, str) and ref.startswith("out:"):
        p = os.path.join(L.ARGS["out_dir"], ref[4:])
    else:
        p = L.resolve(ref, what=what)
    if not os.path.isfile(p):
        raise RuntimeError(f"{what}: no such file {p}")
    return p


def main():
    body = bpy.data.objects[L.param("body", "body")]
    if body.type != "MESH":
        raise RuntimeError("body must be a mesh")
    me = body.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None or uvn not in me.uv_layers:
        raise RuntimeError(f"no such UV layer; the layers are {', '.join(u.name for u in me.uv_layers)}")
    given = {r: L.param(r) for r in ROLES if L.param(r)}
    if not given:
        raise RuntimeError("give at least one of base_color, roughness, metallic, orm, normal")
    if "orm" in given and ("roughness" in given or "metallic" in given):
        raise RuntimeError("orm replaces roughness and metallic: give one or the other")
    conv = L.param("normal_convention", "opengl")
    if conv not in ("opengl", "directx"):
        raise RuntimeError('normal_convention must be "opengl" or "directx"')
    paths = {r: find(v, r) for r, v in given.items()}
    name = L.param("name", f"{body.name}-review")
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(n)
    out_n = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    pr = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(pr.outputs["BSDF"], out_n.inputs["Surface"])
    uvmap = nt.nodes.new("ShaderNodeUVMap")
    uvmap.uv_map = uvn
    info, links, notes, sizes = [], {}, [], set()
    tex = {}
    for r, p in paths.items():
        im = bpy.data.images.load(p, check_existing=False)
        im.name = f"{mat.name}-{r}"
        im.colorspace_settings.name = ROLES[r]
        if L.param("pack"):
            im.pack()
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = im
        t.interpolation = "Linear"
        nt.links.new(uvmap.outputs["UV"], t.inputs["Vector"])
        tex[r] = t
        sizes.add(tuple(im.size))
        info.append({"role": r, "file": p, "size": list(im.size), "colour_space": ROLES[r], "node": t.name, "packed": bool(im.packed_file)})
    if "base_color" in tex:
        nt.links.new(tex["base_color"].outputs["Color"], pr.inputs["Base Color"])
        links["base_color"] = "Base Color"
    if "roughness" in tex:
        nt.links.new(tex["roughness"].outputs["Color"], pr.inputs["Roughness"])
        links["roughness"] = "Roughness (R)"
    if "metallic" in tex:
        nt.links.new(tex["metallic"].outputs["Color"], pr.inputs["Metallic"])
        links["metallic"] = "Metallic (R)"
    if "orm" in tex:
        sp = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tex["orm"].outputs["Color"], sp.inputs["Color"])
        nt.links.new(sp.outputs["Green"], pr.inputs["Roughness"])
        nt.links.new(sp.outputs["Blue"], pr.inputs["Metallic"])
        links["orm"] = "Roughness (G), Metallic (B); R (occlusion) not wired"
    if "normal" in tex:
        src = tex["normal"].outputs["Color"]
        if conv == "directx":
            sp = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(src, sp.inputs["Color"])
            inv = nt.nodes.new("ShaderNodeMath")
            inv.operation = "SUBTRACT"
            inv.inputs[0].default_value = 1.0
            nt.links.new(sp.outputs["Green"], inv.inputs[1])
            cb = nt.nodes.new("ShaderNodeCombineColor")
            nt.links.new(sp.outputs["Red"], cb.inputs["Red"])
            nt.links.new(inv.outputs["Value"], cb.inputs["Green"])
            nt.links.new(sp.outputs["Blue"], cb.inputs["Blue"])
            src = cb.outputs["Color"]
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.space = "TANGENT"
        nm.uv_map = uvn
        nt.links.new(src, nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], pr.inputs["Normal"])
        links["normal"] = f"Normal (tangent, {conv}, UV {uvn})"
    if len(sizes) > 1:
        notes.append("the images differ in size: " + ", ".join(f"{a}x{b}" for a, b in sorted(sizes)))
    old = [m.name for m in me.materials if m]
    sl = L.param("slots", "all")
    if sl == "all" or not me.materials:
        me.materials.clear()
        me.materials.append(mat)
    else:
        me.materials[int(sl)] = mat
    # the faces point at slot 0 or the chosen slot; with "all" every face must point at the one slot
    if sl == "all" and len(me.polygons):
        import numpy as np
        z = np.zeros(len(me.polygons), dtype=np.int32)
        me.polygons.foreach_set("material_index", z)
        me.update()
    L.finish({"material": mat.name, "uv": uvn, "images": info, "links": links, "kept_materials": old, "slots": len(me.materials), "notes": notes}, save=True)


L.run(main)
