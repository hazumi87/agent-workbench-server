"""rig_bind — bind the body to the rig with automatic weights now (after rig_biped bind:false or rig_joints), or take the binding off. Saves a checkpoint.

rig_biped and rig_joint bind at once; rig_joints (batch) does not. This verb is the deferred bind, and also the way to start the weights again from scratch. Weights you edited with rig_weights are replaced by a bind.

params:
  body   the mesh (default "body")
  mode   "bind" (default: automatic weights, the same as rig_biped) or "unbind" (removes the armature binding and every vertex group; the mesh stays where it is)
Returns: weights (vertices, unweighted, most influences on one vertex, bones with dominant vertices) after a bind; vertex_groups 0 after an unbind.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import rig_common as R  # noqa: E402


def main():
    arm = R.find_rig()
    body = bpy.data.objects.get(L.param("body", "body"))
    if body is None or body.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('body', 'body')}")
    mode = L.param("mode", "bind")
    if mode not in ("bind", "unbind"):
        raise RuntimeError('mode must be "bind" or "unbind"')
    R.reset_pose(arm)
    if mode == "unbind":
        R.unbind(body)
        L.finish({"mode": "unbind", "vertex_groups": len(body.vertex_groups), "armature_modifier": any(m.type == "ARMATURE" for m in body.modifiers)}, save=True)
        return
    w = R.bind(body, arm)
    L.finish({"mode": "bind", "weights": w}, save=True)


L.run(main)
