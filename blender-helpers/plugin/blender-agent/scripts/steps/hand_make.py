"""hand_make — build a clean HAND from parameters: a palm with four fingers and a thumb (three segments each, the thumb with its metacarpal), real gaps between the fingers, a ring of loops at every joint for bending, and skin weights built in. Saves a checkpoint.

A candidate source for replacement hands (no Library asset or paid step is needed). The hand is a NEW mesh object; nothing existing is changed. Its vertex groups carry the TARGET bone names (the rig's prefix + LeftHand, LeftHandThumb1-3, LeftHandIndex1-3, Middle, Ring, Pinky) and its joint positions are stored on the object (`hand_joints`),
so the finger-bone verb can add the matching bones and the fitting verb can place it on a body. The shape is stylised: anatomical proportions and clean quad loops, no scan detail.

The hand is modelled as a palm block with a finger extruded from each of four knuckle columns and the thumb from the thenar wall, then smoothed once or twice (`smooth`). Frame of the hand (a left hand; a right hand is its mirror): u runs from the wrist to the fingertips, v across the hand from the little finger to the thumb, w out of the palm.

params:
  side        "left" (default) or "right"
  name        the object's name (default "hand_L" / "hand_R")
  armature    the rig object (default "rig" if present): the hand takes its position, direction and size from the body: wrist = the Hand bone's head, direction = forearm to hand, size from the forearm's length. Without a rig give `wrist_mm` and `axis`
  wrist_mm    [x, y, z] world mm of the wrist centre (used when there is no rig, or to override it)
  axis        [x, y, z] the direction the fingers point (default from the rig; else +X for left, -X for right)
  wrist_offset_mm  move the wrist along the axis from the Hand bone's head (negative = toward the elbow): when the Hand bone's head lies inside the old hand, the wrist (where the palm starts, at the cuff's end) is further back
  palm        [x, y, z] the direction the palm faces (default [0, 0, -1]: palms down, as in a T-pose)
  fit_body    true (default): size the hand like the BODY's own hand when it has one (the vertices weighted to the Hand bone: length from the wrist, width across the knuckles, palm thickness); `body` names the mesh (default "body")
  length_mm   wrist to the tip of the middle finger (default: the body's hand length, else 0.42 x the forearm length from the rig, else 190)
  breadth_mm  width of the palm across the knuckles (default 0.95 x the body hand's width, else 0.5 x length)
  thickness   palm thickness as a fraction of the breadth (default 0.36), or `thickness_mm` (default 0.85 x the body hand's)
  insert_mm   the wrist end reaches this far back from the wrist, to hide inside a cuff (default 14); the wrist rows take the cuff opening's width and thickness from the body when it has one
  wrist_breadth_mm / wrist_thickness_mm  the size of the wrist end (the cross-section that sits inside the cuff), mm; overrides the measured cuff (reported as measured_body_hand.cuff_*). Palm size is separate (breadth_mm, thickness_mm)
  wrist_taper how fast the hand grows from the wrist to the full palm: 0 = the second row stays wrist-size, 1 = full palm size already at the second row (default 0.5)
  wrist_hold_mm  where the second row (the one wrist_taper sets) sits, mm ahead of the wrist (default 0.17 x length). The hand is a straight blend between rows: rear end (-insert), this row, then the palm rows. wrist_taper 0 keeps the wrist-end cross-section up to this row; 1 (the palm's size already there) makes the section at the wrist itself about halfway between the two
  neck_breadth_mm / neck_thickness_mm  the size of the second row, which sits at wrist_hold_mm ahead of the wrist: the VISIBLE wrist. Independent of the wrist-end cage (wrist_breadth_mm / wrist_thickness_mm / insert_mm), so the hand can start big inside the sleeve (concealed, fills the opening) and narrow to a slim wrist where it leaves the cuff. They override wrist_taper for that row. Check sections_mm
  palm_length_mm  wrist to the knuckle row (default 0.54 x length), independent of the fingers
  finger_length_mm the middle finger's length, knuckle to tip (default 0.45 x length); the other fingers scale with it. length_mm still sets the default for both and the thumb
  neck_crease  0..1: sharpen the subdivision at the wrist-end and neck rows, so the surface there stays close to the cage instead of being swollen by the neighbouring rows (default 0 = off)
  thenar      the ball of the thumb on the palm side: a multiplier (default 1, 0 = flat); its first row (the one at the neck) carries 40 % of it
  knuckle_swell  0..0.15: widen each finger at its two joint rings by this fraction and narrow between them, so the bend rings read as knuckles (default 0 = uniform tubes)
  finger_thickness_scale  true: finger thickness differs by finger (middle 1.04, index 1.0, ring 0.96, little 0.84); default false
  thumb_base  a fuller thumb base along its first bone (default 1; 1.3 is noticeably fuller)
  uv, uv_name true (default): give the hand a UV layer named `uv_name` (default "HandUV"): the back and the palm as two islands, seams along the silhouette, unwrapped and packed in 0..1. Its own name, so the body's UV layer is untouched after hand_attach. false: no UV. This layer is only a quick parallel projection (the edge-on walls are distorted: several islands, flips): for painting run hand_uv, which replaces it with a real unwrap
  gap         the gap between fingers as a fraction of the breadth (default 0.05)
  spread_deg  the fan between neighbouring fingers (default 5)
  thumb_deg   how far the thumb stands off the index finger, in the palm plane (default 40) and `thumb_palm_deg` out of it toward the palm (default 20)
  smooth      subdivision levels after the block is built (default 2; 1 = lighter mesh)
  rig_prefix  the prefix of the bones' names (default "mixamorig:")
  colour      [r, g, b] the hand's flat skin colour 0..1 (default [0.78, 0.60, 0.50])
  with_body   true (default): also clay pictures of the new hand beside the body's own arm at the same scale (hand-<name>-withbody-top/palm/front.png); `body` names the mesh (default "body")
  preview     true (default): clay pictures in out/ (hand-<name>-palm_side/back_side/thumb_side/oblique.png)
Returns: proportions (palm length, middle finger, and the knuckle-row breadth/thickness without the thumb, as ratios of the middle finger), sections_mm (the evaluated breadth and thickness of the finished hand at the rear end, mid-insert, wrist, and palm start, after smoothing: the wrist_*_mm values set the control cage, and subdivision pulls the ends in), cage_mm (the cage's sizes and positions), object, vertices, polygons, sizes (length, breadth, thickness, finger lengths mm), joints (every bone head/tail in world mm, parent), weights (vertices per group, max influences, unweighted), checks (loose vertices, non-manifold edges, boundary edges), pictures.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Quaternion, Vector  # noqa: E402
import _lib as L  # noqa: E402
from _handview import render_views  # noqa: E402

FINGERS = ["Pinky", "Ring", "Middle", "Index"]  # columns run from the little finger (-v) to the index finger (+v)
LEN = {"Index": 0.41, "Middle": 0.45, "Ring": 0.42, "Pinky": 0.33}  # MCP -> tip, as a fraction of the hand length
BASE_U = {"Index": 0.545, "Middle": 0.555, "Ring": 0.535, "Pinky": 0.50}  # where each finger's first ring sits along the hand (fraction of the length)
FSCALE = {"Index": 1.0, "Middle": 1.04, "Ring": 0.96, "Pinky": 0.84}  # finger_thickness_scale
FAN = {"Pinky": -2.0, "Ring": -1.0, "Middle": 0.0, "Index": 1.0}  # multiples of spread_deg (+ toward the thumb)
SEG = (0.45, 0.30, 0.25)  # a finger's length: proximal, middle, distal


def frame_from(axis, palm, side):
    u = Vector(axis).normalized()
    w = Vector(palm) - Vector(palm).dot(u) * u
    w.normalize()
    v = w.cross(u)
    if side == "right":
        v = -v
    return u, v, w


def transport(frames, t_from, t_to):
    """rotate (side, up) frame vectors by the smallest rotation that turns tangent t_from into t_to (no twist)"""
    q = t_from.rotation_difference(t_to)
    return [q @ f for f in frames]


def smoothstep(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def main():
    side = L.param("side", "left")
    if side not in ("left", "right"):
        raise RuntimeError('side must be "left" or "right"')
    pre = L.param("rig_prefix", "mixamorig:")
    S = "Left" if side == "left" else "Right"
    name = L.param("name", "hand_L" if side == "left" else "hand_R")
    arm = bpy.data.objects.get(L.param("armature", "rig"))
    wrist = axis = None
    flen = None
    if arm is not None and arm.type == "ARMATURE" and pre + S + "Hand" in arm.data.bones:
        hb = arm.data.bones[pre + S + "Hand"]
        fb = arm.data.bones.get(pre + S + "ForeArm")
        mw = arm.matrix_world
        wrist = mw @ hb.head_local
        if fb is not None:
            axis = wrist - mw @ fb.head_local
            flen = axis.length
            axis.normalize()
    if L.param("wrist_mm"):
        wrist = Vector([x / 1000 for x in L.param("wrist_mm")])
    if wrist is None:
        raise RuntimeError("no rig with a Hand bone: give wrist_mm (and axis)")
    if L.param("axis"):
        axis = Vector(L.param("axis")).normalized()
    if axis is not None and L.param("wrist_offset_mm"):
        wrist = wrist + axis * (float(L.param("wrist_offset_mm")) / 1000)
    if axis is None:
        axis = Vector((1, 0, 0)) if side == "left" else Vector((-1, 0, 0))
    # the size: from the body's OWN hand if it has one (vertices weighted to the Hand bone), else from the forearm, else a default
    measured = None
    bo = bpy.data.objects.get(L.param("body", "body"))
    if L.param("fit_body", True) and bo is not None and bo.type == "MESH" and (pre + S + "Hand") in bo.vertex_groups and wrist is not None and axis is not None:
        gi = bo.vertex_groups[pre + S + "Hand"].index
        co = np.empty(len(bo.data.vertices) * 3)
        bo.data.vertices.foreach_get("co", co)
        Mb = np.array(bo.matrix_world)
        P = co.reshape(-1, 3) @ Mb[:3, :3].T + Mb[:3, 3]
        wv = np.zeros(len(P))
        for vv in bo.data.vertices:
            for g in vv.groups:
                if g.group == gi:
                    wv[vv.index] = g.weight
        sel = wv >= 0.5
        u_, v_, w_ = frame_from(axis, L.param("palm", [0, 0, -1]), side)
        rel = P[sel] - np.array(wrist)
        s_ = rel @ np.array(u_)
        keep = s_ > -0.01
        if keep.sum() > 50:
            s_, rel = s_[keep], rel[keep]
            Hb = float(np.percentile(s_, 99.7))
            zone = (s_ > 0.47 * Hb) & (s_ < 0.62 * Hb)
            zp = (s_ > 0.15 * Hb) & (s_ < 0.45 * Hb)
            Bb = float(np.ptp(rel[zone] @ np.array(v_))) if zone.sum() > 10 else 0.5 * Hb
            Tb = float(np.ptp(rel[zp] @ np.array(w_))) if zp.sum() > 10 else 0.15 * Hb
            measured = {"length_mm": round(Hb * 1000, 1), "breadth_mm": round(Bb * 1000, 1), "palm_thickness_mm": round(Tb * 1000, 1), "vertices": int(keep.sum())}
        # the cuff / forearm just before the wrist: the ring the new hand's wrist must hide in (any body vertex within 15 mm before the wrist plane and near the axis)
        relall = P - np.array(wrist)
        sa = relall @ np.array(u_)
        lat = np.linalg.norm(relall - np.outer(sa, np.array(u_)), axis=1)
        ring = (sa > -0.015) & (sa < 0.0) & (lat < 0.12 * 1.0)
        if ring.sum() > 12:
            rr = relall[ring]
            measured = measured or {}
            measured["cuff_breadth_mm"] = round(float(np.ptp(rr @ np.array(v_))) * 1000, 1)
            measured["cuff_thickness_mm"] = round(float(np.ptp(rr @ np.array(w_))) * 1000, 1)
    dH = (measured["length_mm"] if measured else ((0.42 * flen * 1000) if flen else 190.0))
    H = float(L.param("length_mm", dH)) / 1000
    B = float(L.param("breadth_mm", measured["breadth_mm"] * 0.95 if measured else 0.50 * H * 1000)) / 1000
    T = (float(L.param("thickness_mm", measured["palm_thickness_mm"] * 0.85)) / 1000) if (measured or L.param("thickness_mm")) else B * float(L.param("thickness", 0.36))
    gap = float(L.param("gap", 0.03)) * B
    spread = float(L.param("spread_deg", 5))
    u, v, w = frame_from(axis, L.param("palm", [0, 0, -1]), side)

    def world(p):
        return wrist + u * p[0] + v * p[1] + w * p[2]

    fw = (B - 3 * gap) / 4  # a finger's width at its base
    centres = {}
    x = -B / 2 + fw / 2
    for f in FINGERS:
        centres[f] = x
        x += fw + gap
    # ---- the palm block: 4 rows along u, 8 columns across (two per finger), 2 layers (back, palm)
    insert = float(L.param("insert_mm", 14.0)) / 1000  # the wrist end reaches this far back, to hide inside a cuff
    Pl = float(L.param("palm_length_mm", 0.54 * H * 1000)) / 1000  # wrist -> knuckle row
    Fs = float(L.param("finger_length_mm", 0.45 * H * 1000)) / 1000 / (0.45 * H)  # the fingers' scale: the middle finger's length (MCP -> tip) over its default
    rows_u = [-insert, 0.315 * Pl, 0.667 * Pl, Pl]
    if L.param("wrist_hold_mm") is not None:
        rows_u[1] = min(max(float(L.param("wrist_hold_mm")) / 1000, 0.002), rows_u[2] - 0.01)
    rows_scale = [0.80, 0.90, 0.97, 1.0]  # narrower at the wrist
    rows_thick = [0.95, 1.0, 0.92, 0.62]
    if measured and measured.get("cuff_breadth_mm"):
        # the wrist rows follow the cuff opening: a little inside it so the join is covered (breadth across, thickness through)
        rows_scale[0] = min(max(0.90 * measured["cuff_breadth_mm"] / 1000 / B, 0.55), 1.4)
        rows_scale[1] = 0.5 * (rows_scale[0] + 0.97)
        rows_thick[0] = min(max(0.90 * measured["cuff_thickness_mm"] / 1000 / T, 0.5), 1.6)
        rows_thick[1] = 0.5 * (rows_thick[0] + 1.0)
    # explicit wrist size (mm, at the wrist end) overrides the measured cuff; wrist_taper (0..1) = how far the second row sits toward the palm's size (0 = as the wrist, 1 = full palm)
    if L.param("wrist_breadth_mm") is not None:
        rows_scale[0] = float(L.param("wrist_breadth_mm")) / 1000 / B
    if L.param("wrist_thickness_mm") is not None:
        rows_thick[0] = float(L.param("wrist_thickness_mm")) / 1000 / T
    if L.param("wrist_breadth_mm") is not None or L.param("wrist_thickness_mm") is not None or L.param("wrist_taper") is not None:
        tp = float(L.param("wrist_taper", 0.5))
        rows_scale[1] = rows_scale[0] + tp * (0.97 - rows_scale[0])
        rows_thick[1] = rows_thick[0] + tp * (1.0 - rows_thick[0])
    # an explicit size for the second row (the visible wrist at wrist_hold_mm), independent of the wrist-end cage: a big concealed rear that narrows to a slim visible wrist
    if L.param("neck_breadth_mm") is not None:
        rows_scale[1] = float(L.param("neck_breadth_mm")) / 1000 / B
    if L.param("neck_thickness_mm") is not None:
        rows_thick[1] = float(L.param("neck_thickness_mm")) / 1000 / T
    col_v = []
    for f in FINGERS:
        col_v += [centres[f] - fw / 2, centres[f] + fw / 2]
    thenar = float(L.param("thenar", 1.0))  # the ball of the thumb: 1 = default, 0 = none; it begins half way to the knuckles (row 1 carries 40 % of it)
    bm = bmesh.new()
    pv = {}
    for r in range(4):
        for j in range(8):
            for k in range(2):
                th = T * rows_thick[r]
                # the thenar side (+v) is a little thicker toward the palm; the back of the hand is gently domed
                bulge = (0.45 * T if j == 7 else 0.30 * T) * thenar * (0.4 if r == 1 else 1.0) if (j >= 6 and r in (1, 2) and k == 1) else 0.0
                wk = (th / 2 + bulge) if k == 1 else (-th / 2)
                pv[(r, j, k)] = bm.verts.new(Vector((rows_u[r], col_v[j] * rows_scale[r], wk)))
    # the thumb's base ring replaces the wall face at column 7, rows 1-2: its 4 corners are those palm vertices
    cmc = Vector((0.5 * (rows_u[1] + rows_u[2]) + 0.01 * H, col_v[7] * 0.97 + 0.0, 0.0))
    d0 = Vector((0.45, 0.80, 0.30 * math.sin(math.radians(float(L.param("thumb_palm_deg", 20)) * 2.5)) + 0.04)).normalized()
    ta = math.radians(float(L.param("thumb_deg", 40)))
    d1 = Vector((math.cos(ta) * 0.95, math.sin(ta) * 0.45, 0.12)).normalized()
    thumb_len = [0.19 * H, 0.13 * H, 0.105 * H]
    chain_t = [cmc]
    dirs_t = [d0, d0.lerp(d1, 0.6).normalized(), d1]
    for i, s in enumerate(thumb_len):
        chain_t.append(chain_t[-1] + dirs_t[i] * s)
    # thumb ring0: set the four wall vertices around the thumb base, perpendicular to d0
    es0 = d0.cross(Vector((0, 0, 1))).normalized()  # across the base (about +u)
    eu0 = es0.cross(d0).normalized()  # out of the palm
    tw0, tt0 = 0.36 * B, 0.32 * B
    ring0 = [cmc - es0 * tw0 / 2 - eu0 * tt0 / 2, cmc + es0 * tw0 / 2 - eu0 * tt0 / 2, cmc + es0 * tw0 / 2 + eu0 * tt0 / 2, cmc - es0 * tw0 / 2 + eu0 * tt0 / 2]
    tv_ids = [(1, 7, 0), (2, 7, 0), (2, 7, 1), (1, 7, 1)]
    for key, p in zip(tv_ids, ring0):
        pv[key].co = p
    bm.verts.ensure_lookup_table()

    def quad(a, b, c, d_):
        try:
            bm.faces.new((a, b, c, d_))
        except ValueError:
            pass
    # palm faces: front (k=1) and back (k=0) between rows and columns
    for r in range(3):
        for j in range(7):
            quad(pv[(r, j, 1)], pv[(r, j + 1, 1)], pv[(r + 1, j + 1, 1)], pv[(r + 1, j, 1)])
            quad(pv[(r, j + 1, 0)], pv[(r, j, 0)], pv[(r + 1, j, 0)], pv[(r + 1, j + 1, 0)])
    for r in range(3):  # side walls (column 0 is the little-finger side; column 7 the thumb side, except where the thumb leaves)
        quad(pv[(r, 0, 0)], pv[(r, 0, 1)], pv[(r + 1, 0, 1)], pv[(r + 1, 0, 0)])
        if r != 1:
            quad(pv[(r, 7, 1)], pv[(r, 7, 0)], pv[(r + 1, 7, 0)], pv[(r + 1, 7, 1)])
    for j in range(7):  # the wrist end cap
        quad(pv[(0, j, 0)], pv[(0, j + 1, 0)], pv[(0, j + 1, 1)], pv[(0, j, 1)])
    for f in range(3):  # the web between neighbouring fingers at the knuckle row
        a = 2 * f + 1
        quad(pv[(3, a, 0)], pv[(3, a + 1, 0)], pv[(3, a + 1, 1)], pv[(3, a, 1)])
    # ---- the fingers
    joints = {}  # bone -> (head, tail, parent) in the hand's local frame
    chains = {}
    ring_sets = {}

    def build_tube(first_ring, centres_pts, tang, frames0, widths, thicks, tip_scale=0.82):
        """rings after the first: centre points, tangents, parallel-transported frames, half sizes; returns the list of rings (each 4 verts) including the first"""
        rings = [first_ring]
        es, eu = frames0
        prev_t = tang[0]
        for i in range(1, len(centres_pts)):
            t = tang[i]
            es, eu = transport([es, eu], prev_t, t)
            prev_t = t
            c = centres_pts[i]
            wd, th = widths[i], thicks[i]
            ring = [bm.verts.new(c - es * wd / 2 - eu * th / 2), bm.verts.new(c + es * wd / 2 - eu * th / 2), bm.verts.new(c + es * wd / 2 + eu * th / 2), bm.verts.new(c - es * wd / 2 + eu * th / 2)]
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            for q in range(4):
                quad(a[q], a[(q + 1) % 4], b[(q + 1) % 4], b[q])
        last = rings[-1]
        quad(last[3], last[2], last[1], last[0])  # the tip cap
        return rings

    for f in FINGERS:
        L_ = LEN[f] * H * Fs
        ang = math.radians(spread * FAN[f])
        d = Vector((math.cos(ang), math.sin(ang), 0.0))
        seg_len = [s * L_ for s in SEG]
        mcp = Vector((rows_u[3], centres[f], 0.0))
        pts_j = [mcp]
        for s in seg_len:
            pts_j.append(pts_j[-1] + d * s)  # MCP, PIP, DIP, tip
        # ring stations: MCP, mid prox, PIP, mid mid, DIP, mid dist, tip
        stations = [mcp, mcp.lerp(pts_j[1], 0.5), pts_j[1], pts_j[1].lerp(pts_j[2], 0.5), pts_j[2], pts_j[2].lerp(pts_j[3], 0.5), pts_j[3]]
        tang = [d] * 7
        taper = [1.0, 1.0, 0.97, 0.94, 0.90, 0.86, 0.78]
        sw_ = float(L.param("knuckle_swell", 0.0))  # a little widening at each joint ring (stations 2 and 4), narrower between
        swell = [1.0, 1.0 - sw_ / 2, 1.0 + sw_, 1.0 - sw_ / 2, 1.0 + sw_, 1.0 - sw_ / 2, 1.0]
        fs_ = FSCALE[f] if L.param("finger_thickness_scale", False) else 1.0  # the little finger thinner, the middle one thickest
        widths = [fw * 1.12 * t * sw * (fs_ if i else 1.0) for i, (t, sw) in enumerate(zip(taper, swell))]
        thicks = [fw * 1.02 * t * sw * (fs_ if i else 1.0) for i, (t, sw) in enumerate(zip(taper, swell))]
        first = [pv[(3, 2 * FINGERS.index(f), 0)], pv[(3, 2 * FINGERS.index(f) + 1, 0)], pv[(3, 2 * FINGERS.index(f) + 1, 1)], pv[(3, 2 * FINGERS.index(f), 1)]]
        # the first ring's vertices keep the palm row's coordinates; later rings fan with the finger
        first_centre = sum((q.co for q in first), Vector()) / 4
        stations[0] = first_centre
        rings = build_tube(first, stations, tang, (Vector((0, 1, 0)), Vector((0, 0, 1))), widths, thicks)
        ring_sets[f] = rings
        names = [f"{S}Hand{f}{i + 1}" for i in range(3)]
        for i in range(3):
            joints[names[i]] = (pts_j[i], pts_j[i + 1], names[i - 1] if i else f"{S}Hand")
        chains[f] = pts_j
    # the thumb
    tb = float(L.param("thumb_base", 1.0))  # the thumb's base is the thickest part: 1 = default, more = a fuller base along the first bone
    tw = [0.36 * B * tb, 0.33 * B * (1 + (tb - 1) * 0.8), 0.29 * B * (1 + (tb - 1) * 0.4), 0.26 * B, 0.23 * B, 0.21 * B, 0.17 * B]
    stations_t = [chain_t[0], chain_t[0].lerp(chain_t[1], 0.5), chain_t[1], chain_t[1].lerp(chain_t[2], 0.5), chain_t[2], chain_t[2].lerp(chain_t[3], 0.5), chain_t[3]]
    tang_t = []
    for i in range(7):
        a = stations_t[max(i - 1, 0)]
        b = stations_t[min(i + 1, 6)]
        tang_t.append((b - a).normalized())
    first_t = [pv[k] for k in tv_ids]
    rings_t = build_tube(first_t, stations_t, tang_t, (es0, eu0), tw, [x * 0.9 for x in tw])
    names_t = [f"{S}HandThumb{i + 1}" for i in range(3)]
    for i in range(3):
        joints[names_t[i]] = (chain_t[i], chain_t[i + 1], names_t[i - 1] if i else f"{S}Hand")
    chains["Thumb"] = chain_t
    joints[f"{S}Hand"] = (Vector((0, 0, 0)), Vector((0.30 * H, 0, 0)), None)
    cr = float(L.param("neck_crease", 0.0))
    crease_pairs = set()
    if cr > 0:
        # sharpen the subdivision at the wrist-end and neck rows so the surface there stays close to the cage (otherwise neighbouring rows swell it); applied as the mesh's crease_edge attribute below
        bm.verts.index_update()
        for r in (0, 1):
            rv = {pv[(r, j, k)].index for j in range(8) for k in range(2)}
            for e_ in bm.edges:
                if e_.verts[0].index in rv and e_.verts[1].index in rv:
                    crease_pairs.add(frozenset((e_.verts[0].index, e_.verts[1].index)))
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if crease_pairs:
        ca = me.attributes.get("crease_edge") or me.attributes.new("crease_edge", "FLOAT", "EDGE")
        for e_ in me.edges:
            if frozenset(e_.vertices) in crease_pairs:
                ca.data[e_.index].value = cr
    # local -> world
    mat_l = Matrix(((u.x, v.x, w.x, wrist.x), (u.y, v.y, w.y, wrist.y), (u.z, v.z, w.z, wrist.z), (0, 0, 0, 1)))
    me.transform(mat_l)
    if side == "right":
        pass  # the frame already mirrors the geometry; recalc normals once more after the transform
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bm2 = bmesh.new()
    bm2.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm2, faces=bm2.faces)
    bm2.to_mesh(me)
    bm2.free()
    levels = int(L.param("smooth", 2))
    if levels > 0:
        md = obj.modifiers.new("sub", "SUBSURF")
        md.levels = levels
        md.render_levels = levels
        md.quality = 3
        dg = bpy.context.evaluated_depsgraph_get()
        newm = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
        obj.modifiers.clear()
        old = obj.data
        obj.data = newm
        newm.name = name
        bpy.data.meshes.remove(old)
        me = newm
    for p in me.polygons:
        p.use_smooth = True
    # ---- UV layout: a stable "HandUV" layer (its own name, so the body's UV layer is untouched when the hand is joined). Two islands, the BACK of the hand (left half of the sheet) and the PALM (right half), each a parallel projection along the palm normal
    # (so a photo taken from the back or the front lines up with it), with the finger walls given width by a shear along w (y = v + 0.6 w) so they are not collapsed to a line. No unwrap operator: deterministic and it does not depend on Blender's UV tools.
    uv_info = None
    if L.param("uv", True):
        uvname = L.param("uv_name", "HandUV")
        Pm = np.array([list(vv.co) for vv in me.vertices]) - np.array(wrist)
        ua, va, wa = np.array(u), np.array(v), np.array(w)
        px_, py_, pw_ = Pm @ ua, Pm @ va, Pm @ wa
        pk = 0.6
        lay = me.uv_layers.get(uvname) or me.uv_layers.new(name=uvname)
        me.uv_layers.active = lay
        pnorm = np.array([list(p_.normal) for p_ in me.polygons]) @ wa
        # extents of each island's projection
        sides_ = np.where(pnorm >= 0, 1, -1)
        ext = {}
        for sg in (-1, 1):
            vs_ = set()
            for p_ in me.polygons:
                if sides_[p_.index] == sg:
                    vs_.update(p_.vertices)
            vs_ = np.array(sorted(vs_), dtype=np.int64)
            yy = py_[vs_] + pk * sg * pw_[vs_]
            ext[sg] = (px_[vs_].min(), px_[vs_].max(), yy.min(), yy.max())
        x0 = min(e[0] for e in ext.values())
        x1 = max(e[1] for e in ext.values())
        y0 = min(e[2] for e in ext.values())
        y1 = max(e[3] for e in ext.values())
        sc = min(0.47 / max(x1 - x0, 1e-9), 0.95 / max(y1 - y0, 1e-9))
        uvs_ = np.zeros((len(me.loops), 2))
        for p_ in me.polygons:
            sg = int(sides_[p_.index])
            for li in range(p_.loop_start, p_.loop_start + p_.loop_total):
                vi = me.loops[li].vertex_index
                x = (px_[vi] - x0) * sc
                y = (py_[vi] + pk * sg * pw_[vi] - y0) * sc
                if sg > 0:  # the palm island: mirrored so that it reads like the back seen through the hand, in the right half
                    uvs_[li] = (0.97 - x, 0.025 + y) if False else (0.5 + 0.015 + x, 0.025 + y)
                else:
                    uvs_[li] = (0.015 + x, 0.025 + y)
        lay.data.foreach_set("uv", uvs_.ravel())
        uv_info = {"layer": uvname, "method": "planar back / palm (parallel projection along the palm normal, walls sheared)", "islands": 2,
                   "uv_bounds": [[round(float(x), 3) for x in uvs_.min(0)], [round(float(x), 3) for x in uvs_.max(0)]],
                   "sheet": "left half = the BACK of the hand (u along the sheet's x from the wrist to the fingertips), right half = the PALM, same orientation", "pixels_per_mm_at_1024": round(sc * 1024 / 1000, 2),
                   "note": "own layer name: the body's UV layer is untouched after hand_attach; check with uv_check mesh:<the joined mesh> uv:HandUV"}
    # ---- weights: each vertex follows its nearest chain; along a chain the two neighbouring bones blend across a band around each joint
    V = np.array([(obj.matrix_world @ vv.co)[:] for vv in me.vertices])
    chain_w = {}
    for cn, pts in chains.items():
        chain_w[cn] = [np.array(world(p)) for p in pts]
    hand_name = f"{S}Hand"
    groups = {hand_name: {}}
    for cn in chains:
        for i in range(3):
            groups[f"{S}Hand{cn}{i + 1}"] = {}
    for vi, p in enumerate(V):
        best, bd, bs = None, 1e9, 0.0
        for cn, pts in chain_w.items():
            s_acc = 0.0
            for i in range(3):
                a, b = pts[i], pts[i + 1]
                ab = b - a
                t = float(np.clip(np.dot(p - a, ab) / max(np.dot(ab, ab), 1e-12), 0, 1))
                dd = float(np.linalg.norm(p - (a + ab * t)))
                if dd < bd:
                    bd, best, bs = dd, cn, (i, t, np.linalg.norm(ab))
        # a vertex on the palm side of the chain's first joint (before its start) belongs to the Hand bone
        cn = best
        pts = chain_w[cn]
        i, t, seg_l = bs
        u_ax = (pts[1] - pts[0])
        along0 = float(np.dot(p - pts[0], u_ax / max(np.linalg.norm(u_ax), 1e-9)))
        band = 0.35 * seg_l
        wts = {}
        # position along the chain in metres from its start
        s_pos = sum(np.linalg.norm(pts[k + 1] - pts[k]) for k in range(i)) + t * seg_l
        starts = [sum(np.linalg.norm(pts[k + 1] - pts[k]) for k in range(m)) for m in range(4)]
        # bone m owns [starts[m], starts[m+1]]; blend with the next bone over +-band of each inner joint
        for m in range(3):
            wm = 1.0
            if m > 0:
                wm *= smoothstep((s_pos - (starts[m] - band)) / (2 * band))
            if m < 2:
                wm *= 1.0 - smoothstep((s_pos - (starts[m + 1] - band)) / (2 * band))
            if wm > 1e-4:
                wts[f"{S}Hand{cn}{m + 1}"] = wm
        # the first bone blends in from the Hand bone over the first band
        head = smoothstep((s_pos - (-band)) / (2 * band)) if along0 > -band else 0.0
        if along0 < 0:
            head = smoothstep((along0 + band) / (2 * band))
        f1 = f"{S}Hand{cn}1"
        if f1 in wts:
            wts[hand_name] = 1.0 - head
            wts[f1] *= head
        tot = sum(wts.values())
        if tot < 1e-9:
            wts = {hand_name: 1.0}
            tot = 1.0
        # the palm and wrist: a vertex far from every finger chain's start belongs to the Hand bone
        for g, wv in wts.items():
            groups[g][vi] = wv / tot
    mats = bpy.data.materials.new(name + "-skin")
    col = L.param("colour", [0.78, 0.60, 0.50])
    mats.diffuse_color = (col[0], col[1], col[2], 1)
    me.materials.append(mats)
    for g, mp in groups.items():
        vg = obj.vertex_groups.new(name=pre + g)
        for vi, wv in mp.items():
            if wv > 1e-4:
                vg.add([vi], wv, "REPLACE")
    # stored joint positions (world mm) for the bone verb
    jj = {}
    for bn, (hd, tl, par) in joints.items():
        jj[pre + bn] = {"head_mm": [round(c * 1000, 2) for c in world(hd)], "tail_mm": [round(c * 1000, 2) for c in world(tl)], "parent": (pre + par) if par else None}
    obj["hand_joints"] = json.dumps(jj)
    obj["hand_side"] = side
    # ---- checks
    bmc = bmesh.new()
    bmc.from_mesh(me)
    nm = sum(1 for e in bmc.edges if not e.is_manifold)
    bd_ = sum(1 for e in bmc.edges if e.is_boundary)
    loose = sum(1 for vv in bmc.verts if not vv.link_edges)
    bmc.free()
    infl = max((sum(1 for g in me.vertices[i].groups if g.weight > 1e-4) for i in range(len(me.vertices))), default=0)
    unw = sum(1 for vv in me.vertices if not vv.groups)
    summary = {"uv": uv_info, "measured_body_hand": measured, "object": obj.name, "vertices": len(me.vertices), "polygons": len(me.polygons), "sizes_mm": {"length": round(H * 1000, 1), "breadth": round(B * 1000, 1), "thickness": round(T * 1000, 1),
               "palm_length": round(Pl * 1000, 1), "finger_lengths": {f: round(LEN[f] * H * Fs * 1000, 1) for f in FINGERS}},
               "joints": jj, "weights": {"groups": {k: len(vv) for k, vv in groups.items()}, "max_influences": int(infl), "unweighted_vertices": int(unw)},
               "checks": {"loose_vertices": loose, "non_manifold_edges": nm, "boundary_edges": bd_}}
    # the evaluated sections (after smoothing): the wrist_*_mm values are the CONTROL CAGE's size; subdivision pulls a convex end in, so the surface is smaller. Each is a true cross-section: the mesh sliced by the plane perpendicular to the hand's axis
    from _slice import slice_points, section_stats
    me.calc_loop_triangles()
    tri_ = np.array([t_.vertices[:] for t_ in me.loop_triangles], dtype=np.int64)
    P_ = np.array([list(vv.co) for vv in me.vertices])
    ua, va, wa = np.array(u), np.array(v), np.array(w)
    secs = {}
    for lab, st in (("rear_end", -insert + 0.0015), ("mid_insert", -insert / 2), ("wrist", 0.0), ("neck", rows_u[1]), ("mid_palm", 0.5 * (rows_u[1] + rows_u[3])), ("knuckles", rows_u[3] - 0.004)):
        pts_ = slice_points(P_, tri_, np.array(wrist), ua, va, wa, st)
        ss = section_stats(pts_)
        if ss:
            nt = pts_[np.abs(pts_[:, 0]) <= 0.56 * B]  # without the thumb
            if len(nt) >= 6:
                ss["without_thumb"] = {"breadth_mm": round(float(np.ptp(nt[:, 0])) * 1000, 1), "thickness_mm": round(float(np.ptp(nt[:, 1])) * 1000, 1)}
            secs[f"{lab} @ {round(st * 1000, 1)} mm"] = ss
    summary["sections_mm"] = secs
    if cr > 0:
        summary["neck_crease"] = {"value": cr, "creased_edges": len(crease_pairs), "attribute_present": "crease_edge" in me.attributes}
    kn = next((x for k_, x in secs.items() if k_.startswith("knuckles")), None)
    mid_f = LEN["Middle"] * H * Fs * 1000
    summary["proportions"] = {"palm_length_mm": round(Pl * 1000, 1), "middle_finger_mm": round(mid_f, 1), "palm_length_over_middle_finger": round(Pl * 1000 / mid_f, 2),
                              "knuckle_breadth_over_middle_finger": round(kn["without_thumb"]["breadth_mm"] / mid_f, 2) if kn and "without_thumb" in kn else None,
                              "knuckle_thickness_over_middle_finger": round(kn["without_thumb"]["thickness_mm"] / mid_f, 2) if kn and "without_thumb" in kn else None}
    summary["cage_mm"] = {"wrist_breadth": round(B * rows_scale[0] * 1000, 1), "wrist_thickness": round(T * rows_thick[0] * 1000, 1), "second_row_breadth": round(B * rows_scale[1] * 1000, 1), "second_row_thickness": round(T * rows_thick[1] * 1000, 1), "second_row_at_mm": round(rows_u[1] * 1000, 1), "rear_row_at_mm": round(rows_u[0] * 1000, 1)}
    files = []
    if L.param("preview", True):
        os.makedirs(L.ARGS["out_dir"], exist_ok=True)
        ctr = wrist + u * (0.5 * H)
        files = render_views([obj], ctr, H * 1.6, f"hand-{name}", 560, {"palm_side": w, "back_side": -w, "thumb_side": v, "oblique": (w * 0.7 + v * 0.5 - u * 0.4)})
    if L.param("with_body", True) and L.param("preview", True):
        bo = bpy.data.objects.get(L.param("body", "body"))
        if bo is not None and bo.type == "MESH":
            # the hand beside the body's own forearm at the same scale (clay)
            ctr = wrist - u * 0.12
            files += render_views([obj, bo], ctr, 0.62, f"hand-{name}-withbody", 640, {"top": Vector((0, 0, 1)) if abs(w.z) > 0.5 else w * -1, "palm": w, "front": Vector((0, -1, 0))})
    summary["pictures"] = [os.path.basename(f) for f in files]
    L.finish(summary, save=True, files=files)


L.run(main)
