"""kit2_ringfit — enlarge (or shrink) a hanging ring part (a kilt, a skirt, a belt with hanging tabs) around the body in x and y, keeping every hanging tab's size and detail: the ring band is stretched,
the tabs are carried by their top attachments and stay rigid below. Saves a checkpoint.

How: the part's top band (the waistband, `band_mm` from the top) is scaled about a vertical axis in x and y only (heights are kept). What hangs below the band is cut into pieces (connected pieces of the
mesh once the band is taken away): each tab, with its studs and details, is moved as ONE rigid piece to follow where its attachment to the band went, and (with `rotate`) turned about the vertical so it keeps
facing outward. A short blend zone (`blend_mm`) just under the band lets the top of each tab follow the band so nothing tears. Tab length, tab width and the studs are not scaled. Loose pieces with no
connection to the band (floating studs) go with the nearest tab.

params:
  name       the part (required)
  scale      [sx, sy], or one number for both: how much the band's width (x) and depth (y) grow; 1 = unchanged
  grow_mm    [dx, dy]: or give the growth in millimetres of the band's overall width and depth (instead of `scale`)
  about      the vertical axis the band is scaled about: "centre" (default: the band's own x/y centre) or [x, y] in metres
  band_mm    height of the stretched band measured down from the part's top (default 30). Everything lower is carried, not stretched
  blend_mm   blend zone just under the band (default 10)
  rotate     true (default): turn each tab about the vertical to follow the ring
  dry_run    true = report only, change and save nothing
Returns: band (vertices, size_mm before/after), tabs (how many pieces hang from the band, each with its size, attachment, move and turn), floating_pieces, size_mm before/after (the height does not change),
tab_size_change_mm (the largest change of a tab's axis-aligned box: 0 unless a tab turns, then a fraction of a millimetre), max_edge_change_mm (the largest change of any edge length in the tabs below the blend zone: 0, the real proof that they stay rigid), warnings (for example only one tab found: the tabs touch each other).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def pieces(nv, edges, skip):
    """connected pieces over the vertices not in `skip`: an array of piece ids (-1 for skipped vertices)"""
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
        r = find(i)
        lab[i] = ids.setdefault(r, len(ids))
    return lab, len(ids)


def main():
    name = L.param("name")
    o = bpy.data.objects.get(name or "")
    if o is None or o.type != "MESH":
        raise RuntimeError(f"no mesh named {name}")
    v0 = K.verts(o).copy()
    nv = len(v0)
    top = float(v0[:, 2].max())
    band_mm = float(L.param("band_mm", 30))
    blend = float(L.param("blend_mm", 10)) / 1000.0
    zb = top - band_mm / 1000.0
    inband = v0[:, 2] >= zb
    if inband.sum() < 8:
        raise RuntimeError(f"fewer than 8 vertices in the top {band_mm:g} mm: raise band_mm")
    bsz = v0[inband].max(0) - v0[inband].min(0)
    sc, gm = L.param("scale"), L.param("grow_mm")
    if sc is not None and gm is not None:
        raise RuntimeError("give scale or grow_mm, not both")
    if gm is not None:
        if not (isinstance(gm, list) and len(gm) == 2):
            raise RuntimeError("grow_mm must be [dx, dy] in millimetres")
        sx, sy = (bsz[0] * 1000 + float(gm[0])) / (bsz[0] * 1000), (bsz[1] * 1000 + float(gm[1])) / (bsz[1] * 1000)
    elif sc is not None:
        sx, sy = (float(sc), float(sc)) if isinstance(sc, (int, float)) else (float(sc[0]), float(sc[1]))
    else:
        raise RuntimeError("scale or grow_mm is required")
    if sx <= 0.2 or sy <= 0.2 or sx > 5 or sy > 5:
        raise RuntimeError(f"scale {sx:.3f} x {sy:.3f} is outside 0.2 .. 5")
    about = L.param("about", "centre")
    if about == "centre":
        cx, cy = [float((v0[inband].max(0)[i] + v0[inband].min(0)[i]) / 2) for i in (0, 1)]
    elif isinstance(about, list) and len(about) == 2:
        cx, cy = float(about[0]), float(about[1])
    else:
        raise RuntimeError('about must be "centre" or [x, y] in metres')
    rotate = bool(L.param("rotate", True))

    def f(p):  # the band's own transform: x and y scaled about the axis, z kept
        q = p.copy()
        q[..., 0] = cx + (p[..., 0] - cx) * sx
        q[..., 1] = cy + (p[..., 1] - cy) * sy
        return q

    edges = np.array([e.vertices[:] for e in o.data.edges])
    lab, npc = pieces(nv, edges, inband)
    # a piece's attachment: the mean of its vertices that share an edge with the band
    touch = np.zeros(nv, bool)
    for a, b in edges:
        if inband[a] and not inband[b]:
            touch[b] = True
        elif inband[b] and not inband[a]:
            touch[a] = True
    att, hang = {}, []
    for k in range(npc):
        m = (lab == k) & touch
        if m.any():
            att[k] = v0[m].mean(0)
            hang.append(k)
    floating = [k for k in range(npc) if k not in att]
    cen = {k: v0[lab == k].mean(0) for k in range(npc)}
    owner = {k: k for k in hang}
    for k in floating:
        if hang:
            owner[k] = min(hang, key=lambda h: float(np.linalg.norm(cen[h] - cen[k])))
    v1 = v0.copy()
    v1[inband] = f(v0[inband])
    info = []
    for k in hang:
        a = att[k]
        fa = f(a)
        th = 0.0
        if rotate:
            th = float(np.arctan2(fa[1] - cy, fa[0] - cx) - np.arctan2(a[1] - cy, a[0] - cx))
            th = (th + np.pi) % (2 * np.pi) - np.pi
        c, s = np.cos(th), np.sin(th)
        R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
        for kk in [k] + [j for j in floating if owner.get(j) == k]:
            m = lab == kk
            rig = (v0[m] - a) @ R.T + fa
            w = np.clip(1 - (zb - v0[m][:, 2]) / blend, 0, 1)[:, None] if blend > 0 else np.zeros((m.sum(), 1))
            v1[m] = w * f(v0[m]) + (1 - w) * rig
        pv = v0[lab == k]
        info.append({"size_mm": [K.mm(x) for x in (pv.max(0) - pv.min(0))], "attachment_mm": [K.mm(x) for x in a], "move_mm": [K.mm(x) for x in (fa - a)], "turn_deg": round(float(np.degrees(th)), 1)})
    # what the rigid parts did to the tabs: sizes and edge lengths below the blend zone
    free = (lab >= 0) & (v0[:, 2] < zb - blend)
    tab_change, edge_change = 0.0, 0.0
    for k in hang:
        m = (lab == k) & free
        if m.sum() > 3:
            tab_change = max(tab_change, float(np.abs((v1[m].max(0) - v1[m].min(0)) - (v0[m].max(0) - v0[m].min(0))).max()))
    ee = edges[free[edges[:, 0]] & free[edges[:, 1]]]
    if len(ee):
        edge_change = float(np.abs(np.linalg.norm(v1[ee[:, 0]] - v1[ee[:, 1]], axis=1) - np.linalg.norm(v0[ee[:, 0]] - v0[ee[:, 1]], axis=1)).max())
    warnings = []
    if len(hang) == 1 and npc > 0:
        warnings.append("only one piece hangs from the band: the tabs touch each other or are one piece, so they move together")
    if not hang:
        warnings.append("nothing hangs below the band: only the band was scaled (raise band_mm lower than the part's height)")
    s0, s1 = K.size_of(v0), K.size_of(v1)
    bs1 = v1[inband].max(0) - v1[inband].min(0)
    dry = bool(L.param("dry_run", False))
    if not dry:
        K.set_verts(o, v1)
    out = {"name": o.name, "scale": [round(sx, 4), round(sy, 4)], "axis_xy_mm": [K.mm(cx), K.mm(cy)], "band": {"vertices": int(inband.sum()), "z_from_mm": K.mm(zb), "size_mm_before": [K.mm(x) for x in bsz], "size_mm_after": [K.mm(x) for x in bs1]},
           "tabs": {"count": len(hang), "pieces": info[:40]}, "floating_pieces": len(floating), "size_mm_before": [K.mm(x) for x in s0], "size_mm_after": [K.mm(x) for x in s1],
           "tab_size_change_mm": round(tab_change * 1000, 3), "max_edge_change_mm": round(edge_change * 1000, 3), "warnings": warnings, "dry_run": dry}
    L.finish(out, save=not dry)


L.run(main)
