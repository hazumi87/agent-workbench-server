"""relief_shell — a lightweight, CLOSED image-based interior SHELL from one or SEVERAL `view_capture` views: the architecture (floor, ceiling, walls, trims, doors) copied from the source and textured by projecting the captured colour. With several views ONE shared shell is built and each triangle takes its colour from the view that sees it best, so the whole room is covered. The furniture is NOT built here: use `capture_project` (verb 117) with the same views for a coarse proxy of the real furniture meshes. Saves a checkpoint (not with dry_run).

Needs, for every view, two captures from the SAME camera and view name: the whole interior (`capture`) and the SHELL objects alone (`shell_capture`, a view_capture of just the architecture): the shell's own depth tells which captured pixels are furniture (captured depth nearer than the shell's by more than `depth_tol_m`) so they can be painted over, and which shell triangles a view really sees.
params:
  capture        path of the .capture.json of the whole interior   [required]
  shell_capture  path of the .capture.json of the shell objects only, same cameras and view names   [required]
  view           one camera name, OR
  views          a list of camera names (the shared-shell form)   [one of the two is required]
  shell_objects  names of the architectural meshes in this scene to copy as the shell (exact names)   [required]
  name           base name (default "Interior_<view>" or "Interior"): object <name>_shell; running again replaces it
  max_edge_m     BIG shell surfaces (any mesh larger than 0.6 m: floor, ceiling, walls) are cut by planes every this many metres along x, y and z (default 0.25) so a projected picture stays accurate; small pieces (trims, handles) are not cut; raise it, e.g. 0.5, to make the shell lighter
  depth_tol_m    a captured pixel is furniture when it is nearer than the shell by more than this (default 0.03)
  shell_tol_m    a shell triangle is SEEN by a view when its centre is within this distance (along that camera's axis) of the shell's captured depth at its pixel (two-sided) (default 0.08)
  unseen_colour  [r, g, b] 0..1 for shell texels no capture hit and for triangles no view sees (default [0.04, 0.04, 0.04])
  tex_px         downscale every picture packed into the shell to this size (square, e.g. 512; default 0 = the capture's own size). UVs are normalised, nothing else changes; the GLB gets smaller
  furniture      "none" (the only value; the earlier depth-grid furniture was REMOVED on , it could not hold thin chair backs: use capture_project)
  dry_run        true: counts only
Result: ONE mesh `<name>_shell` in WORLD coordinates, no parent, with one material `<name>_shell-v<k>` per view that colours at least one triangle (its colour picture with the furniture pixels inpainted from neighbouring shell pixels of the same surface direction) and one `<name>_shell-flat`. Report: shell vertices and triangles, per view the triangles it colours, triangles no view sees, per view the furniture pixels and inpainted texels, `<name>_inferred-<view>.png` in out (white = inpainted under furniture, grey = no capture saw it, black = captured shell), bounds, packed pictures.
Limits: where a view's furniture hides the wall the picture is inpainted (smeared, a guess); a triangle seen by no view takes the colour of the nearest seen triangle in the same plane (a guess; dark `unseen_colour` where there is none); a triangle takes ONE view, so a seam can show where neighbours take different views; the colour is the captured diffuse colour (no lights); the shell has flat faces and no normal texture; openings in the source walls leave holes in the shell (model the doors).
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import _projview as PV  # noqa: E402


def sh(a, di, dj, fv):
    h, w = a.shape[:2]
    ap = np.pad(a, [(1, 1), (1, 1)] + [(0, 0)] * (a.ndim - 2), constant_values=fv)
    return ap[1 + di:1 + di + h, 1 + dj:1 + dj + w]


def main():
    cap, scap = L.param("capture"), L.param("shell_capture")
    vnames = L.param("views") or ([L.param("view")] if L.param("view") else [])
    objs = L.param("shell_objects") or []
    if not (cap and scap and vnames and objs):
        raise RuntimeError("give capture, shell_capture, view (or views) and shell_objects")
    if L.param("furniture", "none") != "none":
        raise RuntimeError('furniture "grid" was : leave furniture out here and use capture_project for the furniture')
    out_dir = L.ARGS["out_dir"]
    cap = cap if os.path.isabs(cap) else os.path.join(out_dir, cap)
    scap = scap if os.path.isabs(scap) else os.path.join(out_dir, scap)
    nm = L.param("name") or ("Interior_" + vnames[0] if len(vnames) == 1 else "Interior")
    max_edge = float(L.param("max_edge_m", 0.25))
    tol = float(L.param("depth_tol_m", 0.03))
    stol = float(L.param("shell_tol_m", 0.08))
    ucol = [float(x) for x in (L.param("unseen_colour") or [0.04, 0.04, 0.04])]
    tex_px = int(L.param("tex_px", 0))
    dry = bool(L.param("dry_run", False))
    IV = [PV.load_view(cap, n, with_colour=True) for n in vnames]
    SV = [PV.load_view(scap, n, with_normal=True) for n in vnames]
    for a, b in zip(IV, SV):
        if (a["W"], a["H"]) != (b["W"], b["H"]) or not np.allclose(a["M"], b["M"], atol=1e-4) or abs(a["cam"]["fov_horizontal_deg"] - b["cam"]["fov_horizontal_deg"]) > 1e-3:
            raise RuntimeError(f"view {a['name']}: the two captures are not from the same camera (matrix, fov or res differ): run the shell view_capture with the same from / to / fov_deg / res")
    scn = bpy.context.scene
    src_objs = []
    for n in objs:
        o = bpy.data.objects.get(n)
        if o is None or o.type != "MESH":
            raise RuntimeError(f"shell object {n!r}: no such mesh in this scene")
        src_objs.append(o)
    bm = bmesh.new()
    for o in src_objs:
        t = bmesh.new()
        t.from_mesh(o.data)
        t.transform(o.matrix_world)
        bmesh.ops.triangulate(t, faces=t.faces[:])
        if len(t.verts):
            cv = np.array([v.co[:] for v in t.verts])
            if float((cv.max(axis=0) - cv.min(axis=0)).max()) > 0.6:  # only BIG surfaces (floor, ceiling, walls) are cut
                for ax in range(3):
                    lo, hi = float(cv[:, ax].min()), float(cv[:, ax].max())
                    c = math.floor(lo / max_edge) * max_edge + max_edge
                    while c < hi - 1e-6:
                        no = [0.0, 0.0, 0.0]
                        no[ax] = 1.0
                        co_ = [0.0, 0.0, 0.0]
                        co_[ax] = c
                        bmesh.ops.bisect_plane(t, geom=t.verts[:] + t.edges[:] + t.faces[:], plane_co=co_, plane_no=no, dist=1e-6)
                        c += max_edge
        me_t = bpy.data.meshes.new("tmp")
        t.to_mesh(me_t)
        t.free()
        bm.from_mesh(me_t)
        bpy.data.meshes.remove(me_t)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    old = bpy.data.objects.get(nm + "_shell")
    if old is not None and not dry:
        if "relief_source" not in old:
            raise RuntimeError(f"{nm}_shell: exists and was not made by this family of verbs: never replaced")
        bpy.data.objects.remove(old, do_unlink=True)
    me = bpy.data.meshes.new(nm + "_shell")
    bm.to_mesh(me)
    bm.free()
    for pg in me.polygons:
        pg.material_index = 0
    while len(me.uv_layers):  # the source meshes' own UV layers came along: the projected one must be the ONLY (and active) layer
        me.uv_layers.remove(me.uv_layers[0])
    co = np.array([v.co[:] for v in me.vertices], dtype=np.float64).reshape(-1, 3)
    tri = np.array([list(p.vertices) for p in me.polygons], dtype=np.int64).reshape(-1, 3)
    cen = co[tri].mean(axis=1)
    e1, e2 = co[tri[:, 1]] - co[tri[:, 0]], co[tri[:, 2]] - co[tri[:, 0]]
    nrm = np.cross(e1, e2)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    # ---- per view: furniture pixels, and which triangles the view sees (on the SHELL's own captured depth)
    furn, score = [], np.full((len(IV), len(tri)), -1.0)
    PIX_U = np.zeros((len(IV), len(tri)), int)
    PIX_V = np.zeros((len(IV), len(tri)), int)
    for k, (iv_, sv_) in enumerate(zip(IV, SV)):
        fm = iv_["hit"] & (~sv_["hit"] | (iv_["Z"] < sv_["Z"] - tol))
        furn.append(fm)
        ok, iu, ivr, cs = PV.seen(sv_, cen, nrm, stol)
        ok &= PV.inside_all(sv_, co[tri])
        pen = np.where(fm[ivr, iu], 0.2, 1.0)  # a texel that is furniture in this picture is only inpainted: prefer a view where it is real shell
        score[k] = np.where(ok, cs * pen, -1.0)
        PIX_U[k], PIX_V[k] = iu, ivr
    has = score.max(axis=0) > 0
    bk = np.where(has, score.argmax(axis=0), -1)
    rep = {"views": vnames, "shell_objects": len(src_objs), "shell_vertices": int(len(co)), "shell_triangles": int(len(tri)), "triangles_seen": int(has.sum()), "triangles_seen_by_no_view": int((~has).sum()),
           "triangles_per_view": {vnames[k]: int((bk == k).sum()) for k in range(len(vnames))}, "furniture_pixels_per_view": {vnames[k]: int(furn[k].sum()) for k in range(len(vnames))}, "dry_run": dry}
    if dry:
        bpy.data.meshes.remove(me)
        L.finish(rep, save=False)
        return
    # ---- UVs
    uvl = me.uv_layers.new(name="UVMap")
    used_views = [k for k in range(len(IV)) if (bk == k).any()]
    slot_of = {k: j for j, k in enumerate(used_views)}
    unseen_slot = len(used_views)
    uvc = np.zeros((len(tri), 3, 2))
    for k in used_views:
        sel = np.nonzero(bk == k)[0]
        uvc[sel] = PV.uv_of(IV[k], co[tri[sel]].reshape(-1, 3)).reshape(len(sel), 3, 2)
    for pi, p in enumerate(me.polygons):
        k = int(bk[pi])
        p.material_index = slot_of[k] if k >= 0 else unseen_slot
        for c, li in enumerate(p.loop_indices):
            uvl.data[li].uv = (float(uvc[pi, c, 0]), float(uvc[pi, c, 1]))
    obj_s = bpy.data.objects.new(nm + "_shell", me)
    obj_s["relief_source"] = json.dumps({"capture": os.path.basename(cap), "views": vnames, "shell": True})
    scn.collection.objects.link(obj_s)
    # ---- one colour picture per used view: captured colour, furniture inpainted from shell pixels, unseen dark
    mats, pics, inferred, stats, out_by_view = [], [], [], {}, {}
    for k in used_views:
        iv_, sv_, fm = IV[k], SV[k], furn[k]
        W, H = iv_["W"], iv_["H"]
        shell_px = iv_["hit"] & ~fm
        unseen = ~iv_["hit"] & ~sv_["hit"]
        out = iv_["colour"][..., :3].astype(np.float32).copy()
        region = fm.copy()
        for _ in range(2):
            for di, dj in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                region |= sh(fm, di, dj, False)
        known = shell_px & ~region
        inp = region & ~unseen
        NS = (sv_["normal"][..., :3].astype(np.float32) - 0.5) * 2.0  # the shell's own normal at every pixel: paint a floor texel only from floor texels, a wall texel from wall texels
        DIRS4 = ((-1, 0), (1, 0), (0, -1), (0, 1))
        SIM = {d_: ((NS * sh(NS, d_[0], d_[1], 0.0)).sum(axis=2) > 0.9) for d_ in DIRS4}
        iters = 0
        for iters in range(1, 300):
            acc = np.zeros_like(out)
            cnt = np.zeros((H, W), np.float32)
            for di, dj in DIRS4:
                kn = sh(known, di, dj, False) & SIM[(di, dj)]
                acc += np.where(kn[..., None], sh(out, di, dj, 0.0), 0.0)
                cnt += kn
            newly = region & ~known & (cnt > 0)
            if not newly.any():
                break
            out = np.where(newly[..., None], acc / np.maximum(cnt, 1)[..., None], out)
            known |= newly
        leftover = region & ~known & ~unseen
        out = np.where(leftover[..., None], 0.18, out)
        out = np.where(unseen[..., None], np.array(ucol, np.float32)[None, None, :], out)
        out_by_view[k] = out
        img = bpy.data.images.new(f"{nm}_shell-colour-{iv_['name']}", W, H, alpha=True)
        img.colorspace_settings.name = "Non-Color"
        img.pixels.foreach_set(np.concatenate([out, np.ones((H, W, 1), np.float32)], axis=-1)[::-1].ravel())
        if tex_px and tex_px < max(W, H):
            img.scale(tex_px, tex_px)
        img.file_format = "PNG"
        img.pack()
        img.colorspace_settings.name = "sRGB"
        m = bpy.data.materials.new(f"{nm}_shell-v{k + 1}-{iv_['name']}")
        m.use_nodes = True
        b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        tn = m.node_tree.nodes.new("ShaderNodeTexImage")
        tn.image = img
        tn.extension = "EXTEND"
        m.node_tree.links.new(tn.outputs["Color"], b.inputs["Base Color"])
        b.inputs["Roughness"].default_value = 0.9
        me.materials.append(m)
        mats.append(m.name)
        pics.append(img.name)
        inf = np.where(unseen, 0.5, np.where(inp | leftover, 1.0, 0.0)).astype(np.float32)
        mimg = bpy.data.images.new(f"{nm}_inferred-{iv_['name']}", W, H, alpha=False)
        mimg.colorspace_settings.name = "Non-Color"
        mimg.pixels.foreach_set(np.concatenate([np.repeat(inf[::-1, :, None], 3, axis=2), np.ones((H, W, 1), np.float32)], axis=-1).ravel())
        mimg.file_format = "PNG"
        os.makedirs(out_dir, exist_ok=True)
        mimg.filepath_raw = os.path.join(out_dir, f"{nm}_inferred-{iv_['name']}.png")
        mimg.save()
        bpy.data.images.remove(mimg)
        inferred.append(f"{nm}_inferred-{iv_['name']}.png")
        stats[iv_["name"]] = {"texels_inpainted_under_furniture": int(inp.sum()), "texels_with_no_far_colour_mid_grey": int(leftover.sum()), "texels_no_capture_saw_dark": int(unseen.sum()), "inpaint_iterations": iters}
    # triangles no view sees take the colour of the nearest SEEN triangle with a similar normal (a guess, marked by the -flat material); dark only where there is none
    unseen_idx = np.nonzero(~has)[0]
    seen_idx = np.nonzero(has)[0]
    col_seen = np.zeros((len(seen_idx), 3))
    for j, i in enumerate(seen_idx):
        k = int(bk[i])
        col_seen[j] = out_by_view[k][PIX_V[k][i], PIX_U[k][i]]
    guess_col = np.tile(np.array(ucol, dtype=np.float64), (len(unseen_idx), 1))
    n_guess = 0
    if len(seen_idx) and len(unseen_idx):
        for a0 in range(0, len(unseen_idx), 150):
            blk = unseen_idx[a0:a0 + 150]
            diff = cen[blk][:, None, :] - cen[seen_idx][None, :, :]
            d2 = (diff ** 2).sum(axis=2)
            dots = np.abs(nrm[blk] @ nrm[seen_idx].T)
            plane = np.abs((diff * nrm[blk][:, None, :]).sum(axis=2))
            d2 = np.where((dots > 0.8) & (plane < 0.15), d2, 1e9)  # same direction AND the same plane (within 15 cm): a floor triangle is never coloured from a ceiling or a wall
            j = d2.argmin(axis=1)
            okj = d2[np.arange(len(blk)), j] < 1e8
            guess_col[a0:a0 + len(blk)][okj] = col_seen[j[okj]]
            n_guess += int(okj.sum())
    side = max(1, int(math.ceil(math.sqrt(max(len(unseen_idx), 1)))))
    pal = np.zeros((side, side, 4), np.float32)
    pal[..., 3] = 1.0
    uvu = np.zeros((len(tri), 2))
    for j, i in enumerate(unseen_idx):
        pal[j // side, j % side, :3] = guess_col[j]
        uvu[i] = (((j % side) + 0.5) / side, ((j // side) + 0.5) / side)
    for pi in unseen_idx:
        for li in me.polygons[int(pi)].loop_indices:
            uvl.data[li].uv = (float(uvu[pi, 0]), float(uvu[pi, 1]))
    pimg = bpy.data.images.new(nm + "_shell-palette", side, side, alpha=True)
    pimg.colorspace_settings.name = "Non-Color"
    pimg.pixels.foreach_set(pal[::-1].ravel())
    pimg.file_format = "PNG"
    pimg.pack()
    pimg.colorspace_settings.name = "sRGB"
    mu = bpy.data.materials.new(f"{nm}_shell-flat")
    mu.use_nodes = True
    bu = next(n for n in mu.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    tu = mu.node_tree.nodes.new("ShaderNodeTexImage")
    tu.image = pimg
    tu.interpolation = "Closest"
    mu.node_tree.links.new(tu.outputs["Color"], bu.inputs["Base Color"])
    bu.inputs["Roughness"].default_value = 0.9
    me.materials.append(mu)
    rep["triangles_with_guessed_colour"] = n_guess
    pics.append(pimg.name)
    rep.update({"objects": [nm + "_shell"], "materials": mats + [mu.name], "pictures_packed": pics, "per_view": stats, "inferred_mask_files": inferred,
                "shell_bounds_m": [[round(float(x), 3) for x in co.min(axis=0)], [round(float(x), 3) for x in co.max(axis=0)]],
                "notes": ["the shell is in WORLD coordinates (the capture cameras' frame), no parent", "inferred pictures: white = inpainted under furniture, grey = no capture saw it, black = captured shell", "the furniture comes from capture_project with the same views"]})
    L.finish(rep, save=True)


L.run(main)
