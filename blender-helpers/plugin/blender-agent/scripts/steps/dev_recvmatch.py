"""dev_recvmatch — DEV TOOL (read-only, saves nothing): which meshes a receivers list picks. params: exact [names/globs of the reference list], globs [the list under test]; both resolved with the baker's own pick(). Reports each list's mesh count and triangle total, and the meshes the second picks that the first does not (name, triangles), biggest first, with the glob(s) that matched them."""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    import lightmap_bake as LB
    a = LB.pick(L.param("exact") or [], {"MESH"})
    b = LB.pick(L.param("globs") or [], {"MESH"})

    def tris(o):
        o.data.calc_loop_triangles()
        return len(o.data.loop_triangles)
    sa, sb = {o.name for o in a}, {o.name for o in b}
    extra = [o for o in b if o.name not in sa]
    missing = [o for o in a if o.name not in sb]
    rows = sorted(({"name": o.name, "tris": tris(o), "globs": [g for g in L.param("globs") if fnmatch.fnmatchcase(o.name, g)]} for o in extra), key=lambda r: -r["tris"])
    L.finish({"exact": {"meshes": len(a), "tris": sum(tris(o) for o in a)}, "globs": {"meshes": len(b), "tris": sum(tris(o) for o in b)}, "globs_only_meshes": len(extra), "globs_only_tris": sum(r["tris"] for r in rows),
              "exact_only": [o.name for o in missing][:40], "globs_only_top": rows[:40], "globs_only_by_glob": {g: sum(1 for r in rows if g in r["globs"]) for g in sorted({g for r in rows for g in r["globs"]})}}, save=False)


L.run(main)
