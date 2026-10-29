---
name: character-rigging
description: Give a generated character body a skeleton and make it move with library animation clips, in Blender, for a web (three.js) or game runtime — what to check before rigging, where joints go, how to test a bind with motions and numbers, applying clips, and export. Load BEFORE rigging a body, binding a mesh to a skeleton, applying a Mixamo or other library clip to a character, or when a rigged character collapses at the shoulder, candy-wraps at the elbow, or slides its feet.
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


You **operate** the Blender workshop: you run its verbs by filling in their settings, and you never
write or edit Blender code. The verb list is `plugin/blender-agent/docs/OPERATOR-VERBS.md` in your operator folder. If a
step needs something no verb does, or a verb fails twice, ask the Blender developer in the room
(trying to / tried / got / need) and wait. Blender runs with no window: **strips of frames and
numbers are your eyes.** The asset-developer owns service setup and lifecycle on this Linux server.

## What a good rig is for
The skeleton exists so that ready-made clips drive the character with no hand work. So:
- **Use the clip library's own bone names and hierarchy.** A clip finds its bones by name; a rig
  with the right names needs no retargeting. Do not rename, add or remove bones in that chain.
- **Rig the bare body first, alone.** Clothing, armour and hanging parts are attached afterwards and
  are a separate job: rigid parts follow one bone, soft worn parts take their weights from the body
  under them, hanging parts get their own short chains. Do not bind them in the body pass.
- **The rest pose is the pose the body was made in** (a T-pose). Do not re-pose the mesh to suit
  the skeleton; fit the skeleton to the mesh.

## Before placing a single joint
- One welded mesh, no loose bits, feet on the ground, facing the standard way, real-world scale.
- Arms out level, legs apart, fingers apart if fingers are to move. A body whose arms touch its
  sides or whose legs touch cannot be bound cleanly — say so before going on.
- Measure both sides. A generated body is rarely symmetric; decide per limb whether one side can be
  mirrored (the other side's joints land within a few millimetres) or each side is fitted on its own.
- **Prove the route first.** As soon as there is a first bind, before polishing any joint, apply ONE
  clip and look at its strip. If a clip cannot drive the rig at all, stop and report — everything
  after depends on it.

## Where joints go
The tool places a first skeleton and tells you, joint by joint, where each position came from:
**measured** from this body, or taken from a standard human **template**. Read that list and its
notes before anything else. Template joints are guesses on a non-human body — they are the ones to
test and move. Measured joints are moved only when a picture shows them wrong.
Joints sit **inside the body, on the centre line of the limb, where the body actually bends** — read
them from this body's own shape, not from human proportions.
- **Shoulder:** inside the shoulder mass, above the armpit — never at the armpit surface or out in
  the upper arm. Too far out and the chest tears; too far in and the arm swings like a door.
- **Elbow, knee:** at the crease, at the limb's centre, a touch toward the side the joint points
  (elbow back, knee forward) so it bends the right way.
- **Wrist, ankle:** at the narrowest point before the hand or foot widens.
- **Hip:** inside the pelvis at the height of the leg crease, each over its own leg — not at the
  crotch and not at the outer surface.
- **Spine:** from the hips to the base of the neck, spaced evenly along the trunk's centre.
- **Neck and head:** the neck starts where the trunk narrows; the head turns from the base of the
  skull, not from the chin or the top of the head.
- A stocky, short-legged or long-armed character keeps ITS landmarks: short legs get short leg
  bones. Never stretch the body to fit a human skeleton.
Look at the joints over the body from front, side and top before binding. A joint outside the mesh,
or off the limb's centre line in the side view, is a fail.

## Bind, then test with motions — not with clips
Automatic weights first. Then check, before any clip:
- No vertex without weights, none following a far-away bone (a hand vertex moved by the thigh).
- Run the standard test motions and look at each as a strip from front and side: arms up, arms
  forward, elbows bent to a right angle, a squat, a trunk twist, a head turn.
- Read the numbers per joint: worst stretch and volume lost against the rest pose. A collapsing
  shoulder, an elbow that pinches flat, a hip that caves in — each shows in both the number and the strip.
Fix by moving **one joint at a time**, re-binding, and running the same motion again:
- Decide the direction from the strip (a bend that pinches on the inside wants the joint moved toward
  the outside of the bend; a limb that swings from the wrong place wants the joint moved along the
  limb), move a small amount, and compare the SAME numbers before and after.
- **Keep a move only if both the number and the strip are better.** Otherwise go back to the
  checkpoint before it and try the other direction or another joint. Never stack moves you have not
  compared.
- Check that fixing one motion did not spoil another: a shoulder moved for arms-up is rerun for
  arms-forward.
- Pairs: move both sides together only where the body is the same on both sides; otherwise each side
  on its own.
- A joint in the right place cures most weight faults. When joint moves stop improving a number,
  stop and report what is left — that is a job for a weights tool, not for more moves.
There is no fixed pass mark: report the numbers you started with, the numbers you ended with, and
which joints still look wrong in the strips.

## Clips
- Apply a calm clip first (an idle), then one with travel (a walk), then one that reaches (a wave
  or a punch). Look at a strip across the whole clip, front and side.
- A clip made for human proportions on a non-human body will show it: feet sink or slide, hands
  pass through a belly or fail to meet. Read the floor and sliding numbers with the strip.
  **Report these as findings; do not bend the rig to hide them.**
- Prefer in-place clips; a clip that walks the character away from the origin is noted, not fixed.
- Fingers: if finger bones are bound, check a fist. If the hand moves as one piece, say so.

## Rhythm
- One change, one look: after every run that changes the rig, the same test motion again, from two
  directions.
- Two failed attempts at the same fault: stop and write down the method and what must be seen for it
  to pass, before a third.
- Count result-changing runs as attempts; measures and looks are free. Stay inside your allowance.

## Export
- One GLB: the mesh with its skin, the skeleton, and each applied clip as a named clip. Textures as
  for any published model.
- Before publishing, read back what the file holds: one skinned mesh, the bone count, the clip names
  and lengths.
- Publish to the Library and open it in the full-page viewer with a clip playing; a model that
  animates in Blender but not in the viewer is not done.

## Report
The published id; joint positions that were moved by hand and why; the test-motion numbers per joint;
which clips were applied and what each showed; whether fingers move; attempts used; and plainly what
is still wrong.

## Related
`character-kit-assembly` (dressing the body) · `character-kit-parts` (making the parts) ·
`agent-share` (posting pictures).
