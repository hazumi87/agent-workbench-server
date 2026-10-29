"""_bundle - a bundle input for the verbs that read the video-to-3d reference bundle. Imported by them; not a verb.

bundle(b) takes the folder (a path under the tool root or absolute), or a ZIP: a path to the .zip, a Library id of it, or {"library_id": id} / {"path": p}.
A zip is checked BEFORE anything is read from it: it must hold MANIFEST.json, every file it lists must be in the zip with the listed size and SHA-256, and the zip
must hold nothing the manifest does not list. Any mismatch refuses. A verified zip is unzipped into downloads/bundles/<bundle name>/ ; if that folder is already
there and every file in it matches the manifest it is used as it is, otherwise the zip goes to downloads/bundles/<name>-<first 8 of the zip's sha256>/. Nothing is deleted.
"""
import hashlib
import json
import os
import re
import zipfile
from pathlib import Path

import _lib as L


def _sha(fh):
    h = hashlib.sha256()
    for c in iter(lambda: fh.read(1 << 20), b""):
        h.update(c)
    return h.hexdigest()


def _file_sha(p):
    with open(p, "rb") as f:
        return _sha(f)


def _folder_matches(d, files):
    for f in files:
        p = d / f["file"]
        if not p.is_file() or p.stat().st_size != f["bytes"] or _file_sha(p) != f["sha256"]:
            return False
    return True


def _from_zip(zp, what):
    with zipfile.ZipFile(zp) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        man = [n for n in names if n == "MANIFEST.json" or n.endswith("/MANIFEST.json") and n.count("/") == 1]
        if len(man) != 1:
            raise RuntimeError(f"refused {Path(zp).name}: it must hold exactly one MANIFEST.json at its top (found {len(man)})")
        top = man[0][: -len("MANIFEST.json")]
        m = json.loads(z.read(man[0]))
        files = m["files"]
        listed = {top + f["file"]: f for f in files}
        extra = [n for n in names if n != man[0] and n not in listed]
        if extra:
            raise RuntimeError(f"refused {Path(zp).name}: files the manifest does not list: {', '.join(extra[:6])}")
        bad = []
        for n, f in listed.items():
            if n not in names:
                bad.append(f"{f['file']} (missing)")
                continue
            if z.getinfo(n).file_size != f["bytes"]:
                bad.append(f"{f['file']} (size)")
                continue
            with z.open(n) as fh:
                if _sha(fh) != f["sha256"]:
                    bad.append(f"{f['file']} (sha256)")
        if bad:
            raise RuntimeError(f"refused {Path(zp).name}: does not match its MANIFEST.json: {', '.join(bad[:8])}{' ...' if len(bad) > 8 else ''}")
        name = re.sub(r"[^A-Za-z0-9._-]", "_", str(m.get("bundle") or Path(zp).stem))
        base = Path(L.ARGS["tool_root"]) / "downloads" / "bundles"
        d = base / name
        used = "unzipped"
        if d.is_dir() and _folder_matches(d, files):
            used = "folder already there, matches the manifest"
        else:
            if d.exists():
                d = base / f"{name}-{_file_sha(zp)[:8]}"
            d.mkdir(parents=True, exist_ok=True)
            for n in [man[0]] + list(listed):
                dst = d / n[len(top):]
                if not dst.resolve().is_relative_to(d.resolve()):
                    raise RuntimeError(f"refused {Path(zp).name}: unsafe path {n}")
                dst.parent.mkdir(parents=True, exist_ok=True)
                with z.open(n) as src, open(dst, "wb") as out:
                    out.write(src.read())
        L.INPUTS.append({"input": what, "form": "zip", "path": str(zp), "bundle_folder": str(d), "zip": used, "files_verified": len(files)})
        return d


def bundle(b, what="bundle"):
    """the bundle folder (a Path) for a folder, a zip path or a Library id"""
    is_lib = L.is_id(b)
    p = L.resolve(b, what=None if not is_lib and not (isinstance(b, dict) and "library_id" in b) else what)
    if os.path.isfile(p):
        if not p.lower().endswith(".zip") and not zipfile.is_zipfile(p):
            raise RuntimeError(f"{what}: {p} is a file, not a bundle folder or a zip")
        return _from_zip(p, what)
    if not is_lib and not (isinstance(b, dict) and "library_id" in b):
        L.INPUTS.append({"input": what, "form": "path", "path": p})
    return Path(p)
