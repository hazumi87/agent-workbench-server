"""helpers shared by relief_shell and capture_project: read one view of a view_capture, project world points through its camera, test which faces it sees."""
import json
import math
import os

import numpy as np
import bpy


def read_pixels(path):
    im = bpy.data.images.load(path, check_existing=False)
    im.colorspace_settings.name = "Non-Color"
    w, h = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, im.channels)[::-1]  # row 0 = TOP
    bpy.data.images.remove(im)
    return a, w, h


def load_view(cap, view, with_colour=False, with_normal=False):
    meta = json.load(open(cap))
    cam = next((c for c in meta["cameras"] if c["name"] == view), None)
    if cam is None:
        raise RuntimeError(f"no view {view!r} in {cap} (views: {[c['name'] for c in meta['cameras']]})")
    base = os.path.dirname(cap)
    f = cam["files"]
    W, H = cam["res"]
    dep, _, _ = read_pixels(os.path.join(base, f["depth16"]))
    msk, _, _ = read_pixels(os.path.join(base, f["mask"]))
    near, far = meta["depth"]["near"], meta["depth"]["far"]
    M = np.array(cam["matrix_world"], dtype=np.float64)
    vw = {"name": view, "cap": cap, "base": base, "files": f, "W": W, "H": H, "fx": cam["intrinsics_px"]["fx"], "cx": cam["intrinsics_px"]["cx"], "cy": cam["intrinsics_px"]["cy"],
          "M": M, "Minv": np.linalg.inv(M), "loc": M[:3, 3].copy(), "near": near, "far": far, "cam": cam,
          "Z": near + dep[..., 0].astype(np.float64) * (far - near), "hit": msk[..., 0] > 0.5}
    if with_colour:
        vw["colour"], _, _ = read_pixels(os.path.join(base, f["colour"]))
    if with_normal:
        vw["normal"], _, _ = read_pixels(os.path.join(base, f["normal"]))
    return vw


def project(vw, pts):
    """world points -> (pixel u, pixel v (row from the top), z-depth along the camera axis)"""
    pc = (np.c_[pts, np.ones(len(pts))] @ vw["Minv"].T)[:, :3]
    zc = -pc[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        u = pc[:, 0] / zc * vw["fx"] + vw["cx"]
        v = vw["cy"] - pc[:, 1] / zc * vw["fx"]
    return u, v, zc


def seen(vw, cen, nrm, tol, hit=None, Z=None):
    """which faces (centres cen, unit normals nrm) this view sees: inside the picture, the pixel was hit and the face centre is within tol of the captured depth (two-sided: the normal direction does not matter). Returns (mask, pixel col, pixel row, cosine of the incidence angle)"""
    hit = vw["hit"] if hit is None else hit
    Z = vw["Z"] if Z is None else Z
    u, v, zc = project(vw, cen)
    ins = (zc > vw["near"]) & (u >= 0) & (u < vw["W"]) & (v >= 0) & (v < vw["H"])
    iu = np.clip(np.nan_to_num(u).astype(int), 0, vw["W"] - 1)
    iv = np.clip(np.nan_to_num(v).astype(int), 0, vw["H"] - 1)
    to_cam = vw["loc"][None, :] - cen
    d = np.maximum(np.linalg.norm(to_cam, axis=1), 1e-9)
    cos = np.abs((to_cam * nrm).sum(axis=1)) / d  # two-sided: source meshes have arbitrary normal directions; a face at the captured depth IS the surface the picture shows
    ok = ins & hit[iv, iu] & (np.abs(zc - Z[iv, iu]) <= tol) & (cos > 0.02)
    return ok, iu, iv, cos


def uv_of(vw, pts):
    u, v, zc = project(vw, pts)
    zs = np.maximum(zc, 1e-4)
    pc = (np.c_[pts, np.ones(len(pts))] @ vw["Minv"].T)[:, :3]
    return np.stack([(pc[:, 0] / zs * vw["fx"] + vw["cx"]) / vw["W"], 1.0 - (vw["cy"] - pc[:, 1] / zs * vw["fx"]) / vw["H"]], axis=1)


def inside_all(vw, corners):
    """corners (n, 3, 3) world points of triangles: True where ALL three corners project inside the picture in front of the camera (a triangle partly outside would smear the picture's edge texels)"""
    n = len(corners)
    u, v, zc = project(vw, corners.reshape(-1, 3))
    ok = (zc > vw["near"]) & (u >= 0) & (u < vw["W"]) & (v >= 0) & (v < vw["H"])
    return ok.reshape(n, 3).all(axis=1)
