"""kit2_seat — seat a rigid mounted part on its host: rotate and move it as one piece (never scaled, never bent) until the face that turns toward the host lies on the host. Saves a checkpoint.

For a buckler on a harness strap, a plate on a pauldron, a cuff on a bracer: the part keeps its size and shape (the report proves it), only its position and tilt change. The fit
is an iterative closest-point alignment on the contact face (the same face kit2_contact and kit2_part's `touch` measure), each point aimed at the nearest host point pushed `sink_mm`
on through the surface. The tilt that results is whatever puts the face flat on the host: if the reference's plates tilt back and outward because the strap does, the fit finds it.

params:
  part       name of the part, or `parts` a list; each is seated on its own, in the order given
  host       name of the object it sits on (required), or a list of names when it rests on more than one ("host": ["harness", "body"]): the nearest surface of any of them counts
  rotate     false = move only, never tilt (default true)
  sink_mm    how far the face ends up inside the host's surface (default 3, as kit2_part's touch)
  reach_mm   a point of the part farther than this from the host is not part of the contact face (default 40; raise it for a part that starts far away)
  iterations (default 30)
  max_rotate_deg, max_move_mm   a seating that needs more than this is refused and nothing is saved (default 60 and 60): raise them only when you mean it
  median_limit_mm, worst_limit_mm   the gate reported afterwards (default 6 and 20); the verb does not fail on it unless `require_gate` is true
  dry_run    true = compute and report, change and save nothing
Returns, per part: before / after (the kit2_contact numbers: n_contact_points, median_gap_mm, worst_gap_mm, max_gap_mm, min_gap_mm, face_tilt_deg), rotation_deg (the angle) and axis,
euler_xyz_deg, move_mm (the face centre's shift), iterations and converged, size_mm_before / size_mm_after (equal: it is rigid), max_edge_change_mm (0), gate_ok.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402
import kit2_seatlib as S  # noqa: E402


def main():
    hosts, hb = S.hosts_of(L.param("host"))
    hname = ", ".join(h.name for h in hosts)
    names = L.param("parts") or ([L.param("part")] if L.param("part") else [])
    if not names:
        raise RuntimeError("part (or parts) is required")
    reach = float(L.param("reach_mm", 40)) / 1000.0
    sink = float(L.param("sink_mm", 3)) / 1000.0
    ml, wl = float(L.param("median_limit_mm", 6)), float(L.param("worst_limit_mm", 20))
    max_rot, max_move = float(L.param("max_rotate_deg", 60)), float(L.param("max_move_mm", 60)) / 1000.0
    dry = bool(L.param("dry_run", False))
    out, fails = {}, []
    for n in names:
        o = bpy.data.objects.get(n)
        if o is None or o.type != "MESH":
            raise RuntimeError(f"no mesh named {n}")
        v0 = K.verts(o).copy()
        V, N, prs = S.pairs(o, hb, reach)
        before = S.stats(V, N, prs)
        if before["n_contact_points"] < 20:
            raise RuntimeError(f"{n}: only {before['n_contact_points']} points of its face toward {hname} are within {reach * 1000:.0f} mm of it: raise reach_mm, or move the part closer first")
        R, t, iters, conv, _ = S.seat(o, hb, reach=reach, sink=sink, iters=int(L.param("iterations", 30)), rotate=bool(L.param("rotate", True)))
        ang, ax = S.angle_axis(R)
        v1 = K.verts(o)
        shift = (v1.mean(0) - v0.mean(0))
        V2, N2, prs2 = S.pairs(o, hb, reach)
        after = S.stats(V2, N2, prs2)
        ok, why = S.gate(after, ml, wl)
        ev = np.array([e.vertices[:] for e in o.data.edges][:5000])
        edge = float(np.abs(np.linalg.norm(v1[ev[:, 0]] - v1[ev[:, 1]], axis=1) - np.linalg.norm(v0[ev[:, 0]] - v0[ev[:, 1]], axis=1)).max())
        too_far = ang > max_rot or np.linalg.norm(shift) > max_move
        out[n] = {"before": before, "after": after, "rotation_deg": round(ang, 1), "axis": [round(float(x), 3) for x in ax], "euler_xyz_deg": S.euler_deg(R),
                  "move_mm": [K.mm(x) for x in shift], "iterations": iters, "converged": conv, "size_mm_before": [K.mm(x) for x in (v0.max(0) - v0.min(0))],
                  "size_mm_after": [K.mm(x) for x in (v1.max(0) - v1.min(0))], "max_edge_change_mm": round(edge * 1000, 4), "gate_ok": ok, "gate_reasons": why}
        if too_far:
            K.set_verts(o, v0)
            fails.append(f"{n}: seating needs a {ang:.1f} degree turn and a {np.linalg.norm(shift) * 1000:.0f} mm move (limits {max_rot:g} degrees, {max_move * 1000:g} mm): nothing changed; "
                         "raise max_rotate_deg / max_move_mm if that is right, or move the part nearer first")
        elif dry:
            K.set_verts(o, v0)
        elif not ok and L.param("require_gate", False):
            fails.append(f"{n}: seated but the gate fails: {'; '.join(why)}")
    if fails:
        raise RuntimeError("; ".join(fails))
    L.finish({"host": hname, "sink_mm": sink * 1000, "rigid": "rotation and translation only, no scale", "dry_run": dry, "limits_mm": {"median": ml, "worst": wl}, "parts": out}, save=not dry)


L.run(main)
