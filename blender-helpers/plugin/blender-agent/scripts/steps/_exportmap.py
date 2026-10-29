"""_exportmap - the GLB export map, shared by export_rig, export_bind, export_static and export_kit (not a verb).

capture(objs)  before the export: what Blender has (name, type, mesh data, parent, matrix_world, world bounding box in metres, material names)
write(path, snap, verb, ...)  after it: reads the GLB, matches its nodes to the objects, recomposes each node's world transform back into the Blender frame and writes <glb>.map.json next to the GLB.
Conventions (also in docs/OPERATOR-VERBS.md): every 4x4 matrix is a list of 4 ROWS (row i = [m_i0, m_i1, m_i2, m_i3]); vectors are COLUMN vectors, p_out = M @ [x, y, z, 1]^T, so the translation is the last element of each of the first three rows; units are metres.
"""
import hashlib
import json
import os
import struct

import numpy as np

# Blender world (x, y, z; Z up) -> glTF world (x, z, -y; Y up), the exporter's conversion (export_yup=True)
C_B2G = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], float)
C_G2B = np.linalg.inv(C_B2G)
MARKER_PROP = "blender_agent_marker"


def _rows(m):
    return [[round(float(x), 7) for x in r] for r in np.array(m)]


def capture(objs):
    import bpy
    snap = []
    for o in objs:
        mw = np.array(o.matrix_world)
        try:
            bb = np.array([mw @ np.array([c[0], c[1], c[2], 1.0]) for c in o.bound_box])[:, :3]
            bounds = [[round(float(x), 5) for x in bb.min(0)], [round(float(x), 5) for x in bb.max(0)]]
        except Exception:
            bounds = None
        snap.append({"name": o.name, "type": o.type, "mesh_data": o.data.name if o.data is not None and o.type == "MESH" else None, "parent": o.parent.name if o.parent else None,
                     "parent_type": o.parent_type if o.parent else None, "matrix_world": _rows(mw), "world_bounds_m": bounds,
                     "materials": [m.name for m in o.data.materials if m] if o.type == "MESH" else []})
    return snap


def read_glb_json(path):
    with open(path, "rb") as f:
        b = f.read()
    n = struct.unpack_from("<I", b, 12)[0]
    return json.loads(b[20:20 + n].decode("utf8"))


def _local(node):
    if "matrix" in node:
        return np.array(node["matrix"], float).reshape(4, 4).T  # glTF stores column-major
    t = np.array(node.get("translation", [0, 0, 0]), float)
    q = np.array(node.get("rotation", [0, 0, 0, 1]), float)
    s = np.array(node.get("scale", [1, 1, 1]), float)
    x, y, z, w = q / max(np.linalg.norm(q), 1e-12)
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4)
    M[:3, :3] = R * s
    M[:3, 3] = t
    return M


def write(path, snap, verb, job=None, step=None, scale_confidence="unknown", scale_note=None):
    js = read_glb_json(path)
    nodes = js.get("nodes", [])
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    world = {}

    def w(i):
        if i not in world:
            world[i] = (w(parent[i]) if i in parent else np.eye(4)) @ _local(nodes[i])
        return world[i]
    joints = {j for s in js.get("skins", []) for j in s.get("joints", [])}
    by_name = {}
    for i, n in enumerate(nodes):
        by_name.setdefault(n.get("name"), []).append(i)
    entries, used = [], set()
    max_t, max_b = 0.0, 0.0
    max_b_nl, max_b_l, light_rot, n_lights = 0.0, 0.0, 0.0, 0
    for o in snap:
        cand = [i for i in by_name.get(o["name"], []) if i not in used]
        e = {"blender": o, "glb_node": None}
        if len(cand) >= 1:
            i = cand[0]
            used.add(i)
            Wg = w(i)
            Wb = C_G2B @ Wg @ C_B2G  # the node's world transform expressed in the Blender frame (a conjugation: the vertices were converted by the exporter, the node matrices are carried over)
            mw = np.array(o["matrix_world"])
            dt = float(np.abs(Wb[:3, 3] - mw[:3, 3]).max()) * 1000
            db = float(np.abs(Wb[:3, :3] - mw[:3, :3]).max())
            max_t, max_b = max(max_t, dt), max(max_b, db)
            if o["type"] == "LIGHT":
                n_lights += 1
                max_b_l = max(max_b_l, db)
                R = Wb[:3, :3] @ np.linalg.inv(mw[:3, :3])  # the rotation between the node's recomposed basis and the Blender object's own
                light_rot = max(light_rot, float(np.degrees(np.arccos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))))
            else:
                max_b_nl = max(max_b_nl, db)
            e["glb_node"] = {"index": i, "name": nodes[i].get("name"), "world_matrix_glb": _rows(Wg), "recomposed_blender_matrix_world": _rows(Wb), "max_translation_diff_mm": round(dt, 4), "max_basis_diff": round(db, 7),
                             "mesh": nodes[i].get("mesh"), "skin": nodes[i].get("skin"), "name_matches_exactly": True, "duplicate_names_in_glb": len(by_name.get(o["name"], [])) > 1}
        entries.append(e)
    glb_nodes = []
    for i, n in enumerate(nodes):
        d = {"index": i, "name": n.get("name"), "children": n.get("children", []), "parent": parent.get(i), "mesh": n.get("mesh"), "skin": n.get("skin"), "is_skin_joint": i in joints}
        for k in ("matrix", "translation", "rotation", "scale"):
            if k in n:
                d[k] = n[k]
        d["local_matrix_glb"] = _rows(_local(n))
        d["world_matrix_glb"] = _rows(w(i))
        glb_nodes.append(d)
    with open(path, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    unmatched_b = [e["blender"]["name"] for e in entries if e["glb_node"] is None]
    unmatched_g = [d["index"] for d in glb_nodes if d["index"] not in used and not d["is_skin_joint"]]
    m = {"format": "blender-agent.glb-map", "version": 1,
         "glb": {"file": os.path.basename(path), "bytes": os.path.getsize(path), "sha256": sha},
         "export": {"verb": verb, "job": job, "step": step},
         "frame": {"blender_world": "the Blender scene's world frame: Z up, units metres; for a video-to-3d reference job it is the shared reference frame (floor z = 0, +X left, +Y back, +Z up)",
                   "glb_scene": "glTF 2.0: Y up, -Z forward (+Z toward the viewer), units metres, right-handed", "blender_to_glb_matrix": _rows(C_B2G), "glb_to_blender_matrix": _rows(C_G2B),
                   "conversion": "p_glb = C_B2G @ p_blender, i.e. (x, y, z)_B -> (x, z, -y)_G; a node's world matrix goes back by W_B = C_G2B @ W_G @ C_B2G",
                   "export_options": {"export_yup": True, "export_apply": False}},
         "conventions": {"matrix_storage": "a list of 4 rows; row i = [m_i0, m_i1, m_i2, m_i3]", "vectors": "column vectors: p_out = M @ [x, y, z, 1]^T (the translation is the last element of each of the first three rows)", "units": "metres",
                         "glb_node_matrix_field": "a glTF node's own 'matrix' array is column-major; it is copied as given, and local_matrix_glb / world_matrix_glb are in the row-list convention above"},
         "scale_confidence": scale_confidence, "scale_note": scale_note,
         "to_blender_from_a_glb_point": "p_B = C_G2B @ [x, y, z, 1] for a point already in the GLB scene frame (G); a point in a node's mesh-local coordinates goes through that node's world_matrix_glb first, then C_G2B",
         "objects": entries, "glb_nodes": glb_nodes, "unmatched_blender_objects": unmatched_b, "unmatched_glb_nodes_not_joints": unmatched_g,
         "summary": {"objects": len(snap), "matched": len(snap) - len(unmatched_b), "max_translation_diff_mm": round(max_t, 4), "max_basis_diff": round(max_b, 7), "glb_nodes": len(nodes), "skin_joint_nodes": len(joints),
                     "max_basis_diff_excluding_lights": round(max_b_nl, 7), "light_nodes": n_lights, "max_basis_diff_lights": round(max_b_l, 7), "light_basis_rotation_deg": round(light_rot, 2),
                     "light_note": "a light node's own axes can differ from the Blender object's by a fixed rotation (the exporter turns a light so that it shines along its node's -Z); a POINT light radiates equally in every direction, so that rotation does not matter for it; for a spot light it would. Positions of lights match like every other node."}}
    mp = path + ".map.json"
    with open(mp, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=1)
    return {"file": os.path.basename(mp), **m["summary"], "unmatched_blender_objects": unmatched_b, "scale_confidence": scale_confidence, "sha256": sha}
