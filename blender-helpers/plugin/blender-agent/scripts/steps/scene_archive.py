"""scene_archive — REVERSIBLY set objects (and everything below them) aside so they are no longer in the scene: not rendered, not exported (export_scene, lightmaps, optimisers and every other verb only see the working scene), not picked by globs, but still in the .blend file, with their parents, transforms, materials and meshes untouched. Saves a checkpoint (not with dry_run).
How: the objects are unlinked from the working scene's collections and linked into a separate Scene named `archive__<tag>` (kept alive by that scene); each object remembers the collections it came from (custom properties `archive_tag`, `archived_from`). `restore` links them back to exactly those collections. Nothing is deleted, nothing is renamed.
params:
  archive  list of {"objects": "Chair_*" | ["name", ...] (names or globs; a root takes its whole subtree), "tag": "old_dining_chairs"}
  restore  list of tags (or ["*"] for every archive): the objects go back to their original collections; the archive scene is removed when empty
  list     true: only report the archives (tag, objects, roots)
  dry_run  true: report what would move
Returns: archived / restored per tag (roots, object count), unmatched names, the archives that exist now, and a count of objects left in the working scene.
"""
import fnmatch
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402

PFX = "archive__"


def subtree(o):
    return [o] + list(o.children_recursive)


def main():
    scn = bpy.context.scene
    dry = bool(L.param("dry_run", False))
    rep = {"archived": {}, "restored": {}, "unmatched": []}
    if scn.name.startswith(PFX):
        raise RuntimeError("the active scene is an archive scene")
    for spec in L.param("archive") or []:
        tag = spec["tag"]
        pats = spec["objects"] if isinstance(spec["objects"], list) else [spec["objects"]]
        roots = []
        for p in pats:
            hit = [o for o in scn.objects if fnmatch.fnmatchcase(o.name, p)]
            if not hit:
                rep["unmatched"].append(p)
            for o in hit:
                if o not in roots:
                    roots.append(o)
        # drop roots that are inside another matched root (the subtree move covers them)
        rootset = set(roots)
        def ancestors(o):
            a = []
            while o.parent is not None:
                o = o.parent
                a.append(o)
            return a
        top = [o for o in roots if not any(a in rootset for a in ancestors(o))]
        objs = []
        for r in top:
            for o in subtree(r):
                if o not in objs:
                    objs.append(o)
        rep["archived"][tag] = {"roots": [o.name for o in top][:60], "roots_total": len(top), "objects": len(objs)}
        if dry or not objs:
            continue
        sname = PFX + tag
        arc = bpy.data.scenes.get(sname) or bpy.data.scenes.new(sname)
        for o in objs:
            if "archived_from" not in o:
                o["archived_from"] = json.dumps([c.name for c in o.users_collection])
            o["archive_tag"] = tag
            arc.collection.objects.link(o)
            for c in list(o.users_collection):
                if c.name != arc.collection.name and c in list(bpy.data.collections) + [scn.collection] and o.name in c.objects:
                    c.objects.unlink(o)
            if o.name in scn.collection.objects:
                scn.collection.objects.unlink(o)
    for tag in L.param("restore") or []:
        for arc in [s for s in bpy.data.scenes if s.name.startswith(PFX) and (tag == "*" or s.name == PFX + tag)]:
            objs = list(arc.collection.all_objects)
            for o in objs:
                try:
                    cols = json.loads(o.get("archived_from", "[]"))
                except Exception:
                    cols = []
                if dry:
                    continue
                arc.collection.objects.unlink(o)
                placed = False
                for cn in cols:
                    col = scn.collection if cn == scn.collection.name else bpy.data.collections.get(cn)
                    if col is not None and o.name not in col.objects:
                        col.objects.link(o)
                        placed = True
                if not placed:
                    scn.collection.objects.link(o)
                for k in ("archived_from", "archive_tag"):
                    if k in o:
                        del o[k]
            rep["restored"][arc.name[len(PFX):]] = {"objects": len(objs)}
            if not dry:
                bpy.data.scenes.remove(arc)
    arcs = {s.name[len(PFX):]: {"objects": len(s.collection.all_objects), "roots": [o.name for o in s.collection.all_objects if o.parent is None or o.parent.name not in s.collection.all_objects][:30]} for s in bpy.data.scenes if s.name.startswith(PFX)}
    L.finish({**rep, "archives_now": arcs, "objects_in_working_scene": len(scn.objects), "dry_run": dry}, save=not dry and not L.param("list"))


L.run(main)
