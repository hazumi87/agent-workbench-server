"""mouth_cut — give a closed-mouth (shape-only) head a real mouth: a thin slot cut
along the lip line, dark inside, with simple teeth and a tongue tucked in so they
show only when the jaw opens (mouth_keys). The lip line comes from face
landmarks on the character's FRONT view (scripts/face_landmarks.py).

Image -> mesh, then each point is ray-cast from the front (-Y) onto the surface:
  - with `camera` (render_front's camera.json; landmarks found on THAT render):
    exact orthographic mapping — preferred
  - without: the view's silhouette bbox maps onto the mesh's front bbox (x, z).
    Only as good as the drawing-vs-mesh framing (~1 cm low on the bust).

params:
  landmarks    path to face_landmarks.py output                            [required]
  camera       path to render_front's <name>.camera.json (optional, preferred)
  snap_mm      then snap each lip point to the deepest crease within ±snap_mm
               vertically (the landmark line is a prior; the mesh has the crease),
               default 6; 0 = off
  depth        slot depth at the centre as a fraction of mouth width, default 0.32
  gap_mm       slot height (the closed lips' gap), default 0.3
  densify      subdivision passes over the mouth region before cutting, default 1
  teeth        default true
  tongue       default true
Stores mesh["mouth"] (lip line, corners, nose z, depth) for mouth_keys.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402


def material(name, rgb, rough=0.6):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = rough
    return m


def mesh_from(name, verts, faces, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)  # outward, as the exact boolean wants
    bm.to_mesh(me)
    bm.free()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


def sweep(name, rings, mat):
    """A closed tube through rings of 4 corners each (same winding) + end caps."""
    verts = [v for r in rings for v in r]
    faces = []
    for i in range(len(rings) - 1):
        a, b = 4 * i, 4 * (i + 1)
        for k in range(4):
            faces.append((a + k, a + (k + 1) % 4, b + (k + 1) % 4, b + k))
    n = len(rings) - 1
    faces.append((3, 2, 1, 0))
    faces.append((4 * n, 4 * n + 1, 4 * n + 2, 4 * n + 3))
    return mesh_from(name, verts, faces, mat)


def main():
    mesh = L.the_mesh()
    with open(L.resolve(L.param("landmarks")), encoding="utf-8") as f:
        lm = json.load(f)
    W, Hh, sil = lm["image"]["w"], lm["image"]["h"], lm["silhouette"]
    lo, hi = L.world_bbox([mesh])

    cam = None
    if L.param("camera"):
        with open(L.resolve(L.param("camera")), encoding="utf-8") as f:
            cam = json.load(f)

    def to_xz(p):  # normalised image point -> mesh (x, z)
        if cam:
            return cam["center"][0] + (p[0] - 0.5) * cam["scale"], cam["center"][2] - (p[1] - 0.5) * cam["scale"]
        px, py = p[0] * W, p[1] * Hh
        x = lo.x + (px - sil["x0"]) / (sil["x1"] - sil["x0"]) * (hi.x - lo.x)
        z = lo.z + (sil["y1"] - py) / (sil["y1"] - sil["y0"]) * (hi.z - lo.z)
        return x, z

    bvh = BVHTree.FromPolygons([v.co.copy() for v in mesh.data.vertices], [tuple(p.vertices) for p in mesh.data.polygons])

    def surface(x, z):
        hit, *_ = bvh.ray_cast(Vector((x, lo.y - 0.05, z)), Vector((0, 1, 0)))
        if hit is None:
            raise RuntimeError(f"no surface at x={x:.4f} z={z:.4f}")
        return hit

    # lip line = midpoints of the inner upper/lower lip, corner to corner
    line = []
    for up, dn in zip(lm["lip_inner_upper"], lm["lip_inner_lower"]):
        x, z = to_xz(((up[0] + dn[0]) / 2, (up[1] + dn[1]) / 2))
        line.append(surface(x, z))
    line.sort(key=lambda p: p.x)
    snap = float(L.param("snap_mm", 6)) / 1000.0
    snapped = 0
    if snap > 0:
        step = 0.00025
        zs = []
        for p in line:
            samples = []
            z = p.z - snap
            while z <= p.z + snap:
                samples.append((surface(p.x, z).y, z))
                z += step
            best_i = max(range(len(samples)), key=lambda i: samples[i][0])
            k = int(0.0015 / step)
            nb = [samples[j][0] for j in (best_i - k, best_i + k) if 0 <= j < len(samples)]
            # a real crease: deeper than the surface 1.5 mm above and below it
            if len(nb) == 2 and all(samples[best_i][0] - y > 0.0002 for y in nb):
                zs.append(samples[best_i][1])
                snapped += 1
            else:
                zs.append(p.z)
        zs = [sorted(zs[max(0, i - 1):i + 2])[len(zs[max(0, i - 1):i + 2]) // 2] for i in range(len(zs))]  # 3-tap median
        line = [surface(p.x, z) for p, z in zip(line, zs)]
    width = line[-1].x - line[0].x
    xc = (line[0].x + line[-1].x) / 2
    depth_c = float(L.param("depth", 0.32)) * width
    t = float(L.param("gap_mm", 0.3)) / 2000.0
    nose_x, nose_z = to_xz(lm["named"]["nose_tip"])
    chin_x, chin_z = to_xz(lm["named"]["chin"])

    def depth_at(x):  # elliptical: deep in the middle, shallow at the corners
        u = min(1.0, abs(x - xc) / (width / 2))
        return max(0.0015, depth_c * math.sqrt(max(0.0, 1 - u * u)))

    m_int = material("MouthInterior", (0.12, 0.02, 0.025), 0.8)
    m_teeth = material("Teeth", (0.85, 0.83, 0.76), 0.35)
    m_tongue = material("Tongue", (0.55, 0.18, 0.2), 0.5)

    # 0. densify the mouth region so the opening deforms smoothly (the decimated face
    #    has ~3 mm edges there; jawOpen stretched them into streaks)
    zc_ = line[len(line) // 2].z
    yc_ = line[len(line) // 2].y
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    region = set()
    for f in bm.faces:
        c = f.calc_center_median()
        if (((c.x - xc) / (1.3 * width)) ** 2 + ((c.z - zc_) / (0.9 * width)) ** 2 < 1.0
                and c.y < yc_ + depth_c):
            region.add(f)
    edges = list({e for f in region for e in f.edges})
    for _ in range(int(L.param("densify", 1))):
        res = bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
        edges = [e for e in res["geom"] if isinstance(e, bmesh.types.BMEdge)]
    densified = len(region)
    bm.to_mesh(mesh.data)
    bm.free()
    mesh.data.update()

    # 1. the slot: a thin closed tube along the lip line, subtracted from the head
    rings = []
    for p in line:
        yf, yb = p.y - 0.006, p.y + depth_at(p.x)
        rings.append([Vector((p.x, yf, p.z + t)), Vector((p.x, yb, p.z + t)),
                      Vector((p.x, yb, p.z - t)), Vector((p.x, yf, p.z - t))])
    cutter = sweep("MouthCutter", rings, m_int)
    if not mesh.data.materials:  # shape-only input: give the skin its own slot 0 first
        mesh.data.materials.append(material("Skin", (0.8, 0.8, 0.8), 0.6))
    if m_int.name not in [m.name for m in mesh.data.materials if m]:
        mesh.data.materials.append(m_int)
    L.activate(mesh)
    faces_before = len(mesh.data.polygons)
    mod = mesh.modifiers.new("MouthCut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    mod.material_mode = "TRANSFER"
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    interior = mesh.data.materials.find("MouthInterior")
    slot_faces = sum(1 for p in mesh.data.polygons if p.material_index == interior)
    if slot_faces == 0:
        raise RuntimeError("boolean cut produced no interior faces (lip line missed the surface?)")

    parts = []
    inner = [p for p in line if abs(p.x - xc) < 0.42 * width]
    if L.param("teeth", True):
        def teeth(name, dy, z0, z1, th=0.0012):
            rs = [[Vector((p.x, p.y + dy, p.z + z1)), Vector((p.x, p.y + dy + th, p.z + z1)),
                   Vector((p.x, p.y + dy + th, p.z + z0)), Vector((p.x, p.y + dy, p.z + z0))] for p in inner]
            return sweep(name, rs, m_teeth)
        # hidden inside the lips when closed; they show as the jaw opens (and a
        # little at the "slightly open" rest)
        parts.append(teeth("TeethUpper", 0.004, -0.004, 0.002))
        parts.append(teeth("TeethLower", 0.0055, -0.003, 0.002))
    if L.param("tongue", True):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=1.0)
        for v in bm.verts:
            v.co = Vector((xc + v.co.x * 0.28 * width, line[len(line) // 2].y + 0.55 * depth_c + v.co.y * 0.3 * depth_c,
                           line[len(line) // 2].z - 0.0022 + v.co.z * 0.0018))
        me = bpy.data.meshes.new("Tongue")
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new("Tongue", me)
        bpy.context.scene.collection.objects.link(ob)
        ob.data.materials.append(m_tongue)
        parts.append(ob)

    part_names = [o.name for o in parts]
    for o in parts:  # which side of the mouth each part rides with (mouth_keys)
        vg = o.vertex_groups.new(name="mouth_upper" if o.name.startswith("TeethUpper") else "mouth_lower")
        vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
    if parts:
        bpy.ops.object.select_all(action="DESELECT")
        for o in parts:
            o.select_set(True)
        mesh.select_set(True)
        bpy.context.view_layer.objects.active = mesh
        bpy.ops.object.join()

    mesh["mouth"] = json.dumps({
        "line": [[round(c, 5) for c in p] for p in line], "width": width, "center_x": xc,
        "depth_c": depth_c, "gap": 2 * t, "nose_z": nose_z, "chin_z": chin_z,
    })
    L.finish({"mapping": "camera" if cam else "silhouette", "snapped": f"{snapped}/{len(line)}", "mouth_width_mm": round(width * 1000, 1), "depth_mm": round(depth_c * 1000, 1),
              "lip_z": round(line[len(line) // 2].z, 4), "nose_z": round(nose_z, 4), "chin_z": round(chin_z, 4),
              "slot_faces": slot_faces, "densified_faces": densified, "faces_before": faces_before, "faces": len(mesh.data.polygons),
              "parts": part_names}, save=True)


L.run(main)
