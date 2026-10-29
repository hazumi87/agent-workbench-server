"""_photocam - the camera of a captured video instant, shared by photo_project and photo_register (not a verb)."""
import numpy as np


def camera_for(cams, ref, t, shift=(0, 0), fscale=1.0, size=(1080, 1920)):
    c = min(cams, key=lambda x: abs(x["t_s"] - t))
    if abs(c["t_s"] - t) > 0.01:
        raise RuntimeError(f"no camera in camera-reference.json for {t} s (nearest {c['t_s']})")
    M3 = np.array(ref["coordinates"]["page_to_blender_4x4"])[:3, :3]
    Rm = np.array(c["camera_to_page_rotation_row_major"]).reshape(3, 3)
    ax = np.stack([(M3 @ Rm[:, i]) / np.linalg.norm(M3 @ Rm[:, i]) for i in range(3)], 1)  # columns: right, down, forward
    W, H = c.get("proxy_size", list(size))
    fx, fy, cx, cy = c["intrinsics_normalized"]
    return {"pos": np.array(c["position_blender"]), "ax": ax, "fx": fx * W * fscale, "fy": fy * H * fscale, "cx": cx * W + shift[0], "cy": cy * H + shift[1], "W": W, "H": H, "t": c["t_s"]}


def project(P, cam):
    pc = (P - cam["pos"]) @ cam["ax"]
    z = pc[:, 2]
    u = cam["fx"] * pc[:, 0] / z + cam["cx"]
    v = cam["fy"] * pc[:, 1] / z + cam["cy"]
    return u, v, z
