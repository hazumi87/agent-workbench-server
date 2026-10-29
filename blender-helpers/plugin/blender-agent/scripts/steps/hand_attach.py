"""hand_attach — replace a body's fused hand with a clean hand mesh: the old hand is cut away at the wrist, the new hand (any hand mesh by object name, e.g. from hand_make) is joined to the body inside the cuff, and its skin colour is matched to the old hand's texture. Saves a checkpoint.

Everything of the body that is not the old hand keeps its vertices, UVs and weights unchanged (checked and reported). The new hand's vertex groups (named with the rig's prefix + LeftHand, LeftHandIndex1 ...) are added to the body's groups, so the finger bones from `hand_bones` drive it. Work on a copy: the old hand's vertices are deleted from the body mesh in this checkpoint.

params:
  body        the body mesh (default "body")
  hand        the hand object to attach (default "hand_L" / "hand_R" by `side`)
  side        "left" (default) or "right"
  armature    the rig (default "rig"); the wrist = the Hand bone's head, the direction = forearm to hand
  wrist_offset_mm  move the wrist along the forearm direction from the Hand bone's head (negative = toward the elbow), as in hand_make: use the same value
  cut_mm      where the old hand is cut: millimetres along the forearm direction from the wrist (the Hand bone's head, moved by wrist_offset_mm); default 0. Everything of the old hand beyond it goes. The new hand reaches back `insert` inside the cuff
  min_weight  a body vertex belongs to the old hand when its weight in the Hand bone group is at least this (default 0.05: any hand influence) and it lies beyond the cut
  rim_mm      a clean cuff rim: also delete every kept body vertex beyond this plane (mm along the forearm direction from the wrist, within 120 mm of the axis), whatever its Hand weight: torn shreds of the old sleeve past the rim go. Default none (the cut is by weight only)
  flatten_rim true: the open edge's vertices (the cuff's rim) are moved onto the rim plane (along the axis only; `rim_mm`, else the cut plane), so the rim is a clean planar loop. Only these vertices move: body_unchanged excludes them and `rim` reports how far they moved. Default false
  wrist_blend_mm  hand vertices that lie behind the Hand bone's head (toward the elbow) take a growing share of the ForeArm bone: 0 at the head, 1 at this distance behind it (smoothstep); the rest of their weights are scaled down to match. The wrist end then stays with the forearm (under the cuff) when the wrist bends, instead of swinging out about the Hand bone's head. Default 0 (off). Needs join true
  keep_material "auto" (default): when the hand already has a material with an image texture (painted), keep ALL its materials and UV layers as they are; the flat skin material is made only for a hand without one. true / false force it. The hand's UV layer keeps its own name (hand_make: "HandUV"); the body's UV layer is untouched
  lining_cap  true (default with lining_mm): also close the collar's far end with a fan of triangles to its centre (facing the hand), so no direction is open even where the hand's section could not be found; the hand passes through it
  lining_mm   a collar that closes the cut sleeve round the hand: new faces from the cuff's rim back into the sleeve by this depth, narrowing to the outline of the hand's wrist section there (+ `lining_margin_mm`, default 0.5), weighted to the ForeArm bone, in their own material (`lining_colour` [r,g,b] linear, default near black). Nothing of the body changes; it adds vertices and faces only, and the hand must reach back that far. Default 0 (off)
  join        true (default): the hand's faces become part of the body mesh (a second material slot: the hand's skin); false: leave the hand a separate object (parented to the rig with its own armature modifier)
  skin        "sample" (default): the hand's colour = the average of the body's base-colour texture over the old hand's UV area (linear, as the exporter writes it); or {"colour": [r, g, b]}
  rig_prefix  the prefix of the bones' names (default "mixamorig:")
  preview     true (default): clay pictures of the body's hand before and after at the same camera (out/handattach-<side>-before/after-palm/thumb/back.png); `palm` [x, y, z] the palm direction (default [0, 0, -1])
Returns: removed (old hand vertices, faces), cut (the plane: point and normal in mm), cuff (the body vertices that touch the removed hand and now form the open edge: count, centre, extent, and their range along the forearm axis from the wrist), hand (vertices, bounds in the wrist frame), skin (colour used and how it was sampled),
body_unchanged (vertices, weights, and UVs of everything that stayed: max change; the UV figure is the worst over EVERY UV layer), uv_layers_check (per UV layer by name: polygons compared and max change, the layer names and the active layer before and after; matched polygon by polygon, so a changed face order cannot fool it), lining (vertices, rim_quads, cap_triangles, depth, hand section found, directions without a hand section), weights (the hand's groups on the body, unweighted vertices, max influences), joined (the object and its material slots).
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
from _handview import render_views  # noqa: E402


def sample_texture(body, uvname, verts_idx, me):
    """the average colour of the body's base-colour image at the UV positions of the given vertices (linear): (colour, how)"""
    mat = next((m for m in body.data.materials if m and m.use_nodes), None)
    if mat is None:
        return None, "the body has no node material"
    pr = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    img = None
    if pr is not None and pr.inputs["Base Color"].is_linked:
        n = pr.inputs["Base Color"].links[0].from_node
        if n.type == "TEX_IMAGE":
            img = n.image
    if img is None:
        img = next((n.image for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image and n.image.colorspace_settings.name == "sRGB"), None)
    if img is None or img.size[0] == 0:
        return None, "no base-colour image found"
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    uvl = me.uv_layers[uvname].data
    vs = set(int(i) for i in verts_idx)
    cols = []
    for lp in me.loops:
        if lp.vertex_index in vs:
            u, v = uvl[lp.index].uv
            cols.append(px[min(max(int(v * h), 0), h - 1), min(max(int(u * w), 0), w - 1), :3])
    if len(cols) < 10:
        return None, "too few UV samples"
    c = np.array(cols)
    # the texture holds sRGB-encoded values: average in linear, report linear
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return lin.mean(0), f"{len(cols)} texels of {img.name}"


def main():
    body = bpy.data.objects.get(L.param("body", "body"))
    side = L.param("side", "left")
    S = "Left" if side == "left" else "Right"
    pre = L.param("rig_prefix", "mixamorig:")
    hand = bpy.data.objects.get(L.param("hand", "hand_L" if side == "left" else "hand_R"))
    arm = bpy.data.objects.get(L.param("armature", "rig"))
    if body is None or body.type != "MESH" or hand is None or hand.type != "MESH" or arm is None:
        raise RuntimeError("need the body mesh, the hand mesh and the rig")
    me = body.data
    hb = arm.data.bones.get(pre + S + "Hand")
    fb = arm.data.bones.get(pre + S + "ForeArm")
    if hb is None or fb is None:
        raise RuntimeError(f"the rig needs {S}Hand and {S}ForeArm bones")
    mw = arm.matrix_world
    wrist = np.array(mw @ hb.head_local)
    axis = wrist - np.array(mw @ fb.head_local)
    axis /= np.linalg.norm(axis)
    wrist = wrist + axis * (float(L.param("wrist_offset_mm", 0.0)) / 1000)
    cut = float(L.param("cut_mm", 0.0)) / 1000
    minw = float(L.param("min_weight", 0.05))
    gname = pre + S + "Hand"
    if gname not in body.vertex_groups:
        raise RuntimeError(f"the body has no {gname} vertex group")
    gi = body.vertex_groups[gname].index
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    Mb = np.array(body.matrix_world)
    P = co.reshape(-1, 3) @ Mb[:3, :3].T + Mb[:3, 3]
    wh = np.zeros(n)
    for vv in me.vertices:
        for g in vv.groups:
            if g.group == gi:
                wh[vv.index] = g.weight
    s = (P - wrist) @ axis
    old = (wh >= minw) & (s > cut)
    rim = L.param("rim_mm")
    n_trim = 0
    if rim is not None:
        rad = np.linalg.norm((P - wrist) - np.outer(s, axis), axis=1)
        trim = (s > float(rim) / 1000) & (rad < 0.12) & ~old
        n_trim = int(trim.sum())
        old = old | trim
    if old.sum() < 20:
        raise RuntimeError(f"only {int(old.sum())} body vertices are beyond the cut with a {gname} weight of {minw}: nothing to replace (check cut_mm, min_weight, the side)")
    uvn = me.uv_layers.active.name if me.uv_layers.active else None
    skin = L.param("skin", "sample")
    if isinstance(skin, dict):
        colour, how = np.array(skin["colour"], float), "given"
    else:
        colour, how = (sample_texture(body, uvn, np.nonzero(old)[0], me) if uvn else (None, "no UV layer"))
        if colour is None:
            colour = np.array([0.55, 0.30, 0.22])
            how = f"default ({how})"
    # ---- before: what must not change
    W0 = np.zeros((n, len(body.vertex_groups)), np.float32)
    for vv in me.vertices:
        for g in vv.groups:
            W0[vv.index, g.group] = g.weight
    uv0 = None
    if uvn:
        u_ = np.empty(len(me.loops) * 2)
        me.uv_layers[uvn].data.foreach_get("uv", u_)
        uv0 = u_.reshape(-1, 2)
    vi_loop = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", vi_loop)
    keep_idx = np.nonzero(~old)[0]
    # per-layer record of the kept polygons' UVs (every layer by name), to prove below that no layer changed
    uv_names0 = [l_.name for l_ in me.uv_layers]
    active0 = me.uv_layers.active.name if me.uv_layers.active else None
    kept_poly = np.array([not old[list(p_.vertices)].any() for p_ in me.polygons], bool)
    rank_new = np.cumsum(~old) - 1
    kept_polys = [p_ for p_ in me.polygons if not old[list(p_.vertices)].any()]
    layer_uv0 = {}
    for nm_ in uv_names0:
        a_ = np.empty(len(me.loops) * 2)
        me.uv_layers[nm_].data.foreach_get("uv", a_)
        a_ = a_.reshape(-1, 2)
        d0_ = {}
        for p_ in kept_polys:
            vs_ = [int(rank_new[v_]) for v_ in p_.vertices]  # the vertex numbers AFTER the cut (the kept ones, renumbered in order)
            d0_.setdefault(tuple(sorted(vs_)), []).append({vi_: a_[p_.loop_start + k_].copy() for k_, vi_ in enumerate(vs_)})
        layer_uv0[nm_] = d0_
    names0 = [g.name for g in body.vertex_groups]
    cnt0 = np.bincount(vi_loop, minlength=n)
    uvs0 = np.zeros((n, 2))
    if uv0 is not None:
        np.add.at(uvs0, vi_loop, uv0)
    pics = []
    if L.param("preview", True):
        hl = float(np.percentile(s[wh >= minw], 99.5)) if (wh >= minw).any() else 0.1
        palm_d = Vector(L.param("palm", [0, 0, -1])).normalized()
        thumb_d = palm_d.cross(Vector(axis.tolist()))
        if side == "right":
            thumb_d = -thumb_d
        ctr = Vector((wrist + axis * (0.5 * hl)).tolist())
        dirs = {"palm": palm_d, "thumb": thumb_d, "back": -palm_d}
        os.makedirs(L.ARGS["out_dir"], exist_ok=True)
        pics += render_views([body], ctr, max(2.4 * hl, 0.12), f"handattach-{side}-before", 520, dirs)
    # ---- cut: delete the old hand's vertices (faces go with them)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    nf0 = len(bm.faces)
    # the kept vertices that touch the old hand: they become the cuff's open edge
    edge_v = set()
    for i in np.nonzero(old)[0]:
        for e_ in bm.verts[int(i)].link_edges:
            o_ = e_.other_vert(bm.verts[int(i)])
            if not old[o_.index]:
                edge_v.add(o_.index)
    oi_l = bm.verts.layers.int.new("orig_index")  # (adding a layer invalidates earlier references: make it first)
    bm.verts.ensure_lookup_table()
    for v_ in bm.verts:
        v_[oi_l] = v_.index
    edge_refs = {i: bm.verts[i] for i in edge_v}
    # ---- the lining: a collar from the cuff's rim back into the sleeve, narrowing to the hand's wrist section, so the cut sleeve is closed round a slim wrist (no through-hole)
    nl, lining_info = 0, None
    cap_centre = None
    lin = float(L.param("lining_mm", 0.0)) / 1000
    if lin > 0 and edge_v:
        from _slice import slice_points, outline_radius
        palm_l = np.array(Vector(L.param("palm", [0, 0, -1])).normalized())
        vl = np.cross(palm_l, axis)
        if side == "right":
            vl = -vl
        vl /= np.linalg.norm(vl)
        ep_ = P[sorted(edge_v)] + 0.0
        s_rim_ = float(((P[sorted(edge_v)] - wrist) @ axis).mean()) if not (L.param("flatten_rim", False)) else (float(rim) / 1000 if rim is not None else cut)
        hmw = np.array(hand.matrix_world)
        hme = hand.data
        hme.calc_loop_triangles()
        Ph = np.array([list(x_.co) for x_ in hme.vertices]) @ hmw[:3, :3].T + hmw[:3, 3]
        Th = np.array([t_.vertices[:] for t_ in hme.loop_triangles], dtype=np.int64)
        s_back = s_rim_ - lin
        hp = slice_points(Ph, Th, wrist, axis, vl, palm_l, s_back)
        rc = (P[sorted(edge_v)] - wrist)
        c2 = np.array([float((rc @ vl).mean()), float((rc @ palm_l).mean())])
        margin = float(L.param("lining_margin_mm", 0.5)) / 1000
        lcol = L.param("lining_colour", [0.02, 0.02, 0.02])
        lmat = bpy.data.materials.new("cuff-lining")
        lmat.use_nodes = True
        lb = next(nd for nd in lmat.node_tree.nodes if nd.type == "BSDF_PRINCIPLED")
        lb.inputs["Base Color"].default_value = (float(lcol[0]), float(lcol[1]), float(lcol[2]), 1.0)
        lb.inputs["Roughness"].default_value = 0.9
        me.materials.append(lmat)
        mslot = len(me.materials) - 1
        fname_ = pre + S + "ForeArm"
        fg_ = body.vertex_groups.get(fname_) or body.vertex_groups.new(name=fname_)
        dl = bm.verts.layers.deform.verify()
        Mi_ = np.linalg.inv(Mb)
        newv = {}
        missing = 0
        for i, vv in edge_refs.items():
            pw = P[i] + (axis * (s_rim_ - float((P[i] - wrist) @ axis)) if L.param("flatten_rim", False) else 0.0)
            q = pw - wrist
            qv, qw = float(q @ vl) - c2[0], float(q @ palm_l) - c2[1]
            th_ = math.atan2(qw, qv)
            rr_ = float(outline_radius(hp, c2, th_, bins=72)[0]) if len(hp) >= 6 else float("nan")
            rin = (rr_ + margin) if not math.isnan(rr_) else 0.8 * math.hypot(qv, qw)
            missing += int(math.isnan(rr_))
            newp = wrist + axis * s_back + vl * (c2[0] + rin * math.cos(th_)) + palm_l * (c2[1] + rin * math.sin(th_))
            nv = bm.verts.new(Vector((Mi_[:3, :3] @ newp + Mi_[:3, 3]).tolist()))
            nv[dl][fg_.index] = 1.0
            newv[i] = nv
        cap_centre = None
        if newv and L.param("lining_cap", True):
            cpos = np.mean([np.array(Mb[:3, :3] @ np.array(v_.co) + Mb[:3, 3]) for v_ in newv.values()], axis=0)
            cap_centre = bm.verts.new(Vector((Mi_[:3, :3] @ cpos + Mi_[:3, 3]).tolist()))
            cap_centre[dl][fg_.index] = 1.0
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(old)[0]], context="VERTS")
    removed_faces = nf0 - len(bm.faces)
    flat_idx, flat_move = [], 0.0
    if L.param("flatten_rim", False) and edge_v:
        plane = float(rim) / 1000 if rim is not None else cut
        Mi = np.linalg.inv(Mb)
        for i in sorted(edge_v):
            vv = edge_refs[i]
            d = plane - float((P[i] - wrist) @ axis)
            flat_move = max(flat_move, abs(d))
            newp = P[i] + axis * d
            vv.co = Vector((Mi[:3, :3] @ newp + Mi[:3, 3]).tolist())
            flat_idx.append(i)
    capn_ = 0
    quads_ = 0
    if lin > 0 and edge_v:
        for e_ in list(bm.edges):
            if len(e_.link_faces) == 1 and e_.verts[0][oi_l] in newv and e_.verts[1][oi_l] in newv:
                a_, b_ = None, None
                for lp in e_.link_faces[0].loops:
                    if lp.edge == e_:
                        a_, b_ = lp.vert, lp.link_loop_next.vert
                try:
                    f_ = bm.faces.new((b_, a_, newv[a_[oi_l]], newv[b_[oi_l]]))
                    f_.material_index = mslot
                    f_.smooth = True
                    quads_ += 1
                except ValueError:
                    pass
                if cap_centre is not None:
                    tri = (cap_centre, newv[b_[oi_l]], newv[a_[oi_l]])
                    nrm = (tri[1].co - cap_centre.co).cross(tri[2].co - cap_centre.co)
                    if (Mb[:3, :3] @ np.array(nrm)) @ axis < 0:
                        tri = (cap_centre, newv[a_[oi_l]], newv[b_[oi_l]])
                    try:
                        f2 = bm.faces.new(tri)
                        f2.material_index = mslot
                        f2.smooth = True
                        capn_ += 1
                    except ValueError:
                        pass
        capn = capn_
        nl = len(newv) + (1 if cap_centre is not None else 0)
        lining_info = {"vertices": nl, "depth_mm": round(lin * 1000, 1), "plane_mm_along_axis": round(s_back * 1000, 1), "hand_section_found": bool(len(hp) >= 6), "directions_without_hand_section": int(missing), "cap_triangles": capn, "rim_quads": quads_}
    cuff = None
    if edge_v:
        ep = P[sorted(edge_v)]
        c0 = ep.mean(0)
        rel = ep - c0
        cuff = {"open_edge_vertices": len(edge_v), "centre_mm": [round(float(x) * 1000, 1) for x in c0], "extent_mm": [round(float(np.ptp(rel[:, k]) * 1000), 1) for k in range(3)],
                "along_axis_mm": [round(float(((ep - wrist) @ axis).min() * 1000), 1), round(float(((ep - wrist) @ axis).max() * 1000), 1)]}
    bm.verts.layers.int.remove(oi_l)
    bm.to_mesh(me)
    bm.free()
    me.update()
    # ---- the hand: skin material, then join
    keep = L.param("keep_material", "auto")
    has_tex = any(m_ is not None and m_.use_nodes and any(nd.type == "TEX_IMAGE" for nd in m_.node_tree.nodes) for m_ in hand.data.materials)
    keep = has_tex if keep == "auto" else bool(keep)
    if keep and len(hand.data.materials) == 0:
        keep = False
    if keep:
        hmat = hand.data.materials[0]
        how = "kept the hand's own material(s): " + ", ".join(m_.name for m_ in hand.data.materials if m_)
    else:
        hmat = bpy.data.materials.new(f"{hand.name}-skin")
        hmat.use_nodes = True
        bsdf = next(nd for nd in hmat.node_tree.nodes if nd.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (float(colour[0]), float(colour[1]), float(colour[2]), 1.0)
        bsdf.inputs["Roughness"].default_value = 0.6
        hand.data.materials.clear()
        hand.data.materials.append(hmat)
    joined = None
    if L.param("join", True):
        bpy.ops.object.select_all(action="DESELECT")
        hand.select_set(True)
        body.select_set(True)
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.join()
        joined = {"object": body.name, "material_slots": [m.name if m else None for m in body.data.materials]}
    else:
        hand.parent = body.parent
        hand.matrix_parent_inverse = body.matrix_parent_inverse
        md = hand.modifiers.new("Armature", "ARMATURE")
        md.object = arm
        joined = {"object": hand.name, "material_slots": [m_.name for m_ in hand.data.materials if m_]}
    me = body.data
    if L.param("preview", True):
        pics += render_views([body] if L.param("join", True) else [body, hand], ctr, max(2.4 * hl, 0.12), f"handattach-{side}-after", 520, dirs)
    # ---- after: what stayed is unchanged
    nn = len(me.vertices)
    result = {}
    if L.param("join", True):
        co2 = np.empty(nn * 3)
        me.vertices.foreach_get("co", co2)
        P2 = co2.reshape(-1, 3) @ Mb[:3, :3].T + Mb[:3, 3]
        # the kept vertices come first, in their old order
        nk = len(keep_idx)
        fl = np.isin(keep_idx, np.array(flat_idx, dtype=np.int64))
        dpos = float(np.abs(P2[:nk][~fl] - P[keep_idx][~fl]).max()) if nk <= nn else None
        if fl.any():
            result["rim"] = {"flattened_vertices": int(fl.sum()), "max_move_mm": round(flat_move * 1000, 2), "plane_mm_along_axis": round((float(rim) if rim is not None else cut * 1000), 2),
                             "deleted_beyond_rim": n_trim}
        W2 = np.zeros((nn, len(body.vertex_groups)), np.float32)
        names2 = [g.name for g in body.vertex_groups]
        for vv in me.vertices:
            for g in vv.groups:
                W2[vv.index, g.group] = g.weight
        dw = 0.0
        for gi0, nm in enumerate(names0):
            gi2 = names2.index(nm)
            dw = max(dw, float(np.abs(W2[:nk, gi2] - W0[keep_idx, gi0]).max()))
        dw_other = 0.0
        # the hand's groups must not be non-zero on kept vertices, and the body's old hand group is unchanged above
        vi2 = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("vertex_index", vi2)
        cnt2 = np.bincount(vi2, minlength=nn)
        uvs2 = np.zeros((nn, 2))
        if uvn:
            u2 = np.empty(len(me.loops) * 2)
            me.uv_layers[uvn].data.foreach_get("uv", u2)
            np.add.at(uvs2, vi2, u2.reshape(-1, 2))
        same_cnt = cnt2[:nk] == cnt0[keep_idx]
        duv = float(np.abs(uvs2[:nk][same_cnt] - uvs0[keep_idx][same_cnt]).max()) if same_cnt.any() else None
        if active0 and active0 in me.uv_layers:
            me.uv_layers.active = me.uv_layers[active0]  # the body's own layer stays the active one (a join may have switched it)
        layers_chk = {}
        for nm_ in uv_names0:
            if nm_ not in me.uv_layers:
                layers_chk[nm_] = {"present_after": False}
                continue
            b_ = np.empty(len(me.loops) * 2)
            me.uv_layers[nm_].data.foreach_get("uv", b_)
            b_ = b_.reshape(-1, 2)
            worst, nmatch, nbad_, bad_s = 0.0, 0, 0, []
            d0_ = layer_uv0[nm_]
            for p_ in me.polygons:
                vs_ = list(p_.vertices)
                if max(vs_) >= nk:
                    continue  # a new face (the hand, the lining)
                cands_ = d0_.get(tuple(sorted(vs_)))
                if cands_ is None:
                    continue
                nmatch += 1
                # faces that share their vertices (double-sided cloth) are told apart by taking the closest earlier face
                best_ = min(max(float(np.abs(b_[p_.loop_start + k_] - dd_[vi_]).max()) for k_, vi_ in enumerate(vs_)) for dd_ in cands_)
                worst = max(worst, best_)
                if best_ > 1e-6:
                    nbad_ = nbad_ + 1
                    if len(bad_s) < 3:
                        dd0_ = cands_[0]
                        bad_s.append({"verts": vs_,  "before": [[round(float(x), 4) for x in dd0_[vi_]] for vi_ in vs_], "after": [[round(float(x), 4) for x in b_[p_.loop_start + k_]] for k_ in range(len(vs_))], "n_candidates": len(cands_)})
            layers_chk[nm_] = {"present_after": True, "polygons_compared": int(nmatch), "of_kept": int(sum(len(v_) for v_ in d0_.values())), "max_change": round(worst, 7), "polygons_changed": nbad_, "examples": bad_s}
        result["uv_layers_check"] = {"layers_before": uv_names0, "layers_after": [l_.name for l_ in me.uv_layers], "active_before": active0, "active_after": me.uv_layers.active.name if me.uv_layers.active else None,
                                     "per_layer": layers_chk, "how": "every layer by name, loop by loop, on every polygon that was not cut away, matched by its vertices (the polygon order may change in a join)"}
        result["body_unchanged"] = {"kept_vertices": int(nk), "position_max_change_mm": round(dpos * 1000, 6) if dpos is not None else None, "weights_max_change": round(dw, 7),
                                    "uv_max_change": round(max([v_.get("max_change", 0.0) for v_ in layers_chk.values()] or [0.0]), 7), "uv_check_note": "uv_max_change = the worst change over EVERY UV layer, loop by loop (see uv_layers_check); the old per-vertex sum measure is gone: it misread vertices whose faces changed at the cuff",  "vertices_with_unchanged_face_count_compared": int(same_cnt.sum())}
        hands = np.arange(nk + nl, nn)
        wb = float(L.param("wrist_blend_mm", 0.0)) / 1000
        if wb > 0:
            head_s = float((np.array(mw @ hb.head_local) - wrist) @ axis)
            fname = pre + S + "ForeArm"
            fg = body.vertex_groups.get(fname) or body.vertex_groups.new(name=fname)
            nb, wmax = 0, 0.0
            for i in hands:
                t = (head_s - float((P2[i] - wrist) @ axis)) / wb
                if t <= 0:
                    continue
                t = min(t, 1.0)
                wf = t * t * (3 - 2 * t)
                for g in list(me.vertices[i].groups):
                    gg = body.vertex_groups[g.group]
                    if gg.index != fg.index:
                        gg.add([int(i)], g.weight * (1 - wf), "REPLACE")
                fg.add([int(i)], wf, "REPLACE")
                nb += 1
                wmax = max(wmax, wf)
            result["wrist_blend"] = {"hand_vertices_blended": nb, "max_forearm_weight": round(wmax, 3), "head_behind_wrist_mm": round(head_s * 1000, 2)}
        infl = max((sum(1 for g in me.vertices[i].groups if g.weight > 1e-4) for i in hands), default=0)
        unw = int(sum(1 for i in hands if not me.vertices[i].groups))
        result["weights"] = {"hand_vertices": int(len(hands)), "max_influences": int(infl), "unweighted_hand_vertices": unw,
                             "groups_added": [g.name for g in body.vertex_groups if g.name.startswith(pre + S + "Hand") and g.name != gname]}
        Hh = P2[nk + nl:]
        result["hand"] = {"vertices": int(len(hands)), "bounds_mm": [[round(float(x) * 1000, 1) for x in Hh.min(0)], [round(float(x) * 1000, 1) for x in Hh.max(0)]]}
    L.finish({"removed": {"vertices": int(old.sum()), "faces": int(removed_faces)}, "cut": {"point_mm": [round(float(x) * 1000, 1) for x in (wrist + axis * cut)], "normal": [round(float(x), 4) for x in axis]},
              "cuff": cuff, "skin": {"colour_linear": [round(float(x), 4) for x in colour], "how": how}, "joined": joined, "lining": lining_info, "pictures": [os.path.basename(p) for p in pics], **result}, save=True, files=pics)


L.run(main)
