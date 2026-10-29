"""kit2_body — step 2 of character-kit-assembly: fit the base body to the reference, measure, and report.

The job's mesh is the REFERENCE (the whole character, wearing everything); it is never edited.
The body is imported from the Library, welded, and moved by ONE similarity transform (uniform scale, rotation,
translation) — no stretching. The report lists body-vs-reference differences at the places parts will sit.

params:
  body      Library mesh id of the base body
  region    ICP sample region: "all" (default) or "trunk" (torso and legs only, ignores arms/hands/head)
  The report also has `limbs`: for each arm and leg, stations along its length with the reference's and the body's centre
  position and half-thickness, and body minus reference (mm), plus a per-limb summary. The body is NOT moved per limb.
  budget    body triangle budget after measuring (default 60000)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def fit_body(body_v, ref_v, region):
    tree = K.kd(ref_v)
    rng = np.random.default_rng(0)
    hs = (ref_v[:, 2].max() - ref_v[:, 2].min()) / (body_v[:, 2].max() - body_v[:, 2].min())
    pool = body_v
    if region == "trunk":
        z = (body_v[:, 2] - body_v[:, 2].min()) * hs
        pool = body_v[(z < 0.62) & (np.abs(body_v[:, 0]) * hs < 0.25)]
    sub = pool[rng.choice(len(pool), 4000, replace=False)]
    p = sub * hs
    off = np.array([(ref_v[:, 0].max() + ref_v[:, 0].min()) / 2 - (p[:, 0].max() + p[:, 0].min()) / 2,
                    (ref_v[:, 1].max() + ref_v[:, 1].min()) / 2 - (p[:, 1].max() + p[:, 1].min()) / 2,
                    ref_v[:, 2].min() - p[:, 2].min()])
    p = p + off
    tot = np.eye(4)
    tot[:3, :3] *= hs
    tot[:3, 3] = off
    res = None
    for _ in range(30):
        idx, d = K.nearest(tree, p)
        sel = d <= np.quantile(d, 0.7)
        res = float(np.median(d[sel]))
        s, r, t = K.umeyama(p[sel], ref_v[idx[sel]])
        p = s * (p @ r.T) + t
        st = np.eye(4)
        st[:3, :3] = s * r
        st[:3, 3] = t
        tot = st @ tot
    return tot, res


def main():
    ref = L.the_mesh()
    ref.name = "ref"
    L.activate(ref)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    rv = K.verts(ref)
    body = K.import_glb(K.lib(L.param("body")), "body")
    K.weld(body)
    bv0 = K.verts(body)
    tot, res = fit_body(bv0, rv, L.param("region", "all"))
    bv = bv0 @ tot[:3, :3].T + tot[:3, 3]
    K.set_verts(body, bv)
    m_ref, m_body = K.measure(rv), K.measure(bv)
    scale = float(abs(np.linalg.det(tot[:3, :3])) ** (1 / 3))
    rot = tot[:3, :3] / scale
    yaw = float(np.degrees(np.arctan2(rot[1, 0], rot[0, 0])))
    before, after = K.decimate(body, int(L.param("budget", 60000)))
    L.finish({
        "region": L.param("region", "all"), "scale": round(scale, 4), "yaw_deg": round(yaw, 2),
        "icp_median_error_mm": K.mm(res), "body_tris": [before, after], "body_checks": K.mesh_checks(body),
        "ref": {k: ([round(x * 1000, 1) for x in v] if isinstance(v, list) else round(v * 1000, 1)) for k, v in m_ref.items()},
        "body_minus_ref_mm": K.diff_table(m_ref, m_body),
        "limbs": K.limb_compare(rv, bv),
    }, save=True)


L.run(main)