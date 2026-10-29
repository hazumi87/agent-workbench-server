"""capture_project — a COARSE PROXY of chosen scene meshes, textured by PROJECTING `view_capture` colour pictures through their cameras. The silhouettes and depth come from real (simplified) geometry, so a chair back or a table top is a continuous surface and parallax is true; the pictures give the actual appearance. With SEVERAL views, ONE shared proxy is built: a mesh is kept when ANY view sees it, and each face takes its colour from the view that sees it best (the largest cosine of the incidence angle, two-sided), so a cabinet side seen best from one view is coloured from that view and not from another. Faces no view sees take the colour of the nearest SEEN face of the same mesh. Saves a checkpoint (not with dry_run).

Typical use for an image-based interior: the SHELL from `relief_shell` (with `furniture` "none", same views) plus this proxy, both from the same captures.
params:
  capture      path of the .capture.json written by view_capture   [required]
  view         one camera name in it, OR
  views        a list of camera names in it (the shared-proxy form)   [one of the two is required]
  objects      names / globs of the roots to copy (each root's whole subtree of meshes is taken)   [required]
  exclude      names / globs left out (for example the shell meshes)
  name         object name (default "Proxy_<view>" or "Proxy"); the same name replaces the earlier proxy
  max_tris     triangle budget of the whole proxy (default 30000). The meshes are simplified by VERTEX CLUSTERING (every vertex snaps to a cell of one common size, vertices of a mesh in the same cell merge, faces that collapse are dropped): no spikes, silhouettes stay within about one cell; the cell size is searched so the total fits the budget (report: `cell_size_m`). `min_cell_m` (default 0.004) and `max_cell_m` (default 0.4) bound the search.
  tex_px       downscale every colour picture packed into the proxy to this size (square, e.g. 512; default 0 = the capture's own size). UVs are normalised; the GLB gets smaller
  drop_unseen_meshes  true (default): a source mesh none of the views can see is left out (cabinet insides, things behind). false keeps every mesh (its faces then carry the mesh's average colour)
  tol_m        a face counts as SEEN by a view when its centre is within this distance (along that camera's axis) of the captured surface at its pixel, faces the camera, and the pixel was hit (two-sided: the normal direction does not matter) (default 0.06)
  world_box    {"min": [x,y,z], "max": [x,y,z]} (nulls leave a side open): faces whose centre is outside are dropped
  dry_run      true: counts only
Result: ONE mesh `<name>` in WORLD coordinates (the capture cameras' frame), no parent. One material `<name>-v<k>` per view that colours at least one face (its colour picture, UV = the face's place in that picture) and one `<name>-flat` (a small palette picture, one texel per unseen face, closest filtering). Report: meshes kept / left out, triangles, cell size, per view the faces it colours, faces seen by no view, bounds, pictures.
Limits: a simplified chair is blockier than the real one; the projected colour is exact from each capture position and smears at large oblique angles and where the proxy's silhouette is bigger than the true one; faces no view sees carry the colour of the nearest seen face of their mesh (a guess, marked by the flat material); only what the views see is kept; faces are triangles with flat normals; the colour is the captured diffuse colour (no lights); each used view adds one colour picture to the file.
"""
import fnmatch
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


def subtree(o, acc):
    acc.add(o)
    for c in o.children:
        subtree(c, acc)


def main():
    cap = L.param("capture")
    vnames = L.param("views") or ([L.param("view")] if L.param("view") else [])
    roots = L.param("objects") or []
    if not (cap and vnames and roots):
        raise RuntimeError("give capture, view (or views) and objects")
    out_dir = L.ARGS["out_dir"]
    cap = cap if os.path.isabs(cap) else os.path.join(out_dir, cap)
    exclude = L.param("exclude") or []
    nm = L.param("name") or ("Proxy_" + vnames[0] if len(vnames) == 1 else "Proxy")
    max_tris = int(L.param("max_tris", 30000))
    min_cell = float(L.param("min_cell_m", 0.004))
    max_cell = float(L.param("max_cell_m", 0.4))
    tol = float(L.param("tol_m", 0.06))
    drop_unseen = bool(L.param("drop_unseen_meshes", True))
    tex_px = int(L.param("tex_px", 0))
    box = L.param("world_box") or {}
    dry = bool(L.param("dry_run", False))
    VW = [PV.load_view(cap, n, with_colour=True) for n in vnames]
    scn = bpy.context.scene
    pick = set()
    for r in roots:
        for o in bpy.data.objects:
            if fnmatch.fnmatch(o.name, r):
                subtree(o, pick)
    srcs = [o for o in pick if o.type == "MESH" and o.name in scn.objects and not any(fnmatch.fnmatch(o.name, e) for e in exclude)]
    srcs.sort(key=lambda o: o.name)
    if not srcs:
        raise RuntimeError(f"no mesh under {roots} (after exclude {exclude})")
    # ---- world-space triangles of every source mesh
    V_list, T_list, mid_list = [], [], []
    off = 0
    for oi, o in enumerate(srcs):
        t = bmesh.new()
        t.from_mesh(o.data)
        t.transform(o.matrix_world)
        bmesh.ops.triangulate(t, faces=t.faces[:])
        t.verts.ensure_lookup_table()
        co = np.array([v.co[:] for v in t.verts], dtype=np.float64).reshape(-1, 3)
        tr = np.array([[v.index for v in fc.verts] for fc in t.faces], dtype=np.int64).reshape(-1, 3)
        t.free()
        V_list.append(co)
        T_list.append(tr + off)
        mid_list.append(np.full(len(co), oi, dtype=np.int64))
        off += len(co)
    Vall = np.concatenate(V_list)
    Tall = np.concatenate(T_list)
    Mid = np.concatenate(mid_list)
    total = len(Tall)

    def cluster(sz):
        q = np.floor(Vall / sz).astype(np.int64) + (1 << 20)
        key = ((Mid * (1 << 21) + q[:, 0]) * (1 << 21) + q[:, 1]) * (1 << 21) + q[:, 2]
        uk, inv = np.unique(key, return_inverse=True)
        pos = np.zeros((len(uk), 3))
        cnt = np.zeros(len(uk))
        np.add.at(pos, inv, Vall)
        np.add.at(cnt, inv, 1.0)
        pos /= cnt[:, None]
        tt = inv[Tall]
        ok = (tt[:, 0] != tt[:, 1]) & (tt[:, 1] != tt[:, 2]) & (tt[:, 0] != tt[:, 2])
        tt = tt[ok]
        srt = np.sort(tt, axis=1)
        _, first = np.unique(srt, axis=0, return_index=True)
        first.sort()
        return pos, tt[first], ok.nonzero()[0][first]

    def normals_of(pos_, tri_):
        e1_, e2_ = pos_[tri_[:, 1]] - pos_[tri_[:, 0]], pos_[tri_[:, 2]] - pos_[tri_[:, 0]]
        n_ = np.cross(e1_, e2_)
        return n_ / np.maximum(np.linalg.norm(n_, axis=1, keepdims=True), 1e-12)

    def best_view(cen_, nrm_, corners_):
        """for every face: the index of the view that sees it best (largest incidence cosine), -1 when no view sees it; plus the pixel column / row in that view"""
        score = np.full((len(VW), len(cen_)), -1.0)
        IU = np.zeros((len(VW), len(cen_)), int)
        IV = np.zeros((len(VW), len(cen_)), int)
        for k, vw in enumerate(VW):
            ok, iu_, iv_, cs = PV.seen(vw, cen_, nrm_, tol)
            ok &= PV.inside_all(vw, corners_)
            score[k] = np.where(ok, cs, -1.0)
            IU[k], IV[k] = iu_, iv_
        has = score.max(axis=0) > 0
        bk = np.where(has, score.argmax(axis=0), -1)
        ar = np.arange(len(cen_))
        pick_k = np.where(has, bk, 0)
        return bk, IU[pick_k, ar], IV[pick_k, ar]

    n_meshes_left_out = 0
    if drop_unseen:  # which meshes does ANY view see at all (fine pre-pass), so the triangle budget is spent only on them
        pos_p, tri_p, srcf_p = cluster(max(min_cell, 0.015))
        bk_p, _, _ = best_view(pos_p[tri_p].mean(axis=1), normals_of(pos_p, tri_p), pos_p[tri_p])
        has_m = np.zeros(len(srcs), bool)
        for oi in set(Mid[Tall[srcf_p[bk_p >= 0], 0]].tolist()):
            has_m[oi] = True
        n_meshes_left_out = int((~has_m).sum())
        Tall = Tall[has_m[Mid[Tall[:, 0]]]]
        if not len(Tall):
            raise RuntimeError("the views see none of the chosen meshes (check the views, tol_m and exclude)")
    rep = {"views": vnames, "meshes": len(srcs), "meshes_left_out_unseen": n_meshes_left_out, "triangles_before": int(total), "triangles_before_pass2": int(len(Tall)), "max_tris": max_tris, "dry_run": dry}
    lo, hi = min_cell, max_cell
    best = None
    pos0, tri0, srcf0 = cluster(lo)
    if len(tri0) <= max_tris:
        best = (lo, pos0, tri0, srcf0)
    else:
        for _ in range(14):
            mid_ = math.sqrt(lo * hi)
            pos_, tri_, sf_ = cluster(mid_)
            if len(tri_) <= max_tris:
                best, hi = (mid_, pos_, tri_, sf_), mid_
            else:
                lo = mid_
        if best is None:
            best = (hi,) + cluster(hi)
    cell, pos, tris_f, srcf = best
    nf = len(tris_f)
    face_obj = np.array([int(Mid[Tall[k, 0]]) for k in srcf])
    cen = pos[tris_f].mean(axis=1)
    nrm = normals_of(pos, tris_f)
    keepf = np.ones(nf, bool)
    for key in ("min", "max"):
        for ax, v_ in enumerate(box.get(key) or [None, None, None]):
            if v_ is not None:
                keepf &= (cen[:, ax] >= v_) if key == "min" else (cen[:, ax] <= v_)
    bk, iu, iv = best_view(cen, nrm, pos[tris_f])
    seenf = (bk >= 0) & keepf
    rep.update({"triangles_after": nf, "cell_size_m": round(float(cell), 5), "faces_seen": int(seenf.sum()), "faces_seen_by_no_view": int((~seenf & keepf).sum()), "faces_dropped_by_box": int((~keepf).sum()), "tol_m": tol,
                "faces_per_view": {VW[k]["name"]: int((seenf & (bk == k)).sum()) for k in range(len(VW))}})
    if dry:
        L.finish(rep, save=False)
        return
    # ---- colour of every seen face (at its centre pixel in its best view); unseen faces take the colour of the nearest seen face of their mesh
    face_col = np.zeros((nf, 3))
    for k, vw in enumerate(VW):
        sel = seenf & (bk == k)
        if sel.any():
            face_col[sel] = vw["colour"][iv[sel], iu[sel], :3]
    allseen = face_col[seenf]
    gmean = allseen.mean(axis=0) if len(allseen) else np.array([0.3, 0.3, 0.3])
    unseen_idx = np.nonzero(keepf & ~seenf)[0]
    guess = 0
    for oi in np.unique(face_obj[unseen_idx]):
        ui = unseen_idx[face_obj[unseen_idx] == oi]
        si = np.nonzero(seenf & (face_obj == oi))[0]
        if len(si) == 0:
            face_col[ui] = gmean
            continue
        for a0 in range(0, len(ui), 512):
            blk = ui[a0:a0 + 512]
            d2 = ((cen[blk][:, None, :] - cen[si][None, :, :]) ** 2).sum(axis=2)
            face_col[blk] = face_col[si[d2.argmin(axis=1)]]
        guess += len(ui)
    nu = len(unseen_idx)
    side = max(1, int(math.ceil(math.sqrt(max(nu, 1)))))
    pal = np.zeros((side, side, 4), np.float32)
    pal[..., 3] = 1.0
    pal_slot = {}
    for j, i in enumerate(unseen_idx):
        pal[j // side, j % side, :3] = face_col[i]
        pal_slot[int(i)] = j
    # ---- mesh
    old = bpy.data.objects.get(nm)
    if old is not None:
        if "relief_source" not in old:
            raise RuntimeError(f"{nm}: exists and was not made by this family of verbs: never replaced")
        bpy.data.objects.remove(old, do_unlink=True)
    keep_idx = np.nonzero(keepf)[0]
    faces_v = [tuple(int(x) for x in tris_f[i]) for i in keep_idx]
    used = sorted({v for fv in faces_v for v in fv})
    remap = {v: k for k, v in enumerate(used)}
    me = bpy.data.meshes.new(nm)
    me.from_pydata([tuple(float(x) for x in pos[v]) for v in used], [], [tuple(remap[v] for v in fv) for fv in faces_v])
    me.uv_layers.new(name="UVMap")
    uvd = me.uv_layers[0].data
    used_views = [k for k in range(len(VW)) if (seenf & (bk == k)).any()]
    slot_of = {k: j for j, k in enumerate(used_views)}
    flat_slot = len(used_views)
    uv_by_view = {}
    for k in used_views:
        sel = np.nonzero(seenf & (bk == k))[0]
        corners = pos[tris_f[sel]].reshape(-1, 3)
        uvs = PV.uv_of(VW[k], corners).reshape(len(sel), 3, 2)
        uv_by_view[k] = {int(i): uvs[j] for j, i in enumerate(sel)}
    for pi, i in enumerate(keep_idx):
        poly = me.polygons[pi]
        if seenf[i]:
            k = int(bk[i])
            poly.material_index = slot_of[k]
            cu = uv_by_view[k][int(i)]
            for c, li in enumerate(poly.loop_indices):
                uvd[li].uv = (float(cu[c][0]), float(cu[c][1]))
        else:
            poly.material_index = flat_slot
            j = pal_slot[int(i)]
            tu, tv = ((j % side) + 0.5) / side, ((j // side) + 0.5) / side
            for li in poly.loop_indices:
                uvd[li].uv = (tu, tv)
    me.update()
    ob = bpy.data.objects.new(nm, me)
    ob["relief_source"] = json.dumps({"capture": os.path.basename(cap), "views": vnames, "proxy": True})
    scn.collection.objects.link(ob)
    mats, pics = [], []
    for k in used_views:
        vw = VW[k]
        img = bpy.data.images.load(os.path.join(vw["base"], vw["files"]["colour"]), check_existing=False)
        img.colorspace_settings.name = "sRGB"
        img.name = f"{nm}-colour-{vw['name']}"
        if tex_px and tex_px < max(vw["W"], vw["H"]):
            img.scale(tex_px, tex_px)
        img.pack()
        m = bpy.data.materials.new(f"{nm}-v{k + 1}-{vw['name']}")
        m.use_nodes = True
        b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        t = m.node_tree.nodes.new("ShaderNodeTexImage")
        t.image = img
        t.extension = "EXTEND"
        m.node_tree.links.new(t.outputs["Color"], b.inputs["Base Color"])
        b.inputs["Roughness"].default_value = 0.9
        me.materials.append(m)
        mats.append(m.name)
        pics.append(img.name)
    pimg = bpy.data.images.new(nm + "-palette", side, side, alpha=True)
    pimg.colorspace_settings.name = "Non-Color"
    pimg.pixels.foreach_set(pal[::-1].ravel())
    pimg.file_format = "PNG"
    pimg.pack()
    pimg.colorspace_settings.name = "sRGB"
    m1 = bpy.data.materials.new(nm + "-flat")
    m1.use_nodes = True
    b1 = next(n for n in m1.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    t1 = m1.node_tree.nodes.new("ShaderNodeTexImage")
    t1.image = pimg
    t1.interpolation = "Closest"
    m1.node_tree.links.new(t1.outputs["Color"], b1.inputs["Base Color"])
    b1.inputs["Roughness"].default_value = 0.9
    me.materials.append(m1)
    P = np.array([pos[v] for v in used])
    rep.update({"object": nm, "materials": mats + [m1.name], "pictures_packed": pics + [pimg.name], "palette": [side, side], "faces_with_guessed_colour": int(guess),
                "bounds_m": [[round(float(x), 3) for x in P.min(axis=0)], [round(float(x), 3) for x in P.max(axis=0)]],
                "notes": ["the proxy is in WORLD coordinates (the capture cameras' frame), no parent", "seen faces carry the projected colour of the view that sees them best; unseen faces carry the colour of the nearest seen face of their mesh (the -flat material)", "colour is the captured diffuse colour (no lights)"]})
    L.finish(rep, save=True)


L.run(main)
