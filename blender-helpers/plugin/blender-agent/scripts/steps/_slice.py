"""Cross-sections of a triangle mesh by a plane perpendicular to an axis (shared by hand_make and wrist_flex)."""
import numpy as np


def slice_points(P, tris, wrist, u, v, w, s0):
    """Points where the mesh edges cross the plane (u . (x - wrist) = s0), as (v, w) coordinates relative to `wrist`: an array (n, 2) (empty when the plane misses the mesh)."""
    s = (P - wrist) @ u - s0
    out = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        sa, sb = s[tris[:, a]], s[tris[:, b]]
        m = (sa * sb) < 0
        if not m.any():
            continue
        ia, ib = tris[m, a], tris[m, b]
        t = (sa[m] / (sa[m] - sb[m]))[:, None]
        X = P[ia] + (P[ib] - P[ia]) * t - wrist
        out.append(np.stack([X @ v, X @ w], axis=1))
    return np.concatenate(out) if out else np.zeros((0, 2))


def section_stats(pts):
    if len(pts) < 6:
        return None
    return {"breadth_mm": round(float(np.ptp(pts[:, 0])) * 1000, 1), "thickness_mm": round(float(np.ptp(pts[:, 1])) * 1000, 1),
            "centre_v_w_mm": [round(float((pts[:, 0].max() + pts[:, 0].min()) / 2) * 1000, 1), round(float((pts[:, 1].max() + pts[:, 1].min()) / 2) * 1000, 1)], "edge_crossings": int(len(pts))}


def outline_radius(pts, centre, theta, bins=36):
    """Radius of the section's outline (the largest radius in each angular bin) at angle(s) `theta` about `centre` (2D); nan where no point lies near that angle."""
    q = pts - np.asarray(centre)
    a = np.arctan2(q[:, 1], q[:, 0])
    r = np.hypot(q[:, 0], q[:, 1])
    edges = np.linspace(-np.pi, np.pi, bins + 1)
    idx = np.clip(np.digitize(a, edges) - 1, 0, bins - 1)
    rad = np.full(bins, np.nan)
    for k in range(bins):
        m = idx == k
        if m.any():
            rad[k] = r[m].max()
    th = np.atleast_1d(theta)
    ti = np.clip(np.digitize(th, edges) - 1, 0, bins - 1)
    return rad[ti]
