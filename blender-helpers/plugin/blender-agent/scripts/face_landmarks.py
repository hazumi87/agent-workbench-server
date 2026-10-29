"""Face landmarks from a character's FRONT view image (runs in tools/facevenv, not Blender).

    tools/facevenv/Scripts/python.exe scripts/face_landmarks.py <image> <out.json>

Writes {image:{w,h}, silhouette:{x0,y0,x1,y1} (px, non-background), landmarks:
[[x,y,z]...] (MediaPipe FaceMesh, 478 points, normalised 0..1, y down), named:{…}}.
The silhouette bbox is what map_landmarks uses to place the image onto the mesh's
front projection (Image Studio views and Mesh Studio meshes share scale/framing).
Setup (once): app/.../python.exe -m venv tools/facevenv; pip install mediapipe==0.10.21
"""
import json
import sys

import cv2
import mediapipe as mp
import numpy as np

NAMED = {  # MediaPipe FaceMesh indices
    "mouth_left": 61, "mouth_right": 291,          # image-left / image-right corners
    "lip_upper_outer": 0, "lip_upper_inner": 13,
    "lip_lower_inner": 14, "lip_lower_outer": 17,
    "nose_tip": 1, "chin": 152,
    "eye_l_upper": 159, "eye_l_lower": 145, "eye_r_upper": 386, "eye_r_lower": 374,
}
LIP_INNER_UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
LIP_INNER_LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]


def main(image, out):
    img = cv2.imread(image, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {image}")
    h, w = img.shape[:2]
    # silhouette: anything noticeably different from the corner (background) colour
    bg = np.median(np.concatenate([img[:8, :8].reshape(-1, 3), img[:8, -8:].reshape(-1, 3)]), axis=0)
    mask = np.abs(img.astype(int) - bg).sum(axis=2) > 40
    ys, xs = np.nonzero(mask)
    sil = {"x0": int(xs.min()), "y0": int(ys.min()), "x1": int(xs.max()), "y1": int(ys.max())}
    with mp.solutions.face_mesh.FaceMesh(static_image_mode=True, max_num_faces=1, refine_landmarks=True) as fm:
        res = fm.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    if not res.multi_face_landmarks:
        print(json.dumps({"ok": False, "error": "no face found"}))
        sys.exit(1)
    lm = [[p.x, p.y, p.z] for p in res.multi_face_landmarks[0].landmark]
    doc = {"image": {"w": w, "h": h, "path": image}, "silhouette": sil, "landmarks": lm,
           "named": {k: lm[i] for k, i in NAMED.items()},
           "lip_inner_upper": [lm[i] for i in LIP_INNER_UPPER], "lip_inner_lower": [lm[i] for i in LIP_INNER_LOWER]}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    n = doc["named"]
    print(json.dumps({"ok": True, "points": len(lm), "silhouette": sil,
                      "mouth_px": [[round(n[k][0] * w), round(n[k][1] * h)] for k in ("mouth_left", "lip_upper_inner", "lip_lower_inner", "mouth_right")]}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
