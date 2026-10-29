"""shared by lightmap_bake / lightmap_check / lightmap_fixture: the target loader contract v1.1 manifest (exact field names, the user/the target runtime )"""
import hashlib
import os


def sha(b):
    return hashlib.sha256(b).hexdigest()


def meta(path):
    b = open(path, "rb").read()
    return {"name": os.path.basename(path), "bytes": len(b), "sha256": sha(b)}


def hearth_manifest(width, height, layers, fixtures, pose, pose_angles, receivers, padding_texels, clamped_texels, bin_path, mask_path, glb_path, radius=0.0, dmin=0.1):
    """exact the target runtime v1.1 field names; byte_order and row_origin are the machine values ("little", "gltf_v0"); `fixtures` is padded with null to 4 per layer"""
    padded = list(fixtures) + [None] * (layers * 4 - len(fixtures))
    return {"version": "1.1", "width": width, "height": height, "layers": layers, "fixtures": padded, "pose": pose, "pose_angles": pose_angles,
            "byte_order": "little", "row_origin": "gltf_v0", "scale": 1.0, "emitter_radius_m": radius, "d_min_m": dmin, "distance_cutoff_m": 0, "decay": 2, "uv_channel": "TEXCOORD_1",
            "receivers": receivers, "padding_texels": padding_texels, "clamped_texels": clamped_texels, "design_fixture_order": list(fixtures),
            "bin": meta(bin_path), "mask": meta(mask_path), "glb": meta(glb_path)}
