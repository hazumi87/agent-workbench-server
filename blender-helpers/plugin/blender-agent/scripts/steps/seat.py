"""seat — register one part on another by their JIGS: turn, scale and move the part so the jig face of the part sits in the socket jig of the host. Saves a checkpoint (not with dry_run). Run jig_find on BOTH parts first (each stores its jig on the part as the property jig_<id>).

The part's jig axis points OUT of the part, the socket's axis OUT of the host: the part is turned so its axis points INTO the host (the opposite of the socket axis), by the shortest rotation (two ellipses are also rolled to line up their major axes, the smaller of the two half-turns), scaled uniformly about its jig centre by (socket diameter / the part's jig diameter) when `scale` is "jig", then moved so its jig centre sits at the socket centre, `sink_mm` further into the host. The part's own jig record is updated to its new place and size. Only the part moves; the host is never changed.

params:
  part        the part to move (required); part_jig the id of its jig (default "jig")
  socket_of   the host object (required); socket_id the id of the socket jig on the host (default "jig")
  scale       "jig" (default: socket diameter / part jig diameter, the major diameters for ellipses), "none" (1), or a number
  sink_mm     how far the jig face ends up inside the socket's plane (default 3, as kit2_part's touch)
  reach_mm    the contact face for the gap numbers: a point of the part farther than this from the host is not counted (default 40)
  median_limit_mm, worst_limit_mm   the gate (default 6 and 20, as kit2_contact)
  dry_run     true: nothing is kept; the numbers and the pictures are of the seated result, then the part goes back
  pictures    true (default): the seam from the socket's axis, from the side and from the front; res px (default 600)
Returns: used (the jig records), rotation (deg, axis, roll), scale (the factor and which diameters), move_mm (the jig centre's shift), before / after (kit2_contact numbers: n_contact_points, median_gap_mm, worst_gap_mm, max_gap_mm, min_gap_mm, face_tilt_deg), overlap (the deepest a sampled vertex of the part lies inside the host's surface, mm, and how many points are inside: a host that is not closed can read inside on the wrong side: look at the picture), gate_ok / gate_reasons, the part's size before / after (mm), pictures. Refuses a part or host that is not at the identity transform (apply it first), a missing jig, and a rotation over 175 degrees.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402
import kit2_seatlib as SL  # noqa: E402
from _handview import render_views  # noqa: E402


def unit(v):
    v = np.array(v, float)
    return v / max(np.linalg.norm(v), 1e-12)


def rot_between(a, b):
    a, b = unit(a), unit(b)
    c = float(a @ b)
    if c > 1 - 1e-9:
        return np.eye(3)
    if c < -1 + 1e-9:
        perp = np.cross(a, [1, 0, 0])
        if np.linalg.norm(perp) < 1e-6:
            perp = np.cross(a, [0, 1, 0])
        return np.array(Matrix.Rotation(math.pi, 3, Vector(unit(perp).tolist())))
    v = np.cross(a, b)
    s = np.linalg.norm(v)
    kx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + kx + kx @ kx * ((1 - c) / (s * s))


def rot_about(axis, ang):
    return np.array(Matrix.Rotation(ang, 3, Vector(unit(axis).tolist())))


def diam(j):
    return float(j.get("diameter_mm") or j.get("major_mm"))


def main():
    part = bpy.data.objects.get(L.param("part", ""))
    host = bpy.data.objects.get(L.param("socket_of", ""))
    if part is None or part.type != "MESH" or host is None or host.type != "MESH":
        raise RuntimeError("give `part` and `socket_of`: two mesh objects")
    for o in (part, host):
        if np.abs(np.array(o.matrix_world) - np.eye(4)).max() > 1e-6:
            raise RuntimeError(f"{o.name} is not at the identity transform: apply its transform first (kit2_part's parts already are)")
    pid, sid = "jig_" + str(L.param("part_jig", "jig")), "jig_" + str(L.param("socket_id", "jig"))
    if pid not in part:
        raise RuntimeError(f"{part.name} has no {pid}: run jig_find on it first")
    if sid not in host:
        raise RuntimeError(f"{host.name} has no {sid}: run jig_find on it first (id {L.param('socket_id', 'jig')})")
    pj, hj = json.loads(part[pid]), json.loads(host[sid])
    cp, ch = np.array(pj["centre_mm"]) / 1000, np.array(hj["centre_mm"]) / 1000
    ap, ah = unit(pj["axis"]), unit(hj["axis"])
    target = -ah
    R1 = rot_between(ap, target)
    roll_deg = 0.0
    if pj["kind"] == "ellipse" and hj["kind"] == "ellipse":
        mp = R1 @ unit(pj["major_axis"])
        mh = unit(hj["major_axis"])
        def ang(a, b):
            c = float(np.clip(a @ b, -1, 1))
            sgn = 1.0 if float(np.cross(a, b) @ target) >= 0 else -1.0
            return sgn * math.acos(c)
        t1, t2 = ang(mp, mh), ang(mp, -mh)
        roll = t1 if abs(t1) <= abs(t2) else t2
        R1 = rot_about(target, roll) @ R1
        roll_deg = math.degrees(roll)
    tr = np.trace(R1)
    rot_deg = math.degrees(math.acos(max(-1, min(1, (tr - 1) / 2))))
    if rot_deg > 175:
        raise RuntimeError(f"the part would be turned {rot_deg:.0f} degrees: its jig axis points the wrong way round (check the part and the socket, or the id)")
    sp = L.param("scale", "jig")
    if sp == "jig":
        s = diam(hj) / diam(pj)
    elif sp == "none":
        s = 1.0
    else:
        s = float(sp)
    sink = float(L.param("sink_mm", 3)) / 1000
    reach = float(L.param("reach_mm", 40)) / 1000
    V0 = K.verts(part).copy()
    host_bvh = K.bvh_of(host)
    hosts = SL.Hosts([host])

    def numbers():
        V, N, prs = SL.pairs(part, hosts, reach)
        st = SL.stats(V, N, prs)
        return st
    size0 = [round(float(x) * 1000, 1) for x in np.ptp(V0, axis=0)]
    before = numbers()
    # the move: about the part's jig centre, then the jig centre to the socket centre, sunk along the socket's inward direction
    V1 = ch + target * sink + s * (V0 - cp) @ R1.T
    K.set_verts(part, V1)
    bpy.context.view_layer.update()
    after = numbers()
    gate_ok, why = SL.gate(after, float(L.param("median_limit_mm", 6)), float(L.param("worst_limit_mm", 20)))
    rng = np.random.default_rng(3)
    idx = rng.choice(len(V1), min(4000, len(V1)), replace=False)
    sd = K.surf_signed(K.bvh_of(host), V1[idx])
    near = np.abs(sd) < reach
    inside = sd[near & (sd < 0)]
    overlap = {"deepest_inside_mm": round(float(-inside.min()) * 1000, 2) if len(inside) else 0.0, "points_inside": int(len(inside)), "points_in_reach": int(near.sum()),
               "note": "signed against the host's surface normals: an open host can read inside on the wrong side: look at the picture"}
    files = []
    if L.param("pictures", True):
        res = int(L.param("res", 600))
        ax = Vector(ah.tolist())
        side = ax.cross(Vector((0, 0, 1)))
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        side.normalize()
        front = ax.cross(side).normalized()
        files = render_views([part, host], Vector(ch.tolist()), max(diam(hj) / 1000 * 4.0, 0.1), "seat-" + part.name, res, {"axis": ax, "side": side, "front": front})
    dist_move = float(np.linalg.norm((ch + target * sink) - cp) * 1000)
    out = {"part": part.name, "host": host.name, "used": {"part_jig": pj, "socket_jig": hj}, "rotation": {"degrees": round(rot_deg, 2), "roll_deg": round(roll_deg, 2)},
           "scale": {"factor": round(float(s), 4), "mode": sp, "socket_mm": round(diam(hj), 2), "part_mm": round(diam(pj), 2)}, "move_mm": round(dist_move, 2), "sink_mm": sink * 1000,
           "before": before, "after": after, "overlap": overlap, "gate_ok": gate_ok, "gate_reasons": why, "part_size_mm": {"before": size0, "after": [round(float(x) * 1000, 1) for x in np.ptp(V1, axis=0)]},
           "pictures": [os.path.basename(f) for f in files], "dry_run": bool(L.param("dry_run", False))}
    if L.param("dry_run", False):
        K.set_verts(part, V0)
        out["notes"] = ["dry run: the part is back where it was"]
        L.finish(out, save=False, files=files)
        return
    # the part's own jig record follows it
    def mv(p):
        return (ch + target * sink + s * (np.array(p) / 1000 - cp) @ R1.T) * 1000
    pj2 = dict(pj)
    pj2["centre_mm"] = [round(float(x), 2) for x in mv(pj["centre_mm"])]
    pj2["axis"] = [round(float(x), 4) for x in unit(R1 @ ap)]
    for k in ("diameter_mm", "major_mm", "minor_mm", "height_mm"):
        if k in pj2:
            pj2[k] = round(pj2[k] * s, 2)
    for k in ("top_centre_mm", "base_centre_mm"):
        if k in pj2:
            pj2[k] = [round(float(x), 2) for x in mv(pj[k])]
    if "major_axis" in pj2:
        pj2["major_axis"] = [round(float(x), 4) for x in unit(R1 @ unit(pj["major_axis"]))]
    part[pid] = json.dumps(pj2)
    part["seated_on"] = json.dumps({"host": host.name, "socket_id": L.param("socket_id", "jig"), "scale": round(float(s), 4), "sink_mm": sink * 1000})
    out["notes"] = ["the part's jig record now describes its new place and size", "only the part moved"]
    L.finish(out, save=True, files=files)


L.run(main)
