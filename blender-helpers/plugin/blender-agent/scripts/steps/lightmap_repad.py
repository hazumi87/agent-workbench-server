"""lightmap_repad — rewrite the mask-2 (island padding) texels of a FINISHED lightmap file by EDGE COPY instead of the baker's ring averaging. Writes NEW files; the source files, the scene and the checkpoint are never touched. No Cycles, no rebake.
Each padding texel takes the whole value of ONE donor: a neighbouring texel that is mask 1 or was filled in an earlier round, tried left, right, up, down, then the four diagonals (directional neighbour propagation: NOT a Euclidean-nearest search). Values are copied as raw bytes (all channels / fixtures of the texel together), never converted or averaged, so no island is blended with another.
params:
  bin        path of the packed file: "f16" = <name>.lightmaps.bin (little-endian half float, layers x H x W x 4, row 0 = glTF v 0) | "u8" = a single-plane AO <name>.ao.u8 (H x W bytes)
  format     "f16" (default) | "u8"
  mask       path of the set's .mask.u8 (0 = not a receiver, 1 = true receiver, 2 = island padding); same size and row order as the file
  atlas_px   side of the square atlas (default 1024)
  name       base name of the NEW files in out/lightmaps (required; must differ from the source name): <name>.lightmaps.bin | <name>.ao.u8, and <name>.mask.u8 (a byte-identical copy of the mask)
  manifest   (f16 only, optional) path of the source set's <name>.lightmaps.json: writes a COMPANION set under the new name so lightmap_check can verify and bind it without touching the originals: <name>.lightmaps.json (same maps/receivers/calibration; pack.file, pack.sha256, pack.mask_file, pack.probe_file and name point at the new files; pack.padding text says edge copy, still starting with the same texel count) and <name>.probes.json (byte-identical copy of the source probes file, so the original probe evidence is preserved)
  max_rounds propagation rounds (default 8); mask-2 texels still unfilled afterwards keep their old bytes and are counted
Report: before/after sha256 of the file and the mask, counts of mask 0/1/2, texels changed (mask 2 only), donors by direction, mask-1 bytes identical (true zeros included), mask-0 bytes identical, mask-2 texels left unfilled, and a check that every filled mask-2 texel equals a mask-1 or earlier-filled texel's bytes within 5x5. The manifest/bound files carry the old file hash: rebind (lightmap_check) after replacing."""
import hashlib
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402

ORDER = (("right", 0, 1), ("left", 0, -1), ("down", 1, 0), ("up", -1, 0), ("diag +1,+1", 1, 1), ("diag +1,-1", 1, -1), ("diag -1,+1", -1, 1), ("diag -1,-1", -1, -1))


def main():
    A = int(L.param("atlas_px", 1024))
    fmt = L.param("format", "f16")
    if fmt not in ("f16", "u8"):
        raise RuntimeError('format must be "f16" or "u8"')
    name = L.param("name")
    if not name:
        raise RuntimeError("name: the base name of the NEW files is required")
    src = L.resolve(L.param("bin"))
    msrc = L.resolve(L.param("mask"))
    if os.path.basename(src).startswith(name + "."):
        raise RuntimeError("name must differ from the source file's name: the source is never overwritten")
    raw = open(src, "rb").read()
    mraw = open(msrc, "rb").read()
    if len(mraw) != A * A:
        raise RuntimeError(f"mask is {len(mraw)} bytes, expected {A * A}")
    mask = np.frombuffer(mraw, np.uint8).reshape(A, A)
    if fmt == "u8":
        if len(raw) != A * A:
            raise RuntimeError(f"u8 file is {len(raw)} bytes, expected {A * A}")
        data = np.frombuffer(raw, np.uint8).reshape(A, A, 1).copy()
    else:
        if len(raw) % (A * A * 8):
            raise RuntimeError(f"f16 file is {len(raw)} bytes, not a whole number of {A}x{A}x4 half-float layers")
        lay = len(raw) // (A * A * 8)
        data = np.frombuffer(raw, "<u2").reshape(lay, A, A, 4).transpose(1, 2, 0, 3).reshape(A, A, lay * 4).copy()  # raw 16-bit patterns, never converted
    orig = data.copy()
    C = data.shape[2]
    have = mask == 1
    todo = mask == 2
    donors = {k[0]: 0 for k in ORDER}
    rounds = []
    for r in range(int(L.param("max_rounds", 8))):
        ph = np.pad(have, 1)
        pd = np.pad(data, ((1, 1), (1, 1), (0, 0)))
        newm = np.zeros((A, A), bool)
        out = data.copy()
        for nm, dy, dx in ORDER:
            sh = ph[1 + dy:1 + dy + A, 1 + dx:1 + dx + A]
            sd = pd[1 + dy:1 + dy + A, 1 + dx:1 + dx + A]
            take = todo & ~have & ~newm & sh
            if take.any():
                out[take] = sd[take]
                newm |= take
                donors[nm] += int(take.sum())
        if not newm.any():
            break
        data = out
        have = have | newm
        rounds.append(int(newm.sum()))
    filled = todo & have
    unfilled = int((todo & ~have).sum())
    same = (data == orig).all(axis=2)
    changed = int((todo & ~same).sum())
    # every filled padding texel must equal the bytes of some texel within 5x5 that was mask 1 or filled earlier (donor existence check, on the final array)
    ys, xs = np.nonzero(filled)
    pdat = np.pad(data.astype(np.int64), ((2, 2), (2, 2), (0, 0)), constant_values=-1)
    pm1 = np.pad(mask == 1, 2)
    ok = np.zeros(len(ys), bool)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dy or dx:
                ok |= pm1[2 + ys + dy, 2 + xs + dx] & (pdat[2 + ys + dy, 2 + xs + dx] == data[ys, xs]).all(axis=1)
    near_m1 = round(float(ok.mean()), 4) if len(ok) else None
    d = os.path.join(L.ARGS["out_dir"], "lightmaps")
    os.makedirs(d, exist_ok=True)
    if fmt == "u8":
        ob = data.reshape(A, A).astype(np.uint8).tobytes()
        fn = f"{name}.ao.u8"
    else:
        ob = data.reshape(A, A, lay, 4).transpose(2, 0, 1, 3).astype("<u2").tobytes()
        fn = f"{name}.lightmaps.bin"
    open(os.path.join(d, fn), "wb").write(ob)
    open(os.path.join(d, f"{name}.mask.u8"), "wb").write(mraw)
    sh = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
    comp = None
    if L.param("manifest") and fmt == "f16":
        mp = L.resolve(L.param("manifest"))
        man = json.load(open(mp, encoding="utf-8"))
        pk = man["pack"]
        pf = os.path.join(os.path.dirname(mp), pk.get("probe_file", ""))
        man["name"] = name
        pk["file"] = fn
        pk["bytes"] = len(ob)
        pk["sha256"] = sh(ob)
        pk["mask_file"] = f"{name}.mask.u8"
        pk["probe_file"] = f"{name}.probes.json"
        pk["padding"] = pk.get("padding", "2").split()[0] + " texels EDGE-COPIED from covered texels (lightmap_repad: directional neighbour propagation, whole raw values, no averaging); mask 1 / mask 0 bytes unchanged; further texels 0"
        pk["repad"] = {"source_bin_sha256": sh(raw), "source_manifest": os.path.basename(mp), "method": "directional neighbour propagation (right, left, down, up, then diagonals)"}
        json.dump(man, open(os.path.join(d, f"{name}.lightmaps.json"), "w", encoding="utf-8"), indent=2)
        if os.path.isfile(pf):
            shutil.copyfile(pf, os.path.join(d, f"{name}.probes.json"))
        comp = {"manifest": f"{name}.lightmaps.json", "probes": f"{name}.probes.json" if os.path.isfile(pf) else None, "probes_sha256_source": sh(open(pf, "rb").read()) if os.path.isfile(pf) else None}
    L.finish("repadded", save=False, method="edge copy by directional neighbour propagation (right, left, down, up, then diagonals); NOT Euclidean-nearest; raw bytes copied, no averaging, all channels of a texel from one donor",
             source={"file": os.path.basename(src), "bytes": len(raw), "sha256": sh(raw)}, output={"file": fn, "bytes": len(ob), "sha256": sh(ob)},
             mask={"source_sha256": sh(mraw), "copy_sha256": sh(mraw), "identical": True}, counts={"mask0": int((mask == 0).sum()), "mask1": int((mask == 1).sum()), "mask2": int(todo.sum())},
             changed_mask2_texels=changed, mask1_bytes_identical=bool((data[mask == 1] == orig[mask == 1]).all()), mask0_bytes_identical=bool((data[mask == 0] == orig[mask == 0]).all()),
             mask2_unfilled=unfilled, companion_set=comp, rounds_filled=rounds, donors_by_direction=donors, filled_texels_equal_a_mask1_texel_within_5x5=near_m1, channels=C)


L.run(main)
