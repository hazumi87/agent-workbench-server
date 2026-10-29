"""kit2_bandfit — conform the soft band of a part (the waistband of a kilt) smoothly outside the body, keeping its thickness, with the hanging tabs carried rigid or left alone. Saves a checkpoint.

kit2_tweak's `wrap` moves every vertex on its own toward a distance from the host, so the inner and the outer surface of a thick band move by different amounts: it thins, folds and tears.
This verb works out where the band's INNER side is too close (or too far) and moves BOTH sides of the band by the same smooth amount at that place:
 1. every band vertex gets its signed distance to the host (positive = outside the host's surface, the host's normals must point outward);
 2. at each place the band's inner side is the smallest distance among the band's vertices within `probe_mm`; the displacement needed is `clearance_mm` minus that;
 3. the displacement is a vector along the host's normal, averaged over the band's vertices within `smooth_mm` (Gaussian), so it changes slowly compared with the band's thickness;
 4. what hangs below the band is cut into pieces (connected pieces once the band is removed): with tabs "carry" each tab is moved as one rigid piece by the displacement at its attachment, with a blend
    zone just under the band; with "keep" the tabs stay where they are and the displacement fades out over `blend_mm` at the band's lower edge.

params:
  name         the part (required)
  host         object name, or a list of names (default "body"): what the band must stay outside; its normals must point outward
  outward      "normals" (default): the host's face normals say which side is outside; or "radial": for an open or thin garment shell (a kilt, a harness strap) whose normals can't be trusted, outside means farther
               from the vertical `axis` than the host surface at that place, and the band is pushed radially away from the axis. The host's normals are then not used at all.
  axis         for "radial": "centre" (default: the band's own x/y centre) or [x, y] in metres: the line through the body the garments hang around
  band_mm      height of the band measured down from the part's top (default 30), or band_z_mm [low, high] in millimetres in world z
  clearance_mm gap wanted between the host's surface and the band's inner side (default 4)
  smooth_mm    radius over which the displacement is averaged (default 30; keep it several times the band's thickness)
  probe_mm     radius for finding the band's inner side (default 12; about the band's thickness plus its fold)
  push_only    true = only push outward, never pull in (default false)
  max_mm       largest displacement (default 40)
  tabs         "carry" (default) or "keep"
  blend_mm     blend zone under the band (default 10)
  keep_box     {c:[x,y,z], size:[x,y,z]} in metres (world): a protected region (a buckle). Every vertex inside it stays EXACTLY where it is; outside it the displacement fades in
               smoothly over keep_blend_mm, the same for the inner and the outer side of the band, so the thickness is kept. A list of boxes is allowed.
  keep_blend_mm  width of that fade outside the box (default 15)
  dry_run      true = report only, change and save nothing
Returns: band (vertices, z range), inner_gap_mm before/after (p5, median, p95 of the band's inner-side distance to the host), thickness_change_mm (median and largest change of the band's thickness proxy: the spread of distances within probe_mm),
protected (vertices inside keep_box, their largest move: 0, and the fade zone's vertex count), max_move_mm, flipped_triangles (band triangles whose normal turned over: 0), band_edge_stretch_pct (largest change of an edge length in the band), tabs (count, floating pieces), warnings.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.kdtree import KDTree  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402
import kit2_seatlib as S  # noqa: E402


def pieces(nv, edges, skip):
    parent = list(range(nv))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a, b in edges:
        if skip[a] or skip[b]:
            continue
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    lab = np.full(nv, -1)
    ids = {}
    for i in range(nv):
        if skip[i]:
            continue
        lab[i] = ids.setdefault(find(i), len(ids))
    return lab, len(ids)


def main():
    name = L.param("name")
    o = bpy.data.objects.get(name or "")
    if o is None or o.type != "MESH":
        raise RuntimeError(f"no mesh named {name}")
    hosts, hb = S.hosts_of(L.param("host", "body"))
    v0 = K.verts(o).copy()
    nv = len(v0)
    if L.param("band_z_mm") is not None:
        zlo, zhi = [float(x) / 1000.0 for x in L.param("band_z_mm")]
    else:
        zhi = float(v0[:, 2].max())
        zlo = zhi - float(L.param("band_mm", 30)) / 1000.0
    inband = (v0[:, 2] >= zlo) & (v0[:, 2] <= zhi)
    bidx = np.where(inband)[0]
    if len(bidx) < 20:
        raise RuntimeError(f"only {len(bidx)} vertices in the band z {zlo * 1000:.0f} to {zhi * 1000:.0f} mm: check band_mm / band_z_mm")
    clear = float(L.param("clearance_mm", 4)) / 1000.0
    smooth = float(L.param("smooth_mm", 30)) / 1000.0
    probe = float(L.param("probe_mm", 12)) / 1000.0
    push_only = bool(L.param("push_only", False))
    max_mv = float(L.param("max_mm", 40)) / 1000.0
    tabs = L.param("tabs", "carry")
    if tabs not in ("carry", "keep"):
        raise RuntimeError('tabs must be "carry" or "keep"')
    blend = float(L.param("blend_mm", 10)) / 1000.0
    warnings = []

    # 1. signed distance to the host and the direction outward, for every band vertex
    outward = L.param("outward", "normals")
    if outward not in ("normals", "radial"):
        raise RuntimeError('outward must be "normals" or "radial"')
    ax_p = L.param("axis", "centre")
    if ax_p == "centre":
        ax_x, ax_y = [float((v0[bidx].max(0)[k] + v0[bidx].min(0)[k]) / 2) for k in (0, 1)]
    elif isinstance(ax_p, list) and len(ax_p) == 2:
        ax_x, ax_y = float(ax_p[0]), float(ax_p[1])
    else:
        raise RuntimeError('axis must be "centre" or [x, y] in metres')
    d = np.zeros(nv)
    U = np.zeros((nv, 3))
    inside = 0
    for i in bidx:
        p = Vector(v0[i])
        loc, nrm, _, dist = hb.find_nearest(p)
        if outward == "radial":
            rl = np.array([loc.x - ax_x, loc.y - ax_y])
            nl = np.linalg.norm(rl)
            rl = rl / nl if nl > 1e-9 else np.array([1.0, 0.0])
            s = 1.0 if ((p.x - loc.x) * rl[0] + (p.y - loc.y) * rl[1]) >= 0 else -1.0
            rp = np.array([p.x - ax_x, p.y - ax_y])
            npn = np.linalg.norm(rp)
            U[i] = [rp[0] / npn, rp[1] / npn, 0.0] if npn > 1e-9 else [1.0, 0.0, 0.0]
        else:
            s = 1.0 if (p - loc).dot(nrm) >= 0 else -1.0
            U[i] = np.array(nrm)
        inside += s < 0
        d[i] = s * dist
    if inside == 0 and (d[bidx].min() > clear + 0.05):
        warnings.append("the band is already clear of the host everywhere; with push_only false it is pulled in toward the clearance")
    kd = KDTree(len(bidx))
    for k, i in enumerate(bidx):
        kd.insert(Vector(v0[i]), k)
    kd.balance()
    pos = {int(i): k for k, i in enumerate(bidx)}
    # 2. the band's inner side: the smallest distance within probe_mm; the thickness proxy: the spread of distances there
    gmin = np.zeros(len(bidx))
    spread = np.zeros(len(bidx))
    nb_probe = []
    for k, i in enumerate(bidx):
        ns = [n for _, n, _ in kd.find_range(Vector(v0[i]), probe)]
        nb_probe.append(ns)
        dd = d[bidx[ns]]
        gmin[k], spread[k] = dd.min(), dd.max() - dd.min()
    need = clear - gmin
    if push_only:
        need = np.maximum(need, 0.0)
    vec = need[:, None] * U[bidx]
    # 3. smooth the displacement vectors over smooth_mm
    sig = smooth / 2.0
    disp_b = np.zeros((len(bidx), 3))
    for k, i in enumerate(bidx):
        ns = kd.find_range(Vector(v0[i]), smooth)
        idx = np.array([n for _, n, _ in ns])
        r = np.array([dd for _, _, dd in ns])
        w = np.exp(-0.5 * (r / sig) ** 2)
        disp_b[k] = (w[:, None] * vec[idx]).sum(0) / w.sum()
    mag = np.linalg.norm(disp_b, axis=1)
    over = mag > max_mv
    disp_b[over] *= (max_mv / mag[over])[:, None]
    if over.any():
        warnings.append(f"{int(over.sum())} band vertices wanted more than max_mm ({max_mv * 1000:g}); capped")
    v1 = v0.copy()
    fade = np.ones(len(bidx))
    if tabs == "keep" and blend > 0:
        fade = np.clip((v0[bidx, 2] - zlo) / blend, 0, 1)
    v1[bidx] = v0[bidx] + disp_b * fade[:, None]
    # 4. what hangs below the band
    edges = np.array([e.vertices[:] for e in o.data.edges])
    lab, npc = pieces(nv, edges, inband)
    n_hang = n_float = 0
    if npc and tabs == "carry":
        touch = {}
        for a, b in edges:
            if inband[a] and not inband[b]:
                touch.setdefault(int(b), []).append(pos[int(a)])
            elif inband[b] and not inband[a]:
                touch.setdefault(int(a), []).append(pos[int(b)])
        pdisp = {}
        for t, ks in touch.items():
            pdisp.setdefault(int(lab[t]), []).append(disp_b[ks].mean(0))
        D = {k: np.mean(v, axis=0) for k, v in pdisp.items()}
        n_hang = len(D)
        cen = {k: v0[lab == k].mean(0) for k in range(npc)}
        for k in range(npc):
            if k not in D:
                n_float += 1
                if D:
                    D[k] = D[min(D, key=lambda h: float(np.linalg.norm(cen[h] - cen[k])))]
        for k in range(npc):
            m = np.where(lab == k)[0]
            rigid = np.tile(D.get(k, np.zeros(3)), (len(m), 1))
            if blend > 0:
                w = np.clip(1 - (zlo - v0[m, 2]) / blend, 0, 1)[:, None]
                nearest = np.array([disp_b[kd.find(Vector(v0[i]))[1]] for i in m])
                v1[m] = v0[m] + w * nearest + (1 - w) * rigid
            else:
                v1[m] = v0[m] + rigid
    elif npc and tabs == "keep":
        n_hang = npc
    if not (n_hang or n_float):
        warnings.append("nothing hangs below the band: only the band moved")
    # a protected region: nothing inside moves, and the displacement fades in over keep_blend_mm outside it
    prot = None
    kb = L.param("keep_box")
    if kb:
        boxes = kb if isinstance(kb, list) else [kb]
        kblend = max(float(L.param("keep_blend_mm", 15)) / 1000.0, 1e-6)
        dist = np.full(nv, 1e9)
        for b in boxes:
            q = np.abs(v0 - np.array(b["c"], dtype=float)) - np.array(b["size"], dtype=float) / 2.0
            dist = np.minimum(dist, np.linalg.norm(np.maximum(q, 0.0), axis=1))
        t = np.clip(dist / kblend, 0, 1)
        wk = t * t * (3 - 2 * t)
        v1 = v0 + (v1 - v0) * wk[:, None]
        v1[dist == 0] = v0[dist == 0]
        ins = dist == 0
        prot = {"vertices_inside": int(ins.sum()), "max_move_inside_mm": K.mm(np.linalg.norm(v1 - v0, axis=1)[ins].max()) if ins.any() else 0.0,
                "fade_vertices": int(((dist > 0) & (dist < kblend)).sum())}
    # measures
    gmin1 = np.zeros(len(bidx))
    spread1 = np.zeros(len(bidx))
    d1 = np.zeros(nv)
    for i in bidx:
        p = Vector(v1[i])
        loc, nrm, _, dist = hb.find_nearest(p)
        if outward == "radial":  # the same side rule as step 1
            rl = np.array([loc.x - ax_x, loc.y - ax_y])
            nl = np.linalg.norm(rl)
            rl = rl / nl if nl > 1e-9 else np.array([1.0, 0.0])
            sg = 1.0 if ((p.x - loc.x) * rl[0] + (p.y - loc.y) * rl[1]) >= 0 else -1.0
        else:
            sg = 1.0 if (p - loc).dot(nrm) >= 0 else -1.0
        d1[i] = sg * dist
    for k, ns in enumerate(nb_probe):
        dd = d1[bidx[ns]]
        gmin1[k], spread1[k] = dd.min(), dd.max() - dd.min()
    me = o.data
    me.calc_loop_triangles()
    tri = np.array([t.vertices[:] for t in me.loop_triangles])
    tb = inband[tri].all(1)

    def fn(v):
        a, b, c = v[tri[:, 0]], v[tri[:, 1]], v[tri[:, 2]]
        n = np.cross(b - a, c - a)
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    flipped = int(((fn(v0) * fn(v1)).sum(1) < 0)[tb].sum())
    eb = edges[inband[edges[:, 0]] & inband[edges[:, 1]]]
    l0 = np.linalg.norm(v0[eb[:, 0]] - v0[eb[:, 1]], axis=1)
    l1 = np.linalg.norm(v1[eb[:, 0]] - v1[eb[:, 1]], axis=1)
    stretch = float(np.abs(l1 / np.maximum(l0, 1e-9) - 1).max() * 100)
    pct = lambda a: {"p5": K.mm(np.percentile(a, 5)), "median": K.mm(np.median(a)), "p95": K.mm(np.percentile(a, 95))}  # noqa: E731
    mvmag = np.linalg.norm(v1 - v0, axis=1)
    dry = bool(L.param("dry_run", False))
    if not dry:
        K.set_verts(o, v1)
    out = {"name": o.name, "host": ", ".join(h.name for h in hosts), "outward": outward, "band": {"vertices": int(len(bidx)), "z_mm": [K.mm(zlo), K.mm(zhi)], "inside_host_vertices": int(inside)},
           "inner_gap_mm": {"before": pct(gmin), "after": pct(gmin1)}, "thickness_change_mm": {"median": K.mm(np.median(spread1 - spread)), "largest": K.mm(np.abs(spread1 - spread).max())},
           "max_move_mm": K.mm(mvmag.max()), "mean_move_band_mm": K.mm(mvmag[bidx].mean()), "flipped_triangles": flipped, "band_edge_stretch_pct": round(stretch, 2),
           "protected": prot,
           "tabs": {"mode": tabs, "count": n_hang, "floating_pieces": n_float}, "warnings": warnings, "dry_run": dry}
    L.finish(out, save=not dry)


L.run(main)
