"""pose_surface_check — compare the SURFACE of the posed copy with the captured body surface, slice by slice, to tell a bone pointing the right way from a skin facing the right way. Reads only; saves no checkpoint.

pose_fit swings every bone to the captured bone direction, so its direction errors are zero by construction. They say nothing about where the skin sits around the bones: a spine pivot too far forward leaves the back round while every bone points correctly.
This verb casts rays from the front and from the back, at chosen heights and sideways positions, into the posed copy (made by pose_fit) and into the captured reference mesh (made by reference_import: `MetaBody_<label>`, the same instant, the same coordinates),
and reports where each surface is, how deep the body is, and how the surface is tilted, with the differences. Heights are millimetres in the reference frame (floor z = 0; +X the character's left, +Y backwards, +Z up).

params:
  copy        the posed copy (default "body_posed")
  reference   the captured mesh object (default: the MetaBody_* whose capture_time_s is the copy's reference_time_s)
  z_mm        list of heights to slice at (default: `levels` evenly spaced from the fitted Hips to the fitted Neck)
  levels      how many slices when z_mm is not given (default 8)
  x_mm        list of sideways positions of the rays (default [0], the midline), along the frame's side axis
  frame       "world" (default): rays run along world Y (front/back at rest); "pelvis": the character's own frame at this instant, taken from the FITTED rig: side = right hip to left hip (flattened), back = up x side, origin the pelvis. Use "pelvis"
              when the person is turned (a 90-degree turn): "front/back" then mean the chest and the back, y_mm are measured along that back direction from the pelvis, and the normal pitch is the tilt in that side view.
  to          the bone whose height ends the default slices (default "Neck"; "Head" or "HeadTop_End" to reach the head)
  z_rel_mm    heights as offsets from the fitted Hips (e.g. [0, 100, 200, 300]) instead of z_mm: they follow the pose at that instant
Returns: rows: per height and sideways position, for the copy and the reference: front_y_mm and back_y_mm (where the first surface is hit from the front / from the back), depth_mm, mid_y_mm (halfway between), back_normal_pitch_deg and front_normal_pitch_deg
(the surface normal's tilt in the side view: 0 = facing straight back / front, + = facing up), then diff (copy minus reference: back, front, depth, mid, back and front normal pitch). summary: mean and worst absolute difference of the back, front, depth and mid line, the tilt from vertical of the mid line
(a line through the mid points, hips to neck) for the copy and the reference and their difference, and the tilt of the FITTED Hips-to-Neck bone axis for comparison; rows that missed (no hit) are listed under `missed`.
A positive back diff means the copy's back is further back than the capture's.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402


def bvh_of(o):
    """from the object's own mesh data (a hidden object or collection has no evaluated mesh, so FromObject would fail); both objects are untransformed"""
    me = o.data
    me.calc_loop_triangles()
    vs = [v.co.copy() for v in me.vertices]
    tris = [tuple(t.vertices) for t in me.loop_triangles]
    return BVHTree.FromPolygons(vs, tris)


def probe(bvh, x, z, org, side, back):
    """front and back hits of the line at height z and sideways position x (metres), running along `back`, in the frame (org: the pelvis point, side, back unit vectors):
    (front_y, back_y, front_normal, back_normal) with y measured along `back` from the pelvis, or None. In the world frame: org 0, side +X, back +Y."""
    p = Vector((org[0], org[1], 0.0)) + Vector(side) * x + Vector((0, 0, z))
    f = bvh.ray_cast(p - Vector(back) * 4.0, Vector(back))
    b = bvh.ray_cast(p + Vector(back) * 4.0, -Vector(back))
    if f[0] is None or b[0] is None:
        return None
    yf = (f[0] - Vector((org[0], org[1], f[0].z))).dot(Vector(back))
    yb = (b[0] - Vector((org[0], org[1], b[0].z))).dot(Vector(back))
    return yf, yb, f[1], b[1]


def pitch(n, back_dir):
    """tilt of the surface normal in the side view (the plane of the back direction and up): 0 = facing straight back or front, + = facing up"""
    return float(np.degrees(np.arctan2(n.z, abs(n.dot(Vector(back_dir))))))


def main():
    cname = L.param("copy", "body_posed")
    cp = bpy.data.objects.get(cname)
    if cp is None:
        raise RuntimeError(f"no posed copy {cname}: run pose_fit first")
    t = float(cp.get("reference_time_s", 0.5))
    ref = None
    if L.param("reference"):
        ref = bpy.data.objects.get(L.param("reference"))
        if ref is None:
            raise RuntimeError(f"no object {L.param('reference')}")
    else:
        cands = [o for o in bpy.data.objects if o.name.startswith("MetaBody_") and abs(float(o.get("capture_time_s", -9)) - t) < 0.01]
        if not cands:
            raise RuntimeError(f"no captured mesh MetaBody_* for {t} s: run reference_import first (the bundle's poses include that instant)")
        ref = cands[0]
    s = float(cp.get("scale_to_reference", 1.0))
    for o in (cp, ref):
        if np.abs(np.array(o.matrix_world) - np.eye(4)).max() > 1e-6:
            raise RuntimeError(f"{o.name} has a transform; this check expects the objects in world coordinates with no transform")
    arm = R.find_rig()
    bpy.context.view_layer.update()
    ev = arm.evaluated_get(bpy.context.evaluated_depsgraph_get())
    def head(n):
        return np.array(arm.matrix_world @ ev.pose.bones[R.PREFIX + n].head) / s * 1000
    hips = head("Hips")
    top = L.param("to", "Neck")
    neck = head(top)
    frame = L.param("frame", "world")
    if frame not in ("world", "pelvis"):
        raise RuntimeError('frame must be "world" or "pelvis"')
    org, side, back = (0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)
    if frame == "pelvis":
        # the character's own frame at this instant, from the FITTED rig (the fit turns the pelvis to the captured one): side = right hip to left hip, flattened; back = up x side
        sv = head("LeftUpLeg") - head("RightUpLeg")
        sv[2] = 0
        sv /= np.linalg.norm(sv)
        side = (float(sv[0]), float(sv[1]), 0.0)
        bk = np.cross([0, 0, 1.0], sv)
        back = (float(bk[0]), float(bk[1]), 0.0)
        org = (float(hips[0]) / 1000, float(hips[1]) / 1000)
    zs = L.param("z_mm")
    if not zs and L.param("z_rel_mm"):
        zs = [float(hips[2] + v) for v in L.param("z_rel_mm")]
    if not zs:
        zs = [float(v) for v in np.linspace(hips[2], neck[2], int(L.param("levels", 8)))]
    xs = L.param("x_mm") or [0.0]
    bc, br = bvh_of(cp), bvh_of(ref)
    rows, missed = [], []
    for z in zs:
        for x in xs:
            a = probe(bc, x / 1000, z / 1000, org, side, back)
            b = probe(br, x / 1000, z / 1000, org, side, back)
            if a is None or b is None:
                missed.append({"z_mm": round(float(z), 1), "x_mm": x, "copy": a is not None, "reference": b is not None})
                continue

            def desc(h):
                fy, by = h[0] * 1000, h[1] * 1000
                return {"front_y_mm": round(fy, 1), "back_y_mm": round(by, 1), "depth_mm": round(by - fy, 1), "mid_y_mm": round((fy + by) / 2, 1),
                        "front_normal_pitch_deg": round(pitch(h[2], back), 1), "back_normal_pitch_deg": round(pitch(h[3], back), 1)}
            c, r = desc(a), desc(b)
            rows.append({"z_mm": round(float(z), 1), "x_mm": x, "copy": c, "reference": r, "diff": {k.replace("_mm", "").replace("_deg", ""): round(c[k] - r[k], 1) for k in c}})
    summ = {}
    if rows:
        for k in ("back_y", "front_y", "depth", "mid_y"):
            d = np.array([r["diff"][k] for r in rows])
            summ[k] = {"mean_mm": round(float(d.mean()), 1), "worst_abs_mm": round(float(np.abs(d).max()), 1)}
        mid = [r for r in rows if r["x_mm"] == xs[0]]

        def tilt(key):
            zz = np.array([r["z_mm"] for r in mid])
            yy = np.array([r[key]["mid_y_mm"] for r in mid])
            if len(zz) < 2:
                return None
            k = np.polyfit(zz, yy, 1)[0]  # dy/dz: + = the mid line leans backwards going up
            return round(float(np.degrees(np.arctan(k))), 2)
        tc, tr = tilt("copy"), tilt("reference")
        v = neck - hips
        v = np.array([float(np.dot(v, np.array(back))), 0, v[2]])  # the lean in the side view, along the frame's back direction
        summ["mid_line_tilt_deg"] = {"copy": tc, "reference": tr, "difference": round(tc - tr, 2) if tc is not None and tr is not None else None, "convention": "+ = leans backwards going up (Y is back)",
                                     "fitted_hips_to_neck_bone_axis": round(float(np.degrees(np.arctan2(v[0], v[2]))), 2)}
    L.finish({"copy": cp.name, "reference": ref.name, "time_s": t, "frame": {"name": frame, "origin_mm": [round(org[0] * 1000, 1), round(org[1] * 1000, 1)], "side": [round(c, 4) for c in side], "back": [round(c, 4) for c in back]}, "heights_mm": [round(float(z), 1) for z in zs], "rows": rows, "summary": summ, "missed": missed})


L.run(main)
