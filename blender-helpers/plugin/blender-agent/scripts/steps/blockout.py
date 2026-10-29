"""blockout — build or edit a dimensioned BLOCKOUT of a space (a room, its floor, walls, a cabinet, furniture) as clean editable QUAD geometry, every piece labelled measured / estimated / inferred, with a topology report and clay pictures. Saves a checkpoint (not with dry_run).

The pieces are plain Blender objects in the collection `blockout` (named by you), built from `items`. Each keeps its own dimensions and label as custom properties (blockout_kind, blockout_status, blockout_note, blockout_dims), so a later call with the SAME name rebuilds just that piece from new numbers (every dimension stays editable by running the verb again), and nothing else in the scene is touched (reference objects, rigs and anything this verb did not make are never modified or deleted).
Colour tells the status in the clay pictures: measured = green, estimated = amber, inferred = grey-blue.
Frame: the scene's own world frame (for a video-to-3d reference: the shared reference frame, floor z = 0, +X left, +Y back, +Z up, in metres: see reference_import). `units` "m" (default) or "mm" for every number you give.

params:
  items     list of pieces; each: {"name": "floor", "kind": "box" | "plane" | "cylinder", "centre": [x, y, z], "status": "measured" | "estimated" | "inferred" (default "estimated"), "note": "free text: where the number came from", "group": optional label (stored), plus the shape:
              box:      "size": [sx, sy, sz]  and "cuts": [nx, ny, nz] (extra edge loops per axis, default [0, 0, 0]; every face stays a quad)
              plane:    "size": [sx, sy] (in the plane's own X and Y)  and "cuts": [nx, ny]; "normal": "+z" (default) | "-z" | "+x" | "-x" | "+y" | "-y" (the side it faces); a one-sided surface: floors, back-less walls
              cylinder: "radius", "height", "sides" (default 16; a multiple of 4 keeps quads), "cap": "ngon" (default; one n-gon per end) | "none"; axis "z" (default) | "x" | "y"
              blob:     a low-poly lumpy ellipsoid (a shrub, a canopy lump, a cushion): "size": [sx, sy, sz], "seed": 1 (the same seed gives the same shape), "lumps": 0.15 (how far each vertex may move in or out, a fraction of its radius), "detail": 2 (icosphere subdivisions: 1 = 12 vertices / 20 faces, 2 = 42 / 80, 3 = 162 / 320), "flat_bottom": true (flat base at the bottom of the size box)
              cluster:  "n" overlapping blobs (default 4) whose centres lie within the footprint ("spread" 0.55 = the central 55 %), all within "size": [sx, sy, sz]; same "seed", "lumps", "detail". The whole shape is SCALED (only ever smaller) to fit the declared "size" box and then shifted so that its lowest point sits on the bottom of the box ("flat_bottom": true, default; false centres it vertically); nothing is cut flat. "cut_flat": true cuts the top and bottom flat at the box faces, which makes the shells' flat faces COPLANAR so that they z-fight and render as black polygons: leave it off; one piece made of overlapping shells (not welded): a bush or a tree canopy
              tube:     a round tube swept along a curve: "path": [[x, y, z], ...] (points in the piece's own frame, relative to "centre"; the curve passes through every point: Catmull-Rom, "smooth": 6 samples per segment, 0 = the polyline), "radius" or "radii" (one per path point, interpolated: a taper), "sides" 12, "cap": "ngon" (default) | "none", "up": [0, 0, 1] (starting orientation of the section; no twist along the path). Chair legs, a curved back tube, a handle.
              sling:    a curved SHEET with thickness (a sling seat or back, a strap, a curved panel): "path" (the centreline, in the plane the sheet bends in), "width" or "widths" (per path point), "thickness" 0.006, "side": [1, 0, 0] (the direction of the width, default +X), "smooth" 6; the ends are closed (a closed thin solid).
              frame:    ONE continuous rectangular surround with a through opening: "size": [sx, sy, thickness] outside, "inner": [ix, iy] opening, "inner_offset": [dx, dy] (default centred); closed, all quads, "bevel_mm" rounds every edge (limited to just under half the thickness or rim width): a fire-pit top, a hatch rim
              ring:     a ring around the Z axis (rotate with rot_deg): "radius" (to the middle of the section), "tube_radius" + "tube_sides" 8 for a round section, or "width" (radial) + "thickness" (along the axis) for a flat one, "sides" 32 around: a swivel-base ring, a washer, a hoop.
              siding:   horizontal LAP-SIDING courses: "size": [width, height] of the wall (in its own X and Z, facing -Y, centred on "centre"), "course_height" (the pitch), "board_thickness" (bottom edge, default 0.019) / "top_thickness" (0.006): a lap wedge profile, "openings": [{"x0","x1","z0","z1"}] measured from the wall's lower-left corner (no board inside an opening; boards stop exactly at its edges; with "clip": "exact" (default) a course is split at the opening's top and bottom edges into PART-HEIGHT boards that keep the true lap relief, "clip": "course" = whole courses only, the hole follows the whole-course grid), "backing": true (a thin plate behind, openings left open). OR "from_mesh": an object name or a list (an existing planar wall: the courses follow its exact outline, steps and holes; built in WORLD coordinates: "centre": [0, 0, 0]), "z_origin", "outward": "-y" | "+y", "clip" (same meaning: part-height boards at the hole and step heights); the report's `siding_coverage` says how far the boards depart from the source outline.
              profile:  a rounded-OUTLINE solid extruded along X: "outline": [[y, z], ...] (closed polygon in the piece's frame, front = -Y), "corner_radius" (number or one per vertex), "round_segments" 6, "width" (the X extent at the FRONT; with "cap_round_mm" the rim of the two side caps is ROUNDED by that radius (mm, "cap_round_segments" 3) so a rail or case has no knife edge; with "crown_mm" the upward-facing stretch of the outline is made convex across the width ("crown_from": "edges_down" (default: the centre keeps the outline height, the side edges drop by crown_mm: the top envelope is kept) | "centre_up"), built with "width_segments" (default 8) columns; with "width_back" the X extent at the BACK, linear in between: a tapered rear): a speaker with a D-shaped side cap, any rounded wedge. "segment": [a, b] (fractions 0..1 of the rounded perimeter from the first outline point, in the outline's order) builds only a thin flush strip over that stretch instead ("thickness" 0.004 outside the surface, "inset" 0.01 margin at the sides): a grille or trim panel lying on the body piece of the same outline.
              wedge:    a ROUNDED wedge shell (a speaker, a wall light): "size": [width, depth, height] (the height at the BACK), "front_height" (lower: the top slopes down to the front, -Y), "radius" rounds every edge ("round_segments" 4), "grille": {"face": "front" | "top", "margin", "depth", "ribs", "rib_width"}: a recessed panel with horizontal ribs.
              lathe:    a REVOLVED shell around Z (feet on z = 0), smooth shaded: "size": [diameter, height] (built-in generic dome profile) or "profile": [[r, z], ...]; "lobes", "dimples", "feet", "sides" 120 (see docs/OPERATOR-VERBS.md, kind lathe)
              cushion:  an UPHOLSTERED cushion or throw pillow (no simulation): "size": [width X, depth Y, thickness Z]. A soft rounded SHOULDER where the top turns down into the side or seam ("round_mm" 35: the radius of that turn), a "crown" 0.4 (fraction of the height above the side that is a gentle dome in the middle), "pinch" 0.6 (corners pulled in and down: 0 = square corners, 1 = fully pinched), "corner_round" 0.35 (0 = square outline, 1 = oval), "boxing_mm" 0 (a vertical side strip of that height under the top; 0 = a pure pillow with a sharp seam), "side_bulge_mm" 3 (the boxed side bows out a little), "bottom": "domed" (default, symmetric pillow) | "flat" (a seat cushion: flat underside, "bottom_round_mm" 12 rounds its lower edge; then size Z runs from the underside to the top), "creases": [{"axis": "x" | "y", "at": 0.5, "depth_mm": 8, "width": 0.04}] (dents across the top, fading out towards the edge), "wrinkles": {"count": 8, "depth_mm": 2.5, "length": 0.16, "seed": 1} (shallow wrinkles running inward from the edges, more at the corners; the same seed gives the same ones), "piping_mm": 0 (a round cord of that diameter along the seam / top and bottom side edges, 10 typical), "segments" 28 (grid per side, denser near the edges), "nose_width_ratio" 1.0 (a saddle or tapered cushion: the plan narrows linearly to this fraction of the width at the end named by "nose": "+y" (default) | "-y"; the rounded corners follow). SMOOTH shaded by default (every other kind starts flat-shaded); `smooth_angle_deg` overrides. Give it fabric with texture_make `assign` (box UVs).
              every kind also takes "smooth_angle_deg": smooth shading BY ANGLE (faces smooth, edges sharper than that stay sharp: 30-40 rounds tubes, rings and bevels and keeps frame edges crisp) re-applied on every rebuild; geometry is never changed (see verb shade_smooth, which does the same on any existing mesh)
              box and cylinder also take "bevel_mm" (rounded edges: the bevel width, limited to just under half the smallest dimension) and "bevel_segments" (default 2); quads stay quads along the edges, corners get a few triangles
            "rot_deg": [rx, ry, rz] (degrees about the centre, default 0), "hide_faces": ["top", "bottom", "+x", "-x", "+y", "-y"] for a box (deletes those faces: an open box, a room with no ceiling), "mirror_x": true makes a second copy named <name>_mirror at -x.}
  remove    names of pieces this verb made to delete (it refuses any object without blockout_* properties)
  dry_run   true: nothing is built; the report says what would be created, replaced or refused (default false)
  units     "m" (default) | "mm"
  inspect   true (default): the topology of every piece and the total
  views     clay pictures: a list of "iso" | "top" | "front" | "side" | "back" | {"name", "dir": [x, y, z]} (default ["iso", "top"]); res px (default 720); `fit` "all" (default: every piece) | a list of names
Returns per piece: action (created / replaced / refused / would_create ...), status, dims, vertices, faces, quads, tris, ngons, non_manifold_edges, boundary_edges, loose_vertices, flipped (faces that point into the piece for a closed piece), bounds (m); totals; legend of the colours; pictures; notes.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector, Euler  # noqa: E402
import _lib as L  # noqa: E402
import kit2_modes as M  # noqa: E402

COLOURS = {"measured": (0.25, 0.70, 0.30, 1.0), "estimated": (0.90, 0.62, 0.15, 1.0), "inferred": (0.55, 0.62, 0.78, 1.0)}
FACE_AXES = {"+x": (0, 1), "-x": (0, -1), "+y": (1, 1), "-y": (1, -1), "+z": (2, 1), "top": (2, 1), "-z": (2, -1), "bottom": (2, -1)}


def mat_for(status):
    nm = f"blockout-{status}"
    m = bpy.data.materials.get(nm)
    if m is None:
        m = bpy.data.materials.new(nm)
        m.diffuse_color = COLOURS[status]
        m.use_nodes = True
        b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if b:
            b.inputs["Base Color"].default_value = COLOURS[status]
    return m


# ---------------------------------------------------------------- curved / repeated shapes (kinds tube, sling, ring, siding, wedge)
def _catmull(pts, per):
    """Catmull-Rom through the points (the curve passes through every one); `per` samples per segment (0 or 1: the polyline itself)"""
    P = [Vector(p) for p in pts]
    if per <= 1 or len(P) < 3:
        return P
    out = []
    ext = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for j in range(per):
            t = j / per
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t))
    out.append(P[-1])
    return out


def _frames(path, up):
    """tangents and a parallel-transported normal / binormal at every sample (no twist along the path)"""
    n = len(path)
    T = []
    for i in range(n):
        a = path[max(i - 1, 0)]
        b = path[min(i + 1, n - 1)]
        T.append((b - a).normalized())
    ref = Vector(up).normalized()
    N0 = ref - T[0] * ref.dot(T[0])
    if N0.length < 1e-6:
        N0 = Vector((1, 0, 0)) - T[0] * T[0].x
    N = [N0.normalized()]
    for i in range(1, n):
        v = N[-1] - T[i] * N[-1].dot(T[i])
        if v.length < 1e-6:
            v = N[-1]
        N.append(v.normalized())
    B = [T[i].cross(N[i]).normalized() for i in range(n)]
    return T, N, B


def _skin(bm, rings, closed_ring=True, closed_path=False):
    """quad faces between consecutive rings of equal length; returns the ring vertex lists"""
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    m = len(vs[0])
    pairs = list(zip(vs[:-1], vs[1:])) + ([(vs[-1], vs[0])] if closed_path else [])
    for a, b in pairs:
        for j in range(m if closed_ring else m - 1):
            k2 = (j + 1) % m
            bm.faces.new((a[j], a[k2], b[k2], b[j]))
    return vs


def mesh_tube(bm, it, k):
    pts = [[float(c) * k for c in p] for p in it["path"]]
    per = int(it.get("smooth", 6))
    path = _catmull(pts, per)
    r = it.get("radii")
    if r:
        rr = [float(x) * k for x in r]
        rad = []
        for i in range(len(path)):
            f = i / max(len(path) - 1, 1) * (len(rr) - 1)
            a = min(int(f), len(rr) - 2) if len(rr) > 1 else 0
            rad.append(rr[a] + (rr[min(a + 1, len(rr) - 1)] - rr[a]) * (f - a) if len(rr) > 1 else rr[0])
    else:
        rad = [float(it["radius"]) * k] * len(path)
    sides = int(it.get("sides", 12))
    T, N, B = _frames(path, it.get("up", [0, 0, 1]))
    rings = [[path[i] + (N[i] * math.cos(2 * math.pi * j / sides) + B[i] * math.sin(2 * math.pi * j / sides)) * rad[i] for j in range(sides)] for i in range(len(path))]
    vs = _skin(bm, rings)
    if it.get("cap", "ngon") == "ngon":
        bm.faces.new(vs[0][::-1])
        bm.faces.new(vs[-1])


def mesh_sling(bm, it, k):
    """a curved SHEET with thickness (a seat/back sling, a strap, a curved panel): the centreline `path` (in the piece's own frame) is swept with a rectangle `width` (along `side`, default +X) x `thickness` (along the path's normal)"""
    pts = [[float(c) * k for c in p] for p in it["path"]]
    path = _catmull(pts, int(it.get("smooth", 6)))
    side = Vector(it.get("side", [1, 0, 0])).normalized()
    w = it.get("widths")
    if w:
        ww = [float(x) * k for x in w]
        wid = [ww[min(int(i / max(len(path) - 1, 1) * (len(ww) - 1) + 0.5), len(ww) - 1)] for i in range(len(path))]
        if len(ww) > 1:
            wid = []
            for i in range(len(path)):
                f = i / max(len(path) - 1, 1) * (len(ww) - 1)
                a = min(int(f), len(ww) - 2)
                wid.append(ww[a] + (ww[a + 1] - ww[a]) * (f - a))
    else:
        wid = [float(it["width"]) * k] * len(path)
    th = float(it.get("thickness", 0.006)) * k
    rings = []
    for i, c in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        n = t.cross(side)
        if n.length < 1e-6:
            n = Vector((0, 0, 1))
        n = n.normalized()
        s_ = (side - t * side.dot(t)).normalized()  # the width direction stays perpendicular to the path
        rings.append([c + s_ * wid[i] / 2 + n * th / 2, c - s_ * wid[i] / 2 + n * th / 2, c - s_ * wid[i] / 2 - n * th / 2, c + s_ * wid[i] / 2 - n * th / 2])
    vs = _skin(bm, rings)
    bm.faces.new(vs[0][::-1])
    bm.faces.new(vs[-1])


def mesh_ring(bm, it, k):
    """a ring (a swivel-base ring, a washer, a hoop): round tube section (`tube_radius`) or a flat rectangular section (`width` radial x `thickness` along the axis)"""
    R = float(it["radius"]) * k
    seg = int(it.get("sides", 32))
    if "tube_radius" in it:
        r = float(it["tube_radius"]) * k
        ts = int(it.get("tube_sides", 8))
        sec = [(R + r * math.cos(2 * math.pi * j / ts), r * math.sin(2 * math.pi * j / ts)) for j in range(ts)]
    else:
        w, t = float(it["width"]) * k / 2, float(it["thickness"]) * k / 2
        sec = [(R + w, t), (R - w, t), (R - w, -t), (R + w, -t)]
    rings = [[(rr * math.cos(2 * math.pi * i / seg), rr * math.sin(2 * math.pi * i / seg), z) for rr, z in sec] for i in range(seg)]
    _skin(bm, rings, closed_path=True)


def mesh_frame(bm, it, k):
    """a continuous rectangular FRAME with a through opening (a fire-pit surround, a picture frame, a hatch rim): ONE closed solid, `size` [sx, sy, thickness] outside, `inner` [ix, iy] opening (through the thickness), `inner_offset` [dx, dy] moves the opening off-centre (default 0). Every face is a quad; use `bevel_mm` for the edges."""
    sx, sy, sz = [float(x) * k for x in it["size"]]
    ix, iy = [float(x) * k for x in it["inner"]]
    dx, dy = [float(x) * k for x in it.get("inner_offset", [0, 0])]
    if ix + 2 * abs(dx) >= sx or iy + 2 * abs(dy) >= sy:
        raise RuntimeError(f"{it.get('name')}: the opening [{ix}, {iy}] (offset [{dx}, {dy}]) does not fit inside the outside [{sx}, {sy}]")
    h = sz / 2
    def loop(w, d, cx, cy, z):
        return [bm.verts.new((cx + a * w / 2, cy + b * d / 2, z)) for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    ot, ob = loop(sx, sy, 0, 0, h), loop(sx, sy, 0, 0, -h)
    it_, ib = loop(ix, iy, dx, dy, h), loop(ix, iy, dx, dy, -h)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((ob[i], ob[j], ot[j], ot[i]))      # outer wall
        bm.faces.new((it_[i], it_[j], ib[j], ib[i]))    # opening wall
        bm.faces.new((ot[i], ot[j], it_[j], it_[i]))    # top
        bm.faces.new((ib[i], ib[j], ob[j], ob[i]))      # underside


def _lap_prism(bm, xa, xb, z0, z1, ca, cb, y0, sign, tb, tt):
    """one lap board segment x [xa, xb], z [z0, z1] cut out of the course [ca, cb]: the lap thickness follows the course (thick at its bottom, thin at its top), so a part-height piece keeps the true relief"""
    def th(z):
        return tb + (tt - tb) * (z - ca) / (cb - ca)
    prof = [(0.0, z0), (sign * th(z0), z0), (sign * th(z1), z1), (0.0, z1)]
    a = [bm.verts.new((xa, y0 + y, z)) for y, z in prof]
    b = [bm.verts.new((xb, y0 + y, z)) for y, z in prof]
    for j in range(4):
        j2 = (j + 1) % 4
        bm.faces.new((a[j], b[j], b[j2], a[j2]))
    bm.faces.new(a[::-1])
    bm.faces.new(b)


def _bands(za, zb, zcuts, same, tol=1e-6):
    """split the course [za, zb] at the heights in zcuts where the covered x intervals change: `same(zlo, zhi)` tells whether the intervals at two heights are the same; returns [(z0, z1)] with equal neighbours merged"""
    zs = sorted({round(z, 6) for z in zcuts if za + tol < z < zb - tol} | {za, zb})
    bands = [[zs[i], zs[i + 1]] for i in range(len(zs) - 1)]
    out = []
    for b in bands:
        if out and same((out[-1][0] + out[-1][1]) / 2, (b[0] + b[1]) / 2):
            out[-1][1] = b[1]
        else:
            out.append(b)
    return out


def mesh_siding_from_mesh(bm, it, k):
    """lap courses laid ON an existing planar wall mesh, keeping its exact outline and holes: `from_mesh` (an object name or a list: the wall pieces, e.g. "Wall_main"), `course_height` (the pitch, e.g. 0.1154), `z_origin` (where course 0 starts; default the lowest z of the mesh), `outward` "-y" (default) | "+y": the side the boards stand out to, `board_thickness` / `top_thickness` as for the plain siding. The courses are cut where the mesh has no surface at the course's mid height (a board spans the x intervals the mesh covers there: a hole or a step edge is followed in x exactly and quantised to the course grid in z). Built in WORLD coordinates (give "centre": [0, 0, 0]). The report's `siding_coverage` compares the boards' area with the source surface's area."""
    names = it["from_mesh"] if isinstance(it["from_mesh"], list) else [it["from_mesh"]]
    tris = []
    for nm in names:
        o = bpy.data.objects[nm]
        me = o.data
        me.calc_loop_triangles()
        for t in me.loop_triangles:
            tris.append([o.matrix_world @ me.vertices[v].co for v in t.vertices])
    ys = [p.y for tr in tris for p in tr]
    y0 = sum(ys) / len(ys)
    sign = -1.0 if str(it.get("outward", "-y")) == "-y" else 1.0
    pitch = float(it["course_height"]) * k
    tb = float(it.get("board_thickness", 0.019)) * k
    tt = float(it.get("top_thickness", 0.006)) * k
    zs = [p.z for tr in tris for p in tr]
    zlo, zhi = min(zs), max(zs)
    zo = float(it["z_origin"]) * k if "z_origin" in it else zlo
    c0 = int(math.floor((zlo - zo) / pitch + 1e-9))
    c1 = int(math.ceil((zhi - zo) / pitch - 1e-9))
    def intervals_at(zm):
        iv = []
        for tr in tris:
            xs_ = []
            for a, b in ((0, 1), (1, 2), (2, 0)):
                p, q = tr[a], tr[b]
                if (p.z - zm) * (q.z - zm) < 0:
                    xs_.append(p.x + (q.x - p.x) * (zm - p.z) / (q.z - p.z))
                elif abs(p.z - zm) < 1e-12 and abs(q.z - zm) < 1e-12:
                    xs_ += [p.x, q.x]
            if len(xs_) >= 2:
                iv.append((min(xs_), max(xs_)))
        iv.sort()
        merged = []
        for a, b in iv:
            if merged and a <= merged[-1][1] + 1e-4:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        return [(a, b) for a, b in merged if b - a >= 0.02]

    exact = str(it.get("clip", "exact")) == "exact"
    zv = sorted({round(p.z, 6) for tr in tris for p in tr})
    area_new = 0.0
    board_iv = {}  # course -> [(z0, z1, intervals)]
    for c in range(c0, c1):
        za, zb = zo + c * pitch, zo + (c + 1) * pitch
        def eq(zl, zh):
            A, B = intervals_at(zl), intervals_at(zh)
            return len(A) == len(B) and all(abs(a1 - b1) < 1e-4 and abs(a2 - b2) < 1e-4 for (a1, a2), (b1, b2) in zip(A, B))
        bands = _bands(za, zb, zv, eq) if exact else [[za, zb]]
        board_iv[c] = []
        for z0, z1 in bands:
            ivs = intervals_at((za + zb) / 2 if not exact else (z0 + z1) / 2)
            board_iv[c].append((z0, z1, ivs))
            for xa, xb in ivs:
                _lap_prism(bm, xa, xb, z0, z1, za, zb, y0, sign, tb, tt)
                area_new += (xb - xa) * (z1 - z0)
    # how far the boards depart from the source outline: the source's covered length against the boards' at 8 heights per course
    src_area = mism = 0.0
    for c in range(c0, c1):
        for q in range(8):
            z = zo + (c + (q + 0.5) / 8) * pitch
            si = intervals_at(z)
            sl = sum(b - a for a, b in si)
            bi = next((iv for z0_, z1_, iv in board_iv[c] if z0_ - 1e-9 <= z <= z1_ + 1e-9), [])
            bl = sum(b - a for a, b in bi)
            # symmetric difference of the two interval sets
            pts = sorted({x for a, b in si + bi for x in (a, b)})
            diff = 0.0
            for x0_, x1_ in zip(pts[:-1], pts[1:]):
                xm = (x0_ + x1_) / 2
                in_s = any(a <= xm <= b for a, b in si)
                in_b = any(a <= xm <= b for a, b in bi)
                if in_s != in_b:
                    diff += x1_ - x0_
            src_area += sl * pitch / 8
            mism += diff * pitch / 8
    area_src = src_area
    it["_siding_coverage"] = {"source_surface_area_m2": round(area_src / (k * k), 3), "boards_front_area_m2": round(area_new / (k * k), 3), "outline_mismatch_area_m2": round(mism / (k * k), 4), "clip": "exact" if exact else "course",
                              "mismatch_percent_of_source": round(100 * mism / area_src, 2) if area_src else None, "courses": c1 - c0, "note": "source surface = the union of the wall pieces seen from the front (sampled), mismatch = where the boards' cover and the source's cover differ (the z quantisation of holes and steps to the course grid)"}


def mesh_siding(bm, it, k):
    """horizontal lap-siding COURSES on a wall rectangle: `size` [width, height] in the wall's own X / Z (the wall lies in the XZ plane, facing -Y; use rot_deg to turn it), `course_height` (the pitch, e.g. 0.14), `board_thickness` bottom edge (default 0.019), `top_thickness` (default 0.006), `openings` [{x0, x1, z0, z1}] measured from the wall's lower left corner: no board is made inside an opening, boards stop exactly at its edges; `backing`: true adds a thin back plate. The pieces are closed prisms (one per board segment)."""
    if it.get("from_mesh"):
        return mesh_siding_from_mesh(bm, it, k)
    W, H = [float(x) * k for x in it["size"]]
    pitch = float(it["course_height"]) * k
    tb = float(it.get("board_thickness", 0.019)) * k
    tt = float(it.get("top_thickness", 0.006)) * k
    gap = float(it.get("shadow_gap", 0.0)) * k
    ops = [(float(o["x0"]) * k, float(o["x1"]) * k, float(o["z0"]) * k, float(o["z1"]) * k) for o in it.get("openings", [])]
    n = int(math.ceil(H / pitch - 1e-9))
    exact = str(it.get("clip", "exact")) == "exact"

    def segs_at(zm):
        cut = [(max(0.0, o[0]), min(W, o[1])) for o in ops if o[2] < zm < o[3]]
        segs, x = [], 0.0
        for a_, b_ in sorted(cut):
            if a_ > x + 1e-6:
                segs.append((x, a_))
            x = max(x, b_)
        if x < W - 1e-6:
            segs.append((x, W))
        return [(xa, xb) for xa, xb in segs if xb - xa >= 1e-6]
    zcuts = [o[2] for o in ops] + [o[3] for o in ops]
    for c in range(n):
        z0, z1 = c * pitch, min((c + 1) * pitch, H)
        if z1 - z0 < 1e-6:
            continue
        if exact:  # a board stops AT the opening's top / bottom edge inside the course (a part-height board), not at the course boundary
            bands = _bands(z0, z1, zcuts, lambda zl, zh: segs_at(zl) == segs_at(zh))
        else:
            bands = [[z0, z1]]
        for bz0, bz1 in bands:
            zt = min(bz1, z1 - gap) if gap else bz1
            if zt - bz0 < 1e-6:
                continue
            zm = (bz0 + bz1) / 2
            for xa, xb in (segs_at(zm) if exact else segs_at((z0 + z1) / 2)):
                _lap_prism(bm, xa, xb, bz0, zt, z0, z1, 0.0, -1.0, tb, tt)
    if it.get("backing", False):  # a thin plate behind the boards, with the openings left open (slabs between the openings' x edges)
        bt = float(it.get("backing_thickness", 0.01)) * k
        xs = sorted({0.0, W} | {min(W, max(0.0, o[0])) for o in ops} | {min(W, max(0.0, o[1])) for o in ops})
        for xa, xb in zip(xs[:-1], xs[1:]):
            if xb - xa < 1e-6:
                continue
            zc = sorted((max(0.0, o[2]), min(H, o[3])) for o in ops if o[0] < xb - 1e-9 and o[1] > xa + 1e-9)
            z, spans = 0.0, []
            for a, b in zc:
                if a > z + 1e-6:
                    spans.append((z, a))
                z = max(z, b)
            if z < H - 1e-6:
                spans.append((z, H))
            for za, zb in spans:
                v = [bm.verts.new(p) for p in ((xa, 0, za), (xb, 0, za), (xb, bt, za), (xa, bt, za), (xa, 0, zb), (xb, 0, zb), (xb, bt, zb), (xa, bt, zb))]
                for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
                    bm.faces.new([v[i] for i in f])
    off = Vector((-W / 2, 0, -H / 2))  # the wall is centred on its `centre`
    for v in bm.verts:
        v.co += off


def mesh_wedge(bm, it, k):
    """a ROUNDED wedge shell (a speaker, a wall light, a wedge cabinet): `size` [width, depth, height] at the BACK, `front_height` (the height at the front edge, default = height: a plain box; smaller: the top slopes down), the front is toward -Y; `radius` rounds every edge (bevel, `round_segments` default 4); `grille`: {"face": "front" (default) | "top", "margin": 0.02, "depth": 0.008, "ribs": 12, "rib_width": 0.004} cuts a recessed panel into that face and adds horizontal ribs across it."""
    sx, sy, sz = [float(x) * k for x in it["size"]]
    fh = float(it.get("front_height", it["size"][2])) * k
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
        if v.co.y < 0 and v.co.z > 0:  # the front top edge comes down
            v.co.z = -sz / 2 + fh
    rad = float(it.get("radius", 0.0)) * k
    gr = it.get("grille")
    if gr:
        m = float(gr.get("margin", 0.02)) * k
        dep = float(gr.get("depth", 0.008)) * k
        bm.faces.ensure_lookup_table()
        face = "top" if gr.get("face") == "top" else "front"
        tgt = max(bm.faces, key=lambda f: f.normal.z) if face == "top" else min(bm.faces, key=lambda f: f.normal.y)
        res = bmesh.ops.inset_region(bm, faces=[tgt], thickness=m, depth=0.0)
        inner = [f for f in res["faces"]] if res.get("faces") else [tgt]
        inn = tgt
        bmesh.ops.translate(bm, vec=(-inn.normal * dep), verts=list(inn.verts))
    if rad > 0:
        lim = min(sx, sy, sz) / 2.05
        edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > 0.5 and not (gr and any(v in tgt.verts for v in e.verts))]
        bmesh.ops.bevel(bm, geom=edges, offset=min(rad, lim), segments=int(it.get("round_segments", 4)), profile=0.5, affect="EDGES")
    if gr and int(gr.get("ribs", 0)) > 0:
        nr = int(gr["ribs"])
        rw = float(gr.get("rib_width", 0.004)) * k
        m = float(gr.get("margin", 0.02)) * k
        zs = [v.co.z for v in tgt.verts]
        xs = [v.co.x for v in tgt.verts]
        if gr.get("face") == "top":
            pass
        ymin = min(v.co.y for v in tgt.verts)
        zlo, zhi = min(zs), max(zs)
        for i in range(nr):
            zc = zlo + (zhi - zlo) * (i + 0.5) / nr
            x0, x1 = min(xs), max(xs)
            v = [bm.verts.new((x, y, z)) for x, y, z in ((x0, ymin, zc - rw / 2), (x1, ymin, zc - rw / 2), (x1, ymin, zc + rw / 2), (x0, ymin, zc + rw / 2),
                                                          (x0, ymin - rw, zc - rw / 2), (x1, ymin - rw, zc - rw / 2), (x1, ymin - rw, zc + rw / 2), (x0, ymin - rw, zc + rw / 2))]
            for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
                bm.faces.new([v[i] for i in f])



def _fillet_outline(poly, radius, seg):
    """a closed 2D polygon [(y, z), ...] with every corner rounded by an arc of `radius` (a number or one per vertex; clipped so neighbouring arcs never overlap), `seg` samples per arc"""
    n = len(poly)
    rad = list(radius) if isinstance(radius, (list, tuple)) else [radius] * n
    out = []
    for i in range(n):
        c = Vector(poly[i])
        a, b = Vector(poly[i - 1]), Vector(poly[(i + 1) % n])
        v1, v2 = a - c, b - c
        l1, l2 = v1.length, v2.length
        v1.normalize()
        v2.normalize()
        r = float(rad[i])
        ang = math.acos(max(-1.0, min(1.0, v1.dot(v2))))
        if r <= 1e-9 or ang < 1e-3 or ang > math.pi - 1e-3:
            out.append((c.x, c.y))
            continue
        t = r / math.tan(ang / 2)
        tmax = 0.5 * min(l1, l2)
        if t > tmax:
            r *= tmax / t
            t = tmax
        o = c + (v1 + v2).normalized() * (r / math.sin(ang / 2))
        a1 = math.atan2((c + v1 * t - o).y, (c + v1 * t - o).x)
        a2 = math.atan2((c + v2 * t - o).y, (c + v2 * t - o).x)
        d = a2 - a1
        while d > math.pi:
            d -= 2 * math.pi
        while d < -math.pi:
            d += 2 * math.pi
        for j in range(seg + 1):
            q = a1 + d * j / seg
            out.append((o.x + r * math.cos(q), o.y + r * math.sin(q)))
    return out


# Default lathe silhouette, defined by a formula (a generic dome): [radius / (diameter/2), height / total height], bottom centre to top
# centre. A flat base disc of radius 0.5, a rounded shoulder out to the full radius at 40 % of the height, then an elliptical top.
def _dome_profile(shoulder_steps=6, top_steps=8):
    pts = [(0.0, 0.0), (0.5, 0.0)]
    for i in range(1, shoulder_steps + 1):
        a = (math.pi / 2) * i / shoulder_steps
        pts.append((0.5 + 0.5 * math.sin(a), 0.4 * (1 - math.cos(a))))
    for i in range(1, top_steps + 1):
        a = (math.pi / 2) * i / top_steps
        pts.append((math.cos(a), 0.4 + 0.6 * math.sin(a)))
    return [(round(r, 4), round(z, 4)) for r, z in pts]


LATHE_DEFAULT_PROFILE = _dome_profile()


def _smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _bell(d, half, edge=1.0):
    """0 at |d| = half rising to 1 at the middle; `edge` is the fraction of the half-width the wall takes (1 = a smooth bell, 0.3 = a flat floor with a defined edge)"""
    return _smoothstep((1.0 - abs(d) / half) / edge) if half > 0 else 0.0


def mesh_lathe(bm, it, k):
    """a REVOLVED shell around the Z axis (feet on z = 0): `profile` [[r, z], ...] bottom centre to top centre (m), or `size` [diameter, height] with the built-in generic dome profile; optional lobes (recessed teardrops on the side), dimples (oval dents on the top) and notched feet (arches in the lower edge)"""
    prof = it.get("profile")
    if prof:
        pts = [(float(r) * k, float(z) * k) for r, z in prof]
    else:
        D, H = (float(x) * k for x in it["size"])
        pts = [(r * D / 2, z * H) for r, z in LATHE_DEFAULT_PROFILE]
    zmax = max(z for _, z in pts)
    # resample by arc length so the rows are even and dents have vertices to move
    step = float(it.get("step_mm", 12)) * 0.001
    rows = [pts[0]]
    for (r0, z0), (r1, z1) in zip(pts, pts[1:]):
        n = max(1, int(math.ceil(math.hypot(r1 - r0, z1 - z0) / step)))
        rows += [(r0 + (r1 - r0) * i / n, z0 + (z1 - z0) * i / n) for i in range(1, n + 1)]
    # soften corners: two passes of a 3-point average on the interior rows (the ends stay)
    for _ in range(int(it.get("soften", 1))):
        rows = [rows[0]] + [((rows[i - 1][0] + 2 * rows[i][0] + rows[i + 1][0]) / 4, (rows[i - 1][1] + 2 * rows[i][1] + rows[i + 1][1]) / 4) for i in range(1, len(rows) - 1)] + [rows[-1]]
    top_r = max(r for r, _ in pts)
    got = max(r for r, _ in rows)
    if got > 0:
        rows = [(r * top_r / got, z) for r, z in rows]  # smoothing shaves the widest radius: put it back, so the width is exactly the one asked for
    N = int(it.get("sides", 120))
    lobes, dimples, feet = it.get("lobes"), it.get("dimples"), it.get("feet")
    rmax = max(r for r, _ in rows)

    def point(i, j):
        r, z = rows[j]
        a = 2 * math.pi * i / N
        if lobes and 0 < r:
            cnt = int(lobes.get("count", 8))
            z0, z1 = (float(x) for x in lobes.get("z", [0.3, 0.75]))
            t = (z / zmax - z0) / (z1 - z0)  # 0 at the bottom of the lobe, 1 at its top
            if 0 < t < 1:
                da = (a - math.radians(float(lobes.get("phase_deg", 0))) + math.pi / cnt) % (2 * math.pi / cnt) - math.pi / cnt
                half = math.radians(float(lobes.get("width_deg", 30))) / 2 * (1 - (1 - float(lobes.get("top_width", 0.4))) * t)  # teardrop: wide at the bottom, narrow at the top
                r -= float(lobes.get("depth_mm", 14)) * 0.001 * k * _bell(da, half, float(lobes.get("edge", 0.3))) * _smoothstep(t / 0.2) * _smoothstep((1 - t) / 0.45)
        if dimples and z > zmax * 0.97:
            cnt = int(dimples.get("count", 8))
            rc = float(dimples.get("r", 0.55)) * rmax
            half_len = float(dimples.get("length", 0.28)) * rmax / 2
            half_w = float(dimples.get("width", 0.2)) * rmax / 2
            da = (a - math.radians(float(dimples.get("phase_deg", 0))) + math.pi / cnt) % (2 * math.pi / cnt) - math.pi / cnt
            # the dent's own frame: u along the radius from its centre, v across it (arc length at radius rc)
            u, v = r - rc, da * rc
            d = math.hypot(u / half_len, v / half_w)
            z -= float(dimples.get("depth_mm", 4)) * 0.001 * k * _smoothstep(1 - d)
        if feet:
            cnt = int(feet.get("count", 3))
            hf = float(feet.get("height_frac", 0.3)) * zmax
            if z < hf and r > float(feet.get("r0", 0.45)) * rmax:
                da = (a - math.radians(float(feet.get("phase_deg", 0))) + math.pi / cnt) % (2 * math.pi / cnt) - math.pi / cnt
                half = math.radians(float(feet.get("width_deg", 26))) / 2
                n = _bell(da, half, float(feet.get("edge", 0.35))) ** 0.5  # a rounded arch
                w = _smoothstep((r - float(feet.get("r0", 0.45)) * rmax) / (0.25 * rmax))
                s_ = n * w
                z = hf * s_ + z * (1 - s_)  # the lower rows are squeezed up into the arch
        return (r * math.cos(a), r * math.sin(a), z)

    top = len(rows) - 1
    grid = []
    for i in range(N):
        grid.append([None if (rows[j][0] <= 1e-9) else bm.verts.new(point(i, j)) for j in range(len(rows))])
    poles = {j: bm.verts.new((0.0, 0.0, rows[j][1])) for j in range(len(rows)) if rows[j][0] <= 1e-9}
    def V(i, j):
        return poles[j] if j in poles else grid[i % N][j]
    for i in range(N):
        for j in range(len(rows) - 1):
            a, b, c, d = V(i, j), V(i + 1, j), V(i + 1, j + 1), V(i, j + 1)
            vs = list(dict.fromkeys([a, b, c, d]))
            if len(vs) >= 3:
                try:
                    bm.faces.new(vs)
                except ValueError:
                    pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def mesh_cushion(bm, it, k):
    """an UPHOLSTERED CUSHION / pillow: soft rounded shoulders where the top meets the side or seam, a crown, pinched corners, optional boxed side strip, shallow creases, edge wrinkles and piping. `size` [width (X), depth (Y), thickness (Z)]; no simulation."""
    import random
    w, d, t = [float(x) * k for x in it["size"]]
    n = max(8, int(it.get("segments", 28)))
    box = min(float(it.get("boxing_mm", 0.0)) * 0.001, t * 0.85)
    R = max(1e-4, float(it.get("round_mm", 35.0)) * 0.001)
    crown = max(0.0, min(1.0, float(it.get("crown", 0.4))))
    pinch = max(0.0, min(1.0, float(it.get("pinch", 0.6))))
    cr = max(0.0, min(1.0, float(it.get("corner_round", 0.35))))
    flat_bottom = it.get("bottom", "domed") == "flat"
    Rb = min(float(it.get("bottom_round_mm", 12.0)) * 0.001, box * 0.4) if flat_bottom else 0.0
    bulge = float(it.get("side_bulge_mm", 3.0)) * 0.001
    cre = it.get("creases") or []
    wr = it.get("wrinkles")
    top_rim = (-t / 2 + box) if flat_bottom else box / 2
    amp = max(0.0, t / 2 - top_rim)
    crown_h = crown * amp
    sh = amp - crown_h
    bot_rim = (-t / 2 + Rb) if flat_bottom else -box / 2
    ramp = 0.0 if flat_bottom else (t / 2 - box / 2)

    nose = float(it.get("nose_width_ratio", 1.0))  # a saddle: the plan narrows linearly to this fraction of the width at the `nose` end
    nose_y = -1.0 if it.get("nose", "+y") == "-y" else 1.0
    if not 0.05 <= nose <= 1.0:
        raise RuntimeError(f"{it.get('name')}: nose_width_ratio must be between 0.05 and 1")

    def tw(v):
        f = v if nose_y > 0 else 1 - v
        return 1.0 - (1.0 - nose) * f

    def XY0(u, v):
        px, py = 2 * u - 1, 2 * v - 1
        m, ln = max(abs(px), abs(py)), math.hypot(px, py)
        sc = 1.0 + cr * (m / ln - 1.0) if ln > 1e-9 else 1.0
        return px * sc * w / 2 * tw(v), py * sc * d / 2

    # with a nose the rounded rear corners would pull the widest point in from `width`: scale x so the widest point is exactly `width` (a plain cushion is unchanged)
    fx = 1.0
    if nose < 1.0:
        fx = (w / 2) / max(abs(XY0(i / 64, j / 64)[0]) for i in range(65) for j in range(65))

    def XY(u, v):
        x, y = XY0(u, v)
        return x * fx, y

    def edge(u, v):
        du, dv = min(u, 1 - u) * w * tw(v), min(v, 1 - v) * d
        if du < 1e-9 or dv < 1e-9:
            return 0.0
        return (1 - pinch) * min(du, dv) + pinch / math.sqrt(1 / du ** 2 + 1 / dv ** 2)

    rng = random.Random(int((wr or {}).get("seed", 1)))
    wrinkles = []
    if wr:
        for q in range(int(wr.get("count", 8))):
            side = rng.randrange(4)
            f = rng.random()
            f = f * 0.3 if rng.random() < 0.5 else 1 - f * 0.3 if rng.random() < 0.5 else f  # biased towards the corners
            ang = math.radians((rng.random() * 2 - 1) * 28)
            if side == 0:
                p0, dr = Vector((-w / 2 + f * w, -d / 2)), Vector((math.sin(ang), math.cos(ang)))
            elif side == 1:
                p0, dr = Vector((-w / 2 + f * w, d / 2)), Vector((math.sin(ang), -math.cos(ang)))
            elif side == 2:
                p0, dr = Vector((-w / 2, -d / 2 + f * d)), Vector((math.cos(ang), math.sin(ang)))
            else:
                p0, dr = Vector((w / 2, -d / 2 + f * d)), Vector((-math.cos(ang), math.sin(ang)))
            wrinkles.append((p0, dr, float(wr.get("length", 0.16)) * (0.6 + 0.8 * rng.random()), (0.5 + rng.random()) * float(wr.get("depth_mm", 2.5)) * 0.001, 0.010 + 0.008 * rng.random()))

    def dents(u, v, x, y, e):
        dz = 0.0
        fade = min(1.0, e / 0.03)
        for c in cre:
            q = u if c.get("axis", "x") == "x" else v
            dz += float(c.get("depth_mm", 8)) * 0.001 * math.exp(-((q - float(c.get("at", 0.5))) / max(1e-3, float(c.get("width", 0.04)))) ** 2) * fade
        for p0, dr, ln, dep, wid in wrinkles:
            rx, ry = x - p0.x, y - p0.y
            al = rx * dr.x + ry * dr.y
            if al > 0:
                pe = rx * dr.y - ry * dr.x
                dz += dep * math.exp(-(pe / wid) ** 2) * math.exp(-(al / ln) ** 2) * fade
        return dz

    top, bot = [], []
    for j in range(n + 1):
        v = 0.5 - 0.5 * math.cos(math.pi * j / n)  # cosine spacing: more rows near the edges, where the shape turns
        for i in range(n + 1):
            u = 0.5 - 0.5 * math.cos(math.pi * i / n)
            x, y = XY(u, v)
            e = edge(u, v)
            C = (4 * u * (1 - u) * 4 * v * (1 - v)) ** 0.5
            sT = math.sin(math.pi / 2 * min(1.0, e / R))
            top.append(bm.verts.new((x, y, top_rim + sh * sT + crown_h * C - dents(u, v, x, y, e))))
            if flat_bottom:
                zb = -t / 2 + Rb * (1 - math.sin(math.pi / 2 * min(1.0, e / Rb))) if Rb > 1e-6 else -t / 2
            else:
                zb = -(box / 2 + (t / 2 - box / 2) * (math.sin(math.pi / 2 * min(1.0, e / R)) * (1 - crown) + crown * C))
            bot.append(bm.verts.new((x, y, zb)))
    idx = lambda i, j: j * (n + 1) + i
    for j in range(n):
        for i in range(n):
            a, b2, c2, d2 = idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)
            bm.faces.new((top[a], top[b2], top[c2], top[d2])).smooth = True
            bm.faces.new((bot[d2], bot[c2], bot[b2], bot[a])).smooth = True
    ring = [(i, 0) for i in range(n + 1)] + [(n, j) for j in range(1, n + 1)] + [(i, n) for i in range(n - 1, -1, -1)] + [(0, j) for j in range(n - 1, 0, -1)]
    tv = [top[idx(*q)] for q in ring]
    bv = [bot[idx(*q)] for q in ring]
    pts = [v.co.copy() for v in tv]

    def outward(q):
        tg = pts[(q + 1) % len(pts)] - pts[q - 1]
        tg.z = 0
        tg.normalize()
        nr = Vector((tg.y, -tg.x, 0.0))
        return -nr if nr.dot(Vector((pts[q].x, pts[q].y, 0))) < 0 else nr

    rows = [tv]
    gap = (tv[0].co.z - bv[0].co.z) > 1e-6 or any(abs(a.co.z - b3.co.z) > 1e-6 for a, b3 in zip(tv, bv))
    if gap:
        nrows = 4
        for r in range(1, nrows):
            sfrac = r / nrows
            rows.append([bm.verts.new(Vector((tv[q].co.x, tv[q].co.y, tv[q].co.z + (bv[q].co.z - tv[q].co.z) * sfrac)) + outward(q) * (bulge * math.sin(math.pi * sfrac)))
                         for q in range(len(tv))])
    rows.append(bv)
    for r in range(len(rows) - 1):
        for q in range(len(ring)):
            q2 = (q + 1) % len(ring)
            bm.faces.new((rows[r][q], rows[r][q2], rows[r + 1][q2], rows[r + 1][q])).smooth = True
    pr = float(it.get("piping_mm", 0.0)) * 0.0005
    if pr > 0:
        ps = 8
        for lp in ([tv, bv] if gap else [tv]):
            rings = []
            for q in range(len(lp)):
                nrm = outward(q)
                c0 = lp[q].co
                rings.append([bm.verts.new(c0 + pr * (math.cos(2 * math.pi * s_ / ps) * nrm + math.sin(2 * math.pi * s_ / ps) * Vector((0, 0, 1)))) for s_ in range(ps)])
            for q in range(len(rings)):
                r0, r1 = rings[q], rings[(q + 1) % len(rings)]
                for s_ in range(ps):
                    bm.faces.new((r0[s_], r0[(s_ + 1) % ps], r1[(s_ + 1) % ps], r1[s_])).smooth = True
    if not gap:
        bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if abs(v.co.z) < 1e-7], dist=1e-6)


def mesh_profile(bm, it, k):
    """a rounded-OUTLINE solid (a speaker with a D-shaped side cap, a bracket, a rounded wedge of any profile): the closed 2D `outline` [[y, z], ...] (the piece's own frame, front = -Y, corners are sharp points here) is rounded by `corner_radius` (a number, or one per vertex; `round_segments` 6 samples per corner) and extruded along X by `width`, with the two side caps as flat faces. With `segment` [a, b] (fractions 0..1 of the rounded perimeter, counted from the first outline point in the outline's order; a > b wraps through the end) only a THIN STRIP over that stretch of the surface is built instead: `thickness` (0.004) sits just OUTSIDE the surface, `inset` (0.01) leaves a margin at each side edge: a grille / trim panel that lies flush on the body piece of the same outline (use two pieces with identical outline, corner_radius and width; give the strip its own material)."""
    ol = [[float(c) * k for c in p] for p in it["outline"]]
    seg = int(it.get("round_segments", 6))
    cr = it.get("corner_radius", 0.0)
    cr = [float(x) * k for x in cr] if isinstance(cr, (list, tuple)) else float(cr) * k
    pts = _fillet_outline(ol, cr, seg)
    w = float(it["width"]) * k
    wb = float(it.get("width_back", it["width"])) * k   # width at the BACK (largest y); `width` is the width at the front (smallest y); in between it changes linearly: a tapered rear
    ys = [p[0] for p in pts]
    y0, y1 = min(ys), max(ys)

    def wf(y):
        return w + (wb - w) * ((y - y0) / (y1 - y0) if y1 - y0 > 1e-12 else 0.0)
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    sgn = 1.0 if area > 0 else -1.0
    sg = it.get("segment")
    if not sg:
        crown = float(it.get("crown_mm", 0)) * 0.001 * k
        capr = float(it.get("cap_round_mm", 0)) * 0.001 * k
        nc = int(it.get("width_segments", 8 if crown > 0 else 1)) + 1
        n = len(pts)
        # outward normal of the outline at each point: for the crown weight (1 on upward-facing stretches, 0 elsewhere) and for the inset of the rounded rim
        nrm_l = []
        wt = []
        for i in range(n):
            a_, c_, b2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % n])
            e0 = (c_ - a_).normalized() if (c_ - a_).length > 1e-12 else Vector((1, 0))
            e1 = (b2 - c_).normalized() if (b2 - c_).length > 1e-12 else e0
            n0, n1 = Vector((e0.y, -e0.x)) * sgn, Vector((e1.y, -e1.x)) * sgn
            nm = (n0 + n1)
            nm = nm.normalized() if nm.length > 1e-9 else n0
            nrm_l.append((nm, max(nm.dot(n0), 0.5)))   # miter normal and the cosine of the half angle (clamped)
            wt.append(min(1.0, max(0.0, (nm.y - 0.3) / 0.4)))   # nm.y is the outline's z component

        def inset_ring(d):
            """the outline moved inward by d (miter, clamped): the (y, z) of every point"""
            return [(pts[i][0] - nrm_l[i][0].x * d / nrm_l[i][1], pts[i][1] - nrm_l[i][0].y * d / nrm_l[i][1]) for i in range(n)]

        def poly_area(q):
            return sum(q[i][0] * q[(i + 1) % len(q)][1] - q[(i + 1) % len(q)][0] * q[i][1] for i in range(len(q))) / 2.0 * sgn
        if capr > 0:   # the rim cannot be rounder than the piece is thick or wide: halve until the inset outline keeps its orientation and at least 10 % of its area
            a0 = poly_area(pts)
            r_ok = min(capr, 0.45 * min(wf(y) for y, _ in pts))
            for _try in range(8):
                ia = poly_area(inset_ring(r_ok))
                if ia > 0.1 * a0 and all(poly_area(inset_ring(r_ok * q_)) > 0 for q_ in (0.5, 1.0)):
                    break
                r_ok *= 0.5
            capr = r_ok
        it["cap_round_used_mm"] = round(capr / k * 1000, 3)
        # columns across the width: (x function of y, inset of the outline). Rim rings on each side, then the interior columns
        rim = int(it.get("cap_round_segments", 3)) if capr > 0 else 0
        spec = []
        for q in range(rim):     # left rim, from the cap boundary (theta 90) toward the side surface
            th = math.pi / 2 * (1 - q / rim)
            spec.append((-1.0, 0.0, capr * (1 - math.cos(th)), th))
        # interior columns u = -1 .. 1 across the flat part (width minus the rim on each side)
        for c in range(nc):
            spec.append((None, -1.0 + 2.0 * c / (nc - 1), 0.0, None))
        for q in range(rim - 1, -1, -1):
            th = math.pi / 2 * (1 - q / rim)
            spec.append((1.0, 0.0, capr * (1 - math.cos(th)), th))
        cols = []
        for kind_, u, d_in, th in spec:
            ring = inset_ring(d_in) if d_in > 0 else [tuple(p_) for p_ in pts]
            col = []
            for i, (y, z) in enumerate(ring):
                hw = wf(pts[i][0]) / 2          # the half width at the outline point's own y (the taper follows the sweep, not the inset)
                if kind_ is None:
                    x = u * (hw - capr)
                else:
                    x = kind_ * (hw - capr + capr * math.sin(th))
                dz = 0.0
                if crown > 0:
                    tt = x / hw if hw > 1e-9 else 0.0
                    mode = it.get("crown_from", "edges_down")
                    dz = (-crown * tt * tt if mode == "edges_down" else crown * (1.0 - tt * tt)) * wt[i]
                col.append(bm.verts.new((x, y, z + dz)))
            cols.append(col)
        for i in range(n):
            j = (i + 1) % n
            for c in range(len(cols) - 1):
                bm.faces.new((cols[c][i], cols[c][j], cols[c + 1][j], cols[c + 1][i]))
        bm.faces.new(cols[0][::-1])
        bm.faces.new(cols[-1])
        return
    n = len(pts)
    seglen = [math.dist(pts[i], pts[(i + 1) % n]) for i in range(n)]
    total = sum(seglen)
    a, b_ = float(sg[0]) * total, float(sg[1]) * total
    if b_ <= a:
        b_ += total
    th = float(it.get("thickness", 0.004)) * k
    inset = float(it.get("inset", 0.01)) * k
    step = float(it.get("sample_mm", 4)) * 0.001 * k
    m = max(2, int((b_ - a) / max(step, 1e-6)) + 1)
    cum = [0.0]
    for L_ in seglen * 2:
        cum.append(cum[-1] + L_)
    def at(dist):
        i = 0
        while i < 2 * n - 1 and cum[i + 1] < dist:
            i += 1
        t = (dist - cum[i]) / max(cum[i + 1] - cum[i], 1e-12)
        p0, p1 = pts[i % n], pts[(i + 1) % n]
        return Vector((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t)), Vector((p1[0] - p0[0], p1[1] - p0[1])).normalized()
    rings = []
    for q in range(m):
        c, tg = at(a + (b_ - a) * q / (m - 1))
        hw = wf(c.x) / 2 - inset
        nrm = Vector((tg.y, -tg.x)) * sgn   # outward for the outline's own orientation
        o = c + nrm * th
        rings.append([(hw, c.x, c.y), (-hw, c.x, c.y), (-hw, o.x, o.y), (hw, o.x, o.y)])
    vs = _skin(bm, rings)
    bm.faces.new(vs[0][::-1])
    bm.faces.new(vs[-1])


def build_mesh(it, k):
    """a bmesh in the piece's own frame (centre at the origin), sizes already in metres"""
    bm = bmesh.new()
    kind = it["kind"]
    if kind == "box":
        sx, sy, sz = [float(x) * k for x in it["size"]]
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
        cuts = it.get("cuts", [0, 0, 0])
        for ax, n in enumerate(cuts):
            if int(n) > 0:
                edges = [e for e in bm.edges if abs((e.verts[0].co - e.verts[1].co)[ax]) > 1e-9 and all(abs((e.verts[0].co - e.verts[1].co)[o]) < 1e-9 for o in range(3) if o != ax)]
                bmesh.ops.subdivide_edges(bm, edges=edges, cuts=int(n), use_grid_fill=True)
        for fn in it.get("hide_faces", []):
            ax, sg = FACE_AXES[fn]
            bm.faces.ensure_lookup_table()
            fs = [f for f in bm.faces if f.normal[ax] * sg > 0.9]
            bmesh.ops.delete(bm, geom=fs, context="FACES_ONLY")
    elif kind == "plane":
        sx, sy = [float(x) * k for x in it["size"]]
        cx, cy = [int(x) for x in it.get("cuts", [0, 0])]
        bmesh.ops.create_grid(bm, x_segments=cx + 1, y_segments=cy + 1, size=1.0)
        xs_ = [v.co.x for v in bm.verts]
        ys_ = [v.co.y for v in bm.verts]
        wx, wy = max(xs_) - min(xs_), max(ys_) - min(ys_)
        for v in bm.verts:  # scale the grid to exactly sx by sy, centred
            v.co.x = (v.co.x - (max(xs_) + min(xs_)) / 2) * (sx / wx)
            v.co.y = (v.co.y - (max(ys_) + min(ys_)) / 2) * (sy / wy)
            v.co.z = 0.0
        nrm = it.get("normal", "+z")
        ax, sg = FACE_AXES[nrm]
        # the grid faces +z; rotate it to face the wanted side
        rot = {(2, 1): Matrix.Identity(3), (2, -1): Matrix.Rotation(math.pi, 3, "X"), (0, 1): Matrix.Rotation(math.pi / 2, 3, "Y"), (0, -1): Matrix.Rotation(-math.pi / 2, 3, "Y"),
               (1, 1): Matrix.Rotation(-math.pi / 2, 3, "X"), (1, -1): Matrix.Rotation(math.pi / 2, 3, "X")}[(ax, sg)]
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=rot, verts=bm.verts)
    elif kind == "cylinder":
        r, h = float(it["radius"]) * k, float(it["height"]) * k
        sides = int(it.get("sides", 16))
        cap = it.get("cap", "ngon")
        bmesh.ops.create_cone(bm, cap_ends=(cap == "ngon"), cap_tris=False, segments=sides, radius1=r, radius2=r, depth=h)
        ax = it.get("axis", "z")
        if ax == "x":
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "Y"), verts=bm.verts)
        elif ax == "y":
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(-math.pi / 2, 3, "X"), verts=bm.verts)
    elif kind in ("blob", "cluster"):
        import random
        sx, sy, sz = [float(x) * k for x in it["size"]]
        rng = random.Random(int(it.get("seed", 1)))
        lumps = float(it.get("lumps", 0.15))
        sub = int(it.get("detail", 2))
        nb = 1 if kind == "blob" else max(2, int(it.get("n", 4)))
        spread = float(it.get("spread", 0.55))
        for b in range(nb):
            if kind == "blob":
                ctr, rad = Vector((0, 0, 0)), (sx / 2, sy / 2, sz / 2)
            else:  # overlapping lumps whose centres lie inside the footprint (shells overlap; not one welded surface)
                ctr = Vector(((rng.random() * 2 - 1) * sx * spread / 2, (rng.random() * 2 - 1) * sy * spread / 2, (rng.random() * 2 - 1) * sz * 0.18))
                f = 0.55 + 0.35 * rng.random()
                rad = (sx / 2 * f, sy / 2 * f, sz / 2 * (0.7 + 0.3 * rng.random()))
            ico = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
            for v in ico["verts"]:
                n = Vector(v.co).normalized()
                fac = 1.0 + lumps * (rng.random() * 2 - 1)
                v.co = Vector((n.x * rad[0] * fac, n.y * rad[1] * fac, n.z * rad[2] * fac)) + ctr
        # Fit the whole shape to the declared size box by SCALING (only ever smaller): nothing is cut flat. Cutting every shell flat at the box faces would make the shells'
        # flat faces coplanar, and coplanar overlapping surfaces z-fight and render as black polygons.
        ext = [(min(v.co[i] for v in bm.verts), max(v.co[i] for v in bm.verts)) for i in range(3)]
        mid = [(lo + hi) / 2 for lo, hi in ext]
        fit = [min(1.0, d / max(hi - lo, 1e-9)) for d, (lo, hi) in zip((sx, sy, sz), ext)]
        for v in bm.verts:  # centred on the declared centre and scaled (never enlarged) to fit the size box
            v.co = Vector(((v.co.x - mid[0]) * fit[0], (v.co.y - mid[1]) * fit[1], (v.co.z - mid[2]) * fit[2]))
        if it.get("flat_bottom", True):
            dz = -sz / 2 - min(v.co.z for v in bm.verts)  # sit on the bottom of the size box: a shift, never a cut
            for v in bm.verts:
                v.co.z += dz
        if it.get("cut_flat", False):  # only on request: tops and bottoms cut flat at the box faces (coplanar across the shells)
            for v in bm.verts:
                v.co.z = max(-sz / 2, min(sz / 2, v.co.z))
    elif kind == "tube":
        mesh_tube(bm, it, k)
    elif kind == "sling":
        mesh_sling(bm, it, k)
    elif kind == "ring":
        mesh_ring(bm, it, k)
    elif kind == "siding":
        mesh_siding(bm, it, k)
    elif kind == "wedge":
        mesh_wedge(bm, it, k)
    elif kind == "profile":
        mesh_profile(bm, it, k)
    elif kind == "frame":
        mesh_frame(bm, it, k)
    elif kind == "cushion":
        mesh_cushion(bm, it, k)
    elif kind == "lathe":
        mesh_lathe(bm, it, k)
    else:
        raise RuntimeError(f"{it.get('name')}: kind must be box, plane, cylinder, blob, cluster, tube, sling, ring, frame, siding, wedge, profile, cushion or lathe")
    bev = float(it.get("bevel_mm", 0)) * 0.001
    if bev > 0 and kind in ("box", "cylinder", "frame"):
        if kind == "frame":
            rim = min((float(it["size"][0]) - float(it["inner"][0]) - 2 * abs(float(it.get("inner_offset", [0, 0])[0]))), (float(it["size"][1]) - float(it["inner"][1]) - 2 * abs(float(it.get("inner_offset", [0, 0])[1])))) / 2
            lim = min(float(it["size"][2]), rim) * k / 2.05
        else:
            lim = min(float(x) for x in (it["size"] if kind == "box" else [it["radius"] * 2, it["height"]])) * k / 2.05
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=min(bev, lim), segments=int(it.get("bevel_segments", 2)), profile=0.5, affect="EDGES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def topo(me, closed_expected, by_volume=False):
    bm = bmesh.new()
    bm.from_mesh(me)
    nm = sum(1 for e in bm.edges if len(e.link_faces) > 2)
    bd = sum(1 for e in bm.edges if len(e.link_faces) == 1)
    loose = sum(1 for v in bm.verts if not v.link_edges)
    quads = sum(1 for f in bm.faces if len(f.verts) == 4)
    tris = sum(1 for f in bm.faces if len(f.verts) == 3)
    ngons = sum(1 for f in bm.faces if len(f.verts) > 4)
    flipped = None
    if closed_expected and bd == 0 and len(bm.faces):
        if by_volume:  # a piece with a hole is not star-shaped: the centroid test would call the opening's walls flipped; the signed volume (positive = normals outward) is the test
            vol = sum(f.calc_center_median().dot(f.normal) * f.calc_area() for f in bm.faces) / 3
            flipped = 0 if vol > 0 else len(bm.faces)
        else:
            c = sum((v.co for v in bm.verts), Vector()) / len(bm.verts)
            flipped = sum(1 for f in bm.faces if (f.calc_center_median() - c).dot(f.normal) < 0)
    out = {"vertices": len(bm.verts), "faces": len(bm.faces), "quads": quads, "tris": tris, "ngons": ngons, "non_manifold_edges": nm, "boundary_edges": bd, "loose_vertices": loose, "flipped": flipped}
    bm.free()
    return out


def main():
    items = L.param("items") or []
    removes = L.param("remove") or []
    dry = bool(L.param("dry_run", False))
    k = 0.001 if L.param("units", "m") == "mm" else 1.0
    scn = bpy.context.scene
    factory_removed = L.drop_factory_objects() if not L.param('dry_run', False) else []
    col = bpy.data.collections.get("blockout")
    if col is None:
        col = bpy.data.collections.new("blockout")
        if not dry:
            scn.collection.children.link(col)
    report, made = {}, []
    # ---- removals (only our own pieces)
    for nm in removes:
        o = bpy.data.objects.get(nm)
        if o is None:
            report[nm] = {"action": "remove_skipped", "why": "no such object"}
        elif "blockout_kind" not in o:
            report[nm] = {"action": "refused", "why": "not made by blockout (no blockout_* properties): never deleted"}
        elif dry:
            report[nm] = {"action": "would_remove"}
        else:
            bpy.data.objects.remove(o, do_unlink=True)
            report[nm] = {"action": "removed"}
    # ---- pieces
    todo = []
    for it in items:
        todo.append(it)
        if it.get("mirror_x"):
            m2 = json.loads(json.dumps(it))
            m2["name"] = it["name"] + "_mirror"
            m2["centre"] = [-float(it["centre"][0]), float(it["centre"][1]), float(it["centre"][2])]
            m2["mirror_x"] = False
            todo.append(m2)
    for it in todo:
        nm = it["name"]
        st = it.get("status", "estimated")
        if st not in COLOURS:
            report[nm] = {"action": "refused", "why": f"status must be measured, estimated or inferred, not {st}"}
            continue
        ex = bpy.data.objects.get(nm)
        if ex is not None and "blockout_kind" not in ex:
            report[nm] = {"action": "refused", "why": "an object of that name exists and was not made by blockout: it is never replaced"}
            continue
        try:
            bm = build_mesh(it, k)
        except Exception as e:  # a bad spec is a refusal of that piece, not of the whole call
            report[nm] = {"action": "refused", "why": f"{type(e).__name__}: {e}"}
            continue
        me_tmp = bpy.data.meshes.new(nm + "-tmp")
        bm.to_mesh(me_tmp)
        bm.free()
        closed = it["kind"] in ("box", "cylinder", "blob", "frame") and not it.get("hide_faces") and not (it["kind"] == "cylinder" and it.get("cap") == "none")
        t = topo(me_tmp, closed, by_volume=it["kind"] == "frame")
        rot = Euler([math.radians(float(x)) for x in it.get("rot_deg", [0, 0, 0])], "XYZ")
        ctr = Vector([float(x) * k for x in it["centre"]])
        M4 = Matrix.Translation(ctr) @ rot.to_matrix().to_4x4()
        me_tmp.transform(M4)
        pts = np.array([list(v.co) for v in me_tmp.vertices]) if len(me_tmp.vertices) else np.zeros((1, 3))
        r = {"action": ("would_replace" if ex else "would_create") if dry else ("replaced" if ex else "created"), "status": st, "kind": it["kind"], "dims": {kk: it[kk] for kk in ("size", "radius", "height", "sides", "cuts", "normal", "axis", "cap", "hide_faces", "rot_deg", "seed", "lumps", "detail", "n", "spread", "flat_bottom", "bevel_mm", "bevel_segments", "smooth_angle_deg", "clip", "from_mesh", "z_origin", "outward", "path", "radii", "smooth", "up", "width", "widths", "thickness", "side", "tube_radius", "tube_sides", "course_height", "board_thickness", "top_thickness", "openings", "backing", "front_height", "grille", "round_segments", "profile", "lobes", "dimples", "feet", "step_mm", "soften", "cap_round_mm", "cap_round_used_mm", "crown_mm") if kk in it}, **t,
             "bounds_m": [[round(float(x), 4) for x in pts.min(0)], [round(float(x), 4) for x in pts.max(0)]], "note": it.get("note", "")}
        if it.get("_siding_coverage"):
            r["siding_coverage"] = it["_siding_coverage"]
        report[nm] = r
        if dry:
            bpy.data.meshes.remove(me_tmp)
            continue
        if ex is not None:
            bpy.context.view_layer.update()
            me_tmp.transform(ex.matrix_world.inverted())  # the new shape is built in world coordinates; the object may have been moved, re-pivoted or parented since: express it in the object's own frame so it stays where it is built
            old = ex.data
            ex.data = me_tmp
            bpy.data.meshes.remove(old)
            o = ex
        else:
            o = bpy.data.objects.new(nm, me_tmp)
            col.objects.link(o)
        me_tmp.name = nm
        me_tmp.materials.clear()
        me_tmp.materials.append(mat_for(st))
        for p in me_tmp.polygons:
            p.use_smooth = it["kind"] in ("cushion", "lathe") and it.get("smooth_angle_deg") is None  # every piece starts FLAT-shaded; a cushion starts smooth (soft shoulders), unless smooth_angle_deg says otherwise
        if it["kind"] in ("cushion", "lathe") and it.get("smooth_angle_deg") is None:
            r["shading"] = {"mode": f"smooth ({it['kind']} default)", "polygons": len(me_tmp.polygons)}
        if it.get("smooth_angle_deg") is not None:  # smooth by angle (sharp edges kept), geometry unchanged; kept on every rebuild of this piece
            import _shade as SH  # noqa: E402
            r["shading"] = SH.smooth_by_angle(me_tmp, float(it["smooth_angle_deg"]))
        o["blockout_kind"] = it["kind"]
        o["blockout_status"] = st
        o["blockout_note"] = it.get("note", "")
        o["blockout_group"] = it.get("group", "")
        o["blockout_dims"] = json.dumps(r["dims"])
        o["blockout_centre_m"] = json.dumps([round(float(x), 5) for x in ctr])
        o.display_type = "SOLID"
        made.append(o)
    tot = {"pieces": sum(1 for v in report.values() if v.get("action") in ("created", "replaced", "would_create", "would_replace")),
           "quads": sum(v.get("quads", 0) for v in report.values()), "tris": sum(v.get("tris", 0) for v in report.values()), "ngons": sum(v.get("ngons", 0) for v in report.values()),
           "non_manifold_edges": sum(v.get("non_manifold_edges", 0) for v in report.values()), "refused": [n for n, v in report.items() if v.get("action") == "refused"]}
    files = []
    views = L.param("views") or ["iso", "top"]
    allp = [o for o in bpy.data.objects if "blockout_kind" in o and o.name in col.objects] if not dry else []
    if allp and views:
        fit = L.param("fit", "all")
        sel = allp if fit == "all" else [o for o in allp if o.name in fit]
        pts = np.array([(o.matrix_world @ Vector(c))[:] for o in sel for c in o.bound_box])
        ctr = Vector(((pts.min(0) + pts.max(0)) / 2).tolist())
        ext = float(np.ptp(pts, axis=0).max())
        res = int(L.param("res", 720))
        dirs = {"iso": Vector((-0.55, -0.75, 0.6)), "top": Vector((0, 0, 1)), "front": Vector((0, -1, 0)), "back": Vector((0, 1, 0)), "side": Vector((-1, 0, 0))}
        dd = {}
        for v in views:
            if isinstance(v, dict):
                dd[v["name"]] = Vector(v["dir"])
            else:
                dd[v] = dirs[v]
        from _handview import render_views  # noqa: E402
        files = render_views(sel, ctr, ext * 1.25, "blockout", res, dd)
    L.finish({"pieces": report, "totals": tot, "legend": {"measured": "green", "estimated": "amber", "inferred": "grey-blue"}, "pictures": [os.path.basename(f) for f in files], "dry_run": dry, "factory_objects_removed": factory_removed, "frame": "the scene's world frame (reference: floor z = 0, +X left, +Y back, +Z up, metres)",
              "notes": ["every dimension is kept on the object (blockout_dims); run the verb again with the same name and new numbers to change it", "objects not made by blockout are never changed or deleted"]}, save=not dry, files=files)


L.run(main)
