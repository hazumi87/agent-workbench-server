"""source_slim — write a SMALLER COPY of the job's current checkpoint to out/<name>.blend for publishing as an editable source, with the scene unchanged. Saves NO checkpoint (the job is not changed).

Only one thing is done: every packed PNG picture is recompressed LOSSLESSLY (the same pixels, a tighter deflate stream; metadata chunks are kept); a recompressed picture is used only if it is smaller and its decompressed scanlines are byte-identical to the original's. No geometry, material, light, name or setting is touched; no picture is resized. Nothing else is removed (orphan data is only reported, never purged).
Use it when the Library refuses a source upload with `413 Request Entity Too Large` (the Library's front door takes at most 105 MB = 110,100,480 bytes per file). The report says whether the copy fits, and how much the pictures gave. If it still does not fit, nothing else is shrunk behind your back: the report lists the largest pictures so you can decide.
params:
  name       file stem of the copy (default "<job>-source-slim"); written to work/<job>/out/<name>.blend
  drop_archives  true: leave the scenes made by `scene_archive` (named `archive__<tag>`) OUT OF THE COPY, with everything only they use (meshes, materials, pictures): a delivery copy of the current scene. The job's checkpoints and the archives in them are never touched (the copy is saved from memory). Default false.
  dry_run    true: measure only, write nothing
Returns: dropped (with drop_archives: the scenes left out, the active scene kept, how many packed pictures and bytes went with them), source_bytes (the checkpoint file), copy_bytes, limit_bytes, fits, pictures (count, recompressed, bytes_before, bytes_after, the 6 biggest savings), orphans (counts of datablocks with no user: reported only), notes.
Then attach it to the already-published GLB with `publish` {"source_to": "<GLB id>", "source_file": "<name>.blend", "label": "...", "room": {...}}: no second GLB is created.
"""
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402

LIMIT = 105 * 1024 * 1024
SIG = b"\x89PNG\r\n\x1a\n"


def chunks(b):
    i = 8
    while i < len(b):
        n = struct.unpack(">I", b[i:i + 4])[0]
        yield b[i + 4:i + 8], b[i + 8:i + 8 + n]
        i += 12 + n


def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


def recompress(b):
    """the same PNG with its image data deflated at level 9 as ONE IDAT; None when it is not a plain PNG or the result is not smaller / not identical"""
    if b[:8] != SIG:
        return None
    parts = list(chunks(b))
    idat = b"".join(d for t, d in parts if t == b"IDAT")
    raw = zlib.decompress(idat)
    new = zlib.compress(raw, 9)
    if zlib.decompress(new) != raw:
        return None
    out, done = [SIG], False
    for t, d in parts:
        if t == b"IDAT":
            if not done:
                out.append(chunk(b"IDAT", new))
                done = True
        else:
            out.append(chunk(t, d))
    res = b"".join(out)
    return res if len(res) < len(b) else None


def main():
    job = L.ARGS["job"]
    name = L.param("name") or f"{job}-source-slim"
    if not name.replace("-", "").replace("_", "").replace(".", "").isalnum():
        raise RuntimeError("name: letters, digits, - _ . only")
    dry = bool(L.param("dry_run", False))
    dropped = None
    if L.param("drop_archives", False):
        keep = bpy.context.scene
        gone = [sc for sc in bpy.data.scenes if sc.name.startswith("archive__") and sc != keep]
        n_img0 = sum(1 for im in bpy.data.images if im.packed_file)
        b_img0 = sum(len(bytes(im.packed_file.data)) for im in bpy.data.images if im.packed_file)
        n_obj0 = len(bpy.data.objects)
        names = [sc.name for sc in gone]
        for sc in gone:
            bpy.data.scenes.remove(sc)
        bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)  # only this in-memory copy is purged
        n_img1 = sum(1 for im in bpy.data.images if im.packed_file)
        b_img1 = sum(len(bytes(im.packed_file.data)) for im in bpy.data.images if im.packed_file)
        dropped = {"kept_scene": keep.name, "scenes_left_out": names, "objects_left_out": n_obj0 - len(bpy.data.objects), "pictures_left_out": n_img0 - n_img1, "picture_bytes_left_out": b_img0 - b_img1}
    rows, before, after, changed = [], 0, 0, 0
    pics = [im for im in bpy.data.images if im.packed_file]
    for im in pics:
        data = bytes(im.packed_file.data)
        before += len(data)
        new = recompress(data) if not dry else None
        if dry:
            try:
                new = recompress(data)
            except Exception:
                new = None
        if new is not None:
            rows.append((len(data) - len(new), im.name, len(data), len(new)))
            after += len(new)
            changed += 1
            if not dry:
                im.pack(data=new, data_len=len(new))
        else:
            after += len(data)
    rows.sort(reverse=True)
    orphans = {k: sum(1 for b in getattr(bpy.data, k) if b.users == 0) for k in ("meshes", "materials", "images", "node_groups", "lights")}
    src = L.ARGS.get("input")
    src_bytes = os.path.getsize(src) if src and os.path.exists(src) else None
    out_path = os.path.join(L.ARGS["out_dir"], name + ".blend")
    copy_bytes = None
    if not dry:
        os.makedirs(L.ARGS["out_dir"], exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=out_path, copy=True, compress=True)
        copy_bytes = os.path.getsize(out_path)
    est = (src_bytes - (before - after) - (dropped["picture_bytes_left_out"] if dropped else 0)) if src_bytes else None
    L.finish({"dropped": dropped, "copy": out_path if not dry else None, "source_bytes": src_bytes, "copy_bytes": copy_bytes, "estimated_copy_bytes_if_dry": est if dry else None,
              "limit_bytes": LIMIT, "fits": (copy_bytes <= LIMIT) if copy_bytes is not None else (est <= LIMIT if est else None),
              "pictures": {"packed": len(pics), "recompressed": changed, "bytes_before": before, "bytes_after": after, "biggest_savings": [{"name": n, "before": b, "after": a, "saved": s} for s, n, b, a in rows[:6]]},
              "orphans": orphans,
              "notes": ["no checkpoint was saved: the job is unchanged", "pictures keep their pixels exactly (decompressed scanlines compared byte for byte); nothing is resized" + ("; with drop_archives the archive scenes and what only they use are left out of the COPY (the job's checkpoints keep them); the dry-run estimate counts pictures only" if dropped else ", purged or removed")]},
             save=False, files=[out_path] if not dry else [])


if __name__ == "__main__":
    L.run(main)
