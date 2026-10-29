"""points_import — bring a coloured POINT CLOUD (a .ply file, ascii or binary) into the job's scene as a reference object, measure it, and draw CPU pictures of it. Saves a checkpoint (the points stay in the scene as the object `name`, hidden from renders, so later steps and `blockout` can be placed against them).

For a room scan such as the video-to-3d bundle's room-context.ply (100,000 coloured static points "in the same Blender frame": floor z = 0, +X left, +Y back, +Z up, metres): the points are NOT moved or scaled (the frame is kept as it is in the file; `scale` is only for a file in other units). Nothing in the file is modified or saved back.

params:
  (a job whose first step this is starts from Blender's factory scene: its default Cube, Light and Camera are removed; a job that already has a scene is not touched except for the added object)
  file     the .ply: a path under the tool root (e.g. "downloads/bundles/my-bundle/room-context.ply") or absolute, or a Library id
  name     the object (default "room_points")
  scale    multiply every coordinate by this (default 1: the file is already in metres)
  region   [[xmin, ymin, zmin], [xmax, ymax, zmax]] metres: keep only points inside (default all)
  measure  true (default): bounds, per-axis percentiles, the colour, height-histogram peaks (floor / ceiling / table-top candidates), and wall candidates (peaks of the x and y histograms in the band wall_band_m, default [0.3, 2.0] m), all with the number of points behind each so you can judge them
  bin_m    histogram bin (default 0.02 m)
  boxes    [{"name": "cabinet", "min": [x, y, z], "max": [x, y, z]}]: how many points lie in each box, their bounds and mean colour (a way to check a placed piece against the points)
  views    pictures: "top" | "front" | "back" | "side" | "iso" | {"name": "mine", "dir": [x, y, z]} (the direction from the scene to the camera); default ["top", "front"]. `crop` [[xmin, ymin, zmin], [xmax, ymax, zmax]] limits what is drawn; res px (default 900); point_px (default 2: the size of a drawn point); grid_m (default 1: grid lines, with a heavier line every 5)
Each picture is an orthographic splat of the points (nearest point wins), CPU only, and the report gives its mapping: px_per_m, the pixel of the world point `centre_m`, and the right / up axes in world coordinates, so a position in a picture converts to metres exactly.
Returns: points (count, kept), bounds_m, percentiles_m, mean_colour, peaks (z, x, y), boxes, views (file + mapping), the object, notes. Reads only (apart from adding the object).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import uv_common as UC  # noqa: E402

PLY_TYPES = {"char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "i2", "int16": "i2", "ushort": "u2", "uint16": "u2", "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4",
             "float": "f4", "float32": "f4", "double": "f8", "float64": "f8"}


def read_ply(path):
    with open(path, "rb") as f:
        raw = f.read()
    end = raw.index(b"end_header")
    nl = raw.index(b"\n", end) + 1
    head = raw[:nl].decode("ascii", "replace").splitlines()
    fmt = next(l.split()[1] for l in head if l.startswith("format"))
    nv, props, in_vertex = 0, [], False
    for l in head:
        p = l.split()
        if p[:2] == ["element", "vertex"]:
            nv, in_vertex = int(p[2]), True
        elif p[:1] == ["element"]:
            in_vertex = False
        elif p[:1] == ["property"] and in_vertex:
            if p[1] == "list":
                raise RuntimeError("a list property on the vertex element is not supported")
            props.append((p[2], PLY_TYPES[p[1]]))
    if fmt == "ascii":
        arr = np.loadtxt(raw[nl:].decode("ascii").splitlines()[:nv], dtype=np.float64, ndmin=2)
        data = {n: arr[:, i] for i, (n, _) in enumerate(props)}
    elif fmt in ("binary_little_endian", "binary_big_endian"):
        pre = "<" if fmt == "binary_little_endian" else ">"
        dt = np.dtype([(n, pre + t) for n, t in props])
        a = np.frombuffer(raw, dtype=dt, count=nv, offset=nl)
        data = {n: a[n] for n, _ in props}
    else:
        raise RuntimeError(f"unsupported ply format {fmt}")
    P = np.stack([np.asarray(data["x"], np.float64), np.asarray(data["y"], np.float64), np.asarray(data["z"], np.float64)], 1)
    if all(c in data for c in ("red", "green", "blue")):
        C = np.stack([np.asarray(data[c], np.float64) for c in ("red", "green", "blue")], 1)
        C = C / 255.0 if C.max() > 1.5 else C
    else:
        C = np.full((len(P), 3), 0.6)
    return P, C


def peaks(vals, bin_m, lo, hi, top=6, min_frac=0.004):
    """strong peaks of a 1-D histogram: (position, points within one bin either side)"""
    n = max(int(round((hi - lo) / bin_m)), 1)
    h, e = np.histogram(vals, bins=n, range=(lo, hi))
    hs = h + np.roll(h, 1) + np.roll(h, -1)
    out, used = [], np.zeros(n, bool)
    for i in np.argsort(-hs):
        if hs[i] < min_frac * max(len(vals), 1) or len(out) >= top:
            break
        if used[max(i - 4, 0):i + 5].any():
            continue
        used[i] = True
        out.append({"at_m": round(float((e[i] + e[i + 1]) / 2), 3), "points": int(hs[i])})
    return sorted(out, key=lambda x: x["at_m"])


def splat(P, C, ctr, d, res, size_m, pt, grid_m, path):
    d = d / np.linalg.norm(d)
    right = np.cross(np.array([0, 0, 1.0]), d)
    if np.linalg.norm(right) < 1e-6:
        right = np.array([1.0, 0, 0])
    right /= np.linalg.norm(right)
    up = np.cross(d, right)
    q = P - ctr
    a, b, z = q @ right, q @ up, q @ d
    s = res / size_m
    px = (a * s + res / 2).astype(int)
    py = (res / 2 - b * s).astype(int)
    img = np.full((res, res, 3), 0.1, np.float32)
    ok = (px >= 0) & (px < res) & (py >= 0) & (py < res)
    order = np.argsort(z[ok])  # far first, near last: the nearest point wins
    xs, ys, cs = px[ok][order], py[ok][order], C[ok][order]
    for dx in range(pt):
        for dy in range(pt):
            img[np.clip(ys + dy, 0, res - 1), np.clip(xs + dx, 0, res - 1)] = cs
    # grid: lines of the world axes visible in this view, every grid_m (heavier every 5)
    if grid_m:
        for axis, vec in ((0, right), (1, up)):
            lo = -size_m / 2
            k0 = int(np.floor(lo / grid_m))
            for k in range(k0, k0 + int(size_m / grid_m) + 2):
                pos = int(round(k * grid_m * s + res / 2))
                if 0 <= pos < res:
                    col = (0.9, 0.9, 0.2) if k % 5 == 0 else (0.4, 0.4, 0.5)
                    if axis == 0:
                        img[:, pos] = np.where(img[:, pos].sum(1, keepdims=True) < 0.35, col, img[:, pos] * 0.8 + np.array(col) * 0.2)
                    else:
                        img[pos, :] = np.where(img[pos, :].sum(1, keepdims=True) < 0.35, col, img[pos, :] * 0.8 + np.array(col) * 0.2)
    UC.save_image(img, path, "sRGB")
    return {"px_per_m": round(float(s), 2), "centre_m": [round(float(x), 4) for x in ctr], "centre_px": [res // 2, res // 2], "right_axis": [round(float(x), 4) for x in right], "up_axis": [round(float(x), 4) for x in up],
            "view_dir": [round(float(x), 4) for x in d], "width_m": round(float(size_m), 3), "convert": "metres = centre_m + right_axis * (px - centre_px.x) / px_per_m + up_axis * (centre_px.y - py) / px_per_m  (the depth along view_dir is not in the picture)"}


def main():
    src = L.param("file")
    if not src:
        raise RuntimeError("give `file` (a .ply)")
    path = L.resolve(src, what="file")
    P, C = read_ply(path)
    n0 = len(P)
    P = P * float(L.param("scale", 1.0))
    rg = L.param("region")
    if rg:
        lo, hi = np.array(rg[0], float), np.array(rg[1], float)
        m = ((P >= lo) & (P <= hi)).all(1)
        P, C = P[m], C[m]
    name = L.param("name", "room_points")
    removed_default = []
    if not L.ARGS.get("input"):  # a fresh job starts from Blender's factory scene: its default cube, light and camera are not wanted
        for on in ("Cube", "Light", "Camera"):
            o = bpy.data.objects.get(on)
            if o is not None:
                bpy.data.objects.remove(o, do_unlink=True)
                removed_default.append(on)
    out = {"points": {"in_file": int(n0), "kept": int(len(P))}, "object": None, "factory_objects_removed": removed_default}
    # ---- the object: loose vertices with a colour attribute, hidden from renders
    if name in bpy.data.objects:
        raise RuntimeError(f"{name} exists already: choose another name (nothing is replaced)")
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(P))
    me.vertices.foreach_set("co", P.astype(np.float32).ravel())
    me.update()
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    ca.data.foreach_set("color", np.concatenate([C, np.ones((len(C), 1))], 1).astype(np.float32).ravel())
    obj = bpy.data.objects.new(name, me)
    col = bpy.data.collections.get("reference-points") or bpy.data.collections.new("reference-points")
    if col.name not in [c.name for c in bpy.context.scene.collection.children]:
        bpy.context.scene.collection.children.link(col)
    col.objects.link(obj)
    obj.hide_render = True
    obj["points_source"] = os.path.basename(path)
    out["object"] = {"name": name, "vertices": int(len(P)), "collection": col.name, "hidden_from_renders": True, "frame": "as in the file (not moved or scaled unless `scale` was given)"}
    if len(P) == 0:
        L.finish(out, save=True)
        return
    if L.param("measure", True):
        bn = float(L.param("bin_m", 0.02))
        mn, mx = P.min(0), P.max(0)
        out["bounds_m"] = {"min": [round(float(x), 3) for x in mn], "max": [round(float(x), 3) for x in mx], "size": [round(float(x), 3) for x in (mx - mn)]}
        out["percentiles_m"] = {ax: {str(p): round(float(np.percentile(P[:, i], p)), 3) for p in (1, 5, 50, 95, 99)} for i, ax in enumerate("xyz")}
        out["mean_colour"] = [round(float(x), 3) for x in C.mean(0)]
        wb = L.param("wall_band_m", [0.3, 2.0])
        band = (P[:, 2] >= wb[0]) & (P[:, 2] <= wb[1])
        out["peaks"] = {"z": peaks(P[:, 2], bn, float(mn[2]), float(mx[2]) + 1e-6), "x_in_band": peaks(P[band, 0], bn, float(mn[0]), float(mx[0]) + 1e-6) if band.any() else [],
                        "y_in_band": peaks(P[band, 1], bn, float(mn[1]), float(mx[1]) + 1e-6) if band.any() else [], "wall_band_m": wb,
                        "note": "a peak is where many points share one height / x / y: flat floors, ceilings, tables, walls. They are candidates to check in the pictures, not surveyed values"}
    if L.param("measure", True) and band.any():
        # the room is rarely square to the world axes: the angle that makes the walls sharpest (the histograms of the rotated coordinates u, v peak most), and the wall candidates along those axes
        xy = P[band][:, :2]
        best = (-1.0, 0.0)
        for deg in np.arange(-45.0, 45.01, 0.5):
            t = np.radians(deg)
            u_ = xy[:, 0] * np.cos(t) + xy[:, 1] * np.sin(t)
            v_ = -xy[:, 0] * np.sin(t) + xy[:, 1] * np.cos(t)
            sc = sum(float((np.histogram(a, bins=max(int(np.ptp(a) / 0.05), 1))[0].astype(float) ** 2).sum()) for a in (u_, v_))
            if sc > best[0]:
                best = (sc, float(deg))
        t = np.radians(best[1])
        u_ = xy[:, 0] * np.cos(t) + xy[:, 1] * np.sin(t)
        v_ = -xy[:, 0] * np.sin(t) + xy[:, 1] * np.cos(t)
        out["peaks"]["room_yaw"] = {"yaw_deg": best[1], "u_axis_world": [round(float(np.cos(t)), 4), round(float(np.sin(t)), 4)], "v_axis_world": [round(float(-np.sin(t)), 4), round(float(np.cos(t)), 4)],
                                    "u_peaks": peaks(u_, float(L.param("bin_m", 0.02)), float(u_.min()), float(u_.max()) + 1e-6), "v_peaks": peaks(v_, float(L.param("bin_m", 0.02)), float(v_.min()), float(v_.max()) + 1e-6),
                                    "note": "u = x cos(yaw) + y sin(yaw), v = -x sin(yaw) + y cos(yaw): walls parallel to the room's own axes show as sharp peaks in u and v"}
    bx = []
    for b in (L.param("boxes") or []):
        lo, hi = np.array(b["min"], float), np.array(b["max"], float)
        m = ((P >= lo) & (P <= hi)).all(1)
        r = {"name": b.get("name"), "points": int(m.sum())}
        if m.any():
            r["bounds_m"] = [[round(float(x), 3) for x in P[m].min(0)], [round(float(x), 3) for x in P[m].max(0)]]
            r["mean_colour"] = [round(float(x), 3) for x in C[m].mean(0)]
        bx.append(r)
    out["boxes"] = bx
    files, vws = [], {}
    views = L.param("views") or ["top", "front"]
    cr = L.param("crop")
    if cr:
        lo, hi = np.array(cr[0], float), np.array(cr[1], float)
        m = ((P >= lo) & (P <= hi)).all(1)
        Pv, Cv = P[m], C[m]
    else:
        Pv, Cv = P, C
    if len(Pv):
        mn, mx = Pv.min(0), Pv.max(0)
        ctr = (mn + mx) / 2
        ext = float(np.ptp(Pv, axis=0).max()) * 1.05
        dirs = {"top": np.array([0, 0, 1.0]), "front": np.array([0, -1.0, 0]), "back": np.array([0, 1.0, 0]), "side": np.array([-1.0, 0, 0]), "iso": np.array([-0.55, -0.75, 0.6])}
        os.makedirs(L.ARGS["out_dir"], exist_ok=True)
        for v in views:
            nm, d = (v["name"], np.array(v["dir"], float)) if isinstance(v, dict) else (v, dirs[v])
            if np.isclose(abs(d[2]) / np.linalg.norm(d), 1.0):
                d = d + np.array([0, 1e-6, 0])
            p = os.path.join(L.ARGS["out_dir"], f"points-{nm}.png")
            vws[nm] = {"file": os.path.basename(p), **splat(Pv, Cv, ctr, d, int(L.param("res", 900)), ext, int(L.param("point_px", 2)), float(L.param("grid_m", 1.0)), p)}
            files.append(p)
    out["views"] = vws
    out["notes"] = ["the frame is the file's own; peaks and boxes are measurements of the points, not of the room: unseen surfaces are not in the cloud"]
    L.finish(out, save=True, files=files)


L.run(main)
