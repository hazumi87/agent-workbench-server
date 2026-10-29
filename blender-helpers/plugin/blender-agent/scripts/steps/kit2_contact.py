"""kit2_contact — the gap between a mounted part and the host it sits on, over the whole face of the part that turns toward the host. Read-only, saves nothing.

The same measure as kit2_part's `touch` check (same samples, so the numbers agree), usable at any time: after kit2_transform, kit2_tweak or kit2_seat. The far side of the part
is not counted: only points of the part with a clear line to the host's nearest surface point.

params:
  part       name of the part, or `parts` a list of names (a pair: ["plate_L", "plate_R"])
  host       name of the object it sits on (required), e.g. "frame"; or a list of names ("host": ["frame", "body"]) when it rests on more than one: the nearest surface of any of them counts
  reach_mm   a point of the part farther than this from the host is not part of the contact face (default 40)
  median_limit_mm, worst_limit_mm   the gate (default 6 and 20, the same as kit2_part's touch_max_median_mm / touch_max_worst_mm)
Returns, per part: n_contact_points, median_gap_mm, worst_gap_mm (95th percentile), max_gap_mm, min_gap_mm, face_tilt_deg (the mean normal of the part's contact face against the mean host normal under it, in degrees: 0 = lying flat
on the host, so a plate that should lie flat but reads 20 here is tilted), gate_ok and gate_reasons, plus the part's centre and size (mm).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
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
    ml, wl = float(L.param("median_limit_mm", 6)), float(L.param("worst_limit_mm", 20))
    out = {}
    for n in names:
        o = bpy.data.objects.get(n)
        if o is None or o.type != "MESH":
            raise RuntimeError(f"no mesh named {n}")
        V, N, prs = S.pairs(o, hb, reach)
        st = S.stats(V, N, prs)
        ok, why = S.gate(st, ml, wl)
        v = K.verts(o)
        out[n] = {**st, "gate_ok": ok, "gate_reasons": why, "centre_mm": [K.mm(x) for x in K.centre_of(v)], "size_mm": [K.mm(x) for x in (v.max(0) - v.min(0))]}
    L.finish({"host": hname, "reach_mm": reach * 1000, "limits_mm": {"median": ml, "worst": wl}, "parts": out}, save=False)


L.run(main)
