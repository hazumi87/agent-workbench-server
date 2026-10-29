"""game_rig — build the EXPORT skeleton from the Rigify rig and bake onto it.

Rigify's DEF- bones deform correctly but do not form one hierarchy (arms and
legs hang off MCH/ORG bones), so exporting "deform bones only" gives many
roots, and Unity Humanoid / retargeting want one. This step:
  1. copies every DEF- bone into a new armature "Skeleton", parented along the
     metarig hierarchy (ORG- parents) with segment chains kept, under one "root"
  2. constrains each bone to its Rigify DEF- twin and bakes the rig's active
     action onto it (same name) — the rig stays the authoring tool, Skeleton is the output
  3. re-binds the mesh to Skeleton (vertex group names are unchanged)
Re-run after any new or changed animation.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402

def hierarchy(rig_bones, def_names):
    """{DEF bone: parent DEF bone or None}. A DEF-x.NNN with no ORG-x.NNN is a
    segment of DEF-x (Rigify splits long bones); everything else follows its
    ORG- twin's parents, landing on the LAST segment of the parent's chain."""
    def segment(name):
        m = re.match(r"^DEF-(.+)\.(\d{3})$", name)
        if m and f"ORG-{m.group(1)}.{m.group(2)}" not in rig_bones:
            return m.group(1), int(m.group(2))
        return None

    chains = {}
    for n in def_names:
        seg = segment(n)
        base, k = seg if seg else (n[4:], 0)
        chains.setdefault(base, []).append((k, n))

    out = {}
    for n in def_names:
        seg = segment(n)
        if seg:
            base, k = seg
            out[n] = f"DEF-{base}" if k == 1 else f"DEF-{base}.{k - 1:03d}"
            continue
        p = rig_bones[f"ORG-{n[4:]}"].parent if f"ORG-{n[4:]}" in rig_bones else None
        out[n] = None
        while p is not None:
            if p.name.startswith("ORG-") and p.name[4:] in chains:
                out[n] = max(chains[p.name[4:]])[1]
                break
            p = p.parent
    return out


def main():
    mesh = L.the_mesh()
    rig = next(a for a in L.armatures() if a.name not in ("metarig", "Skeleton"))
    old = bpy.data.objects.get("Skeleton")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)

    rb = rig.data.bones
    def_names = [b.name for b in rb if b.use_deform]
    rig_bones = {b.name: b for b in rb}

    arm = bpy.data.armatures.new("Skeleton")
    skel = bpy.data.objects.new("Skeleton", arm)
    bpy.context.scene.collection.objects.link(skel)
    skel.matrix_world = rig.matrix_world.copy()
    L.activate(skel, "EDIT")
    eb = arm.edit_bones
    root = eb.new("root")
    root.head, root.tail = (0, 0, 0), (0, 0.25, 0)
    for n in def_names:
        b = eb.new(n)
        src = rb[n]
        b.head, b.tail = src.head_local, src.tail_local
        b.matrix = src.matrix_local.copy()  # exact rest orientation (roll): skinning depends on it
    parents = hierarchy(rig_bones, def_names)
    for n, p in parents.items():
        eb[n].parent = eb[p] if p else root
    bpy.ops.object.mode_set(mode="OBJECT")

    # constrain to the rig and bake each action
    L.activate(skel, "POSE")
    for pb in skel.pose.bones:
        if pb.name == "root":
            continue
        c = pb.constraints.new("COPY_TRANSFORMS")
        c.target, c.subtarget = rig, pb.name
    baked = []
    skel.animation_data_create()
    act = rig.animation_data.action if rig.animation_data else None
    if act:  # v1: the rig's active action; more actions -> NLA loop later
        start, end = map(int, act.frame_range)
        bpy.ops.pose.select_all(action="SELECT")
        bpy.ops.nla.bake(frame_start=start, frame_end=end, only_selected=True, visual_keying=True,
                         clear_constraints=False, use_current_action=False, bake_types={"POSE"})
        out = skel.animation_data.action
        name = act.name.removesuffix(".rigify")
        act.name = f"{name}.rigify"  # the authoring action keeps a distinct name
        stale = bpy.data.actions.get(name)
        if stale and stale is not out:  # a previous bake
            bpy.data.actions.remove(stale)
        out.name = name
        out.use_fake_user = True
        baked.append({"action": name, "frames": [start, end]})
    for pb in skel.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    bpy.ops.object.mode_set(mode="OBJECT")

    # re-bind the mesh
    for m in mesh.modifiers:
        if m.type == "ARMATURE":
            m.object = skel
    mw = mesh.matrix_world.copy()
    mesh.parent = skel
    mesh.matrix_world = mw
    roots = [b.name for b in arm.bones if not b.parent]
    # self-check: every export bone's rest matrix must equal its Rigify twin's,
    # or the mesh twists even at rest
    drift = max(max(abs(a - b) for ra, rb_ in zip(arm.bones[n].matrix_local, rb[n].matrix_local) for a, b in zip(ra, rb_))
                for n in def_names)
    bad = [] if roots == ["root"] else [f"roots: {roots}"]
    if drift > 1e-4:
        bad.append(f"rest drift {drift:.5f}")
    L.finish({"bones": len(arm.bones), "roots": roots, "baked": baked, "rest_drift": round(drift, 6)},
             save=True, ok=not bad, error="; ".join(bad) or None, parents=parents)


L.run(main)
