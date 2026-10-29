"""shared: smooth shading by angle without changing geometry"""
import math

import bmesh
import numpy as np


def smooth_by_angle(me, angle_deg, mode="angle"):
    """mode "angle": every face smooth, every edge whose two faces meet at more than angle_deg marked SHARP (so the frame's hard edges stay crisp and curved parts lose their facets); "all": every face smooth, no sharp edges; "flat": every face flat, no sharp edges. Vertices, faces, UVs and materials are never touched. Returns a report."""
    v0 = np.array([v.co[:] for v in me.vertices]).copy()
    n_poly = len(me.polygons)
    n_edge = len(me.edges)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.edges.ensure_lookup_table()
    sharp = [False] * len(bm.edges)
    ang_max_smooth = 0.0
    n_sharp = 0
    if mode == "angle":
        thr = math.radians(float(angle_deg))
        for e in bm.edges:
            if len(e.link_faces) == 2:
                a = e.calc_face_angle(0.0)
                if a > thr:
                    sharp[e.index] = True
                    n_sharp += 1
                else:
                    ang_max_smooth = max(ang_max_smooth, a)
    bm.free()
    me.polygons.foreach_set("use_smooth", [mode != "flat"] * n_poly)
    me.edges.foreach_set("use_edge_sharp", sharp)
    me.update()
    v1 = np.array([v.co[:] for v in me.vertices])
    dev = 0.0
    if mode != "flat" and len(me.polygons):
        for p in me.polygons:
            fn = p.normal
            for li in p.loop_indices:
                cn = me.corner_normals[li].vector
                dev = max(dev, math.degrees(fn.angle(cn, 0.0)))
    return {"polygons": n_poly, "edges": n_edge, "mode": mode, "angle_deg": float(angle_deg) if mode == "angle" else None, "sharp_edges": n_sharp,
            "largest_angle_kept_smooth_deg": round(math.degrees(ang_max_smooth), 2) if mode == "angle" else None, "max_normal_deviation_from_face_deg": round(dev, 2),
            "geometry_unchanged": bool(v0.shape == v1.shape and np.array_equal(v0, v1) and n_poly == len(me.polygons) and n_edge == len(me.edges))}
