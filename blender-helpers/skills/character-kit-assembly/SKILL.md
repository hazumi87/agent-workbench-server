---
name: character-kit-assembly
description: Assemble a character in Blender from separately generated parts (a base body plus head, hands, feet, garments and armour, each its own image-to-3D model) by fitting them to a reference model and overlapping them — order of work, fitting rules, numeric checks, review rhythm and export. Load BEFORE dressing a body with separate part models, fitting a garment or armour mesh onto a character, swapping in a detailed head/hand/foot, or when an assembled part floats, shows skin through, or comes out the wrong size.
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


You **operate** the Blender workshop: you run its verbs by filling in their settings, and you never
write or edit Blender code. Blender runs with no window, so **renders and numbers are your eyes** —
plan for both at every stage. The verb list is `plugin/blender-agent/docs/OPERATOR-VERBS.md` in your operator folder (the
workshop's own copy is `docs/OPERATOR-VERBS.md`); read its "how to run any verb" section first.
**If a step below needs something no verb does, or a verb refuses or misbehaves twice, do not work
around it:** ask the Blender developer in the room (trying to / tried / got / need) and wait for a verb.
Each request is worth reporting — it shows what the tool still lacks. The parts come from
`character-kit-parts`. The asset-developer owns service setup and lifecycle on this Linux server.

## The rules that protect quality
- **Swap or add whole parts; never cut through detail.** Cut only where the geometry is simple and
  the join will be hidden under clothing (neck under a collar, wrist under a bracer, ankle under a
  shoe strap) — one flat cut, a clean loop.
- **Overlap before welding.** A part sinking into the body is normal modular practice; bridging
  mismatched triangle loops is fragile. Body skin must never show through a part.
- **Never remesh or voxelise a whole model** — it destroys the detail and the textures you were given.
- **Prep every imported part:** merge by distance (weld) FIRST, remove loose bits, recalculate
  normals — a generated GLB has split vertices and cracks when decimated unwelded.
- **Each part keeps its own material and textures.** No baking between parts.
- Work on copies. Every verb saves a checkpoint; keep one per stage and per part so a single part
  can be put back without redoing the rest.

## Decide what kind each part is BEFORE fitting it
- **Rigid** — keeps its exact shape: metal plates, buckles, gems, armour cuffs (bracers), shoe soles.
  Uniform scale and placement ONLY (uniform is the default for every part; scale one axis only
  for a stated reason): never scale one axis more than another, never bend, never
  displace its vertices. After any fit, check its width : height : depth is unchanged.
- **Body-following** — soft things worn close: strap harnesses, belts and waistbands, shoe straps.
  May be conformed to the body: move vertices along the body's surface normal, smoothed, until the
  part sits a few millimetres OUTSIDE the body and its clothing, keeping the strap's own width and
  thickness (no stretching). Report the largest move. If most of the part has to move more than
  about 25 mm, its size or position is wrong — fix that first.
- **One mesh, two kinds** (a shoe: rigid sole, soft straps; a belt: soft strap, rigid buckle): treat
  the rigid portion as rigid and conform only the soft portion. Never move the rigid portion to
  make the soft one fit.
- **Hanging** — strips, tabs, tassels: fixed at the top where they join their band, free below. Do
  not push them onto the body; they may stand off it.
- **A part mounted on another part** (a plate on a strap, a buckle on a belt): keep the size and the
  place the reference gives it, fix it to its host at ONE spot so the two move together, and make it
  rest on the surface beneath — a mounted part that hovers is a fail. Reduce its size only if it truly
  collides with the face or a neighbour, by the least that clears it, and report that you did.
- **When body shows through a rigid or closed part** (arm skin through a cuff, the body's own
  clothing poking out under a belt): change the hidden BODY, not the part — push that covered body
  surface inward, or remove body faces that sit well inside the part. This is the one place body
  geometry may be cut, because it can never be seen.

## Read the reference for what each part is FOR
The reference is not only a shape to match; it shows how the thing is worn. Fit for the job.
- **Armour is functional.** A plate guards what is under it: it is larger than the strap that
  carries it and sits flat over the place it protects. Do not shrink armour to the width of its strap.
- **Straps follow the reference's route**: where they cross (on the chest, not at the throat), and
  which parts they pass over or under (a loop that goes under the belt goes under the belt). Never
  re-route a strap to dodge another part — place parts in the order they are layered, inner first.
- **Belts and bands are worn snug.** The gap to the body is small all the way round; a belt that
  looks as if it could slide down is a fail, however well it matches a bounding box.
- **Shaped pairs are handed.** Shoes, gloves, shoulder pieces: left is not right. Check which side
  the big toe, thumb or buckle is on against the reference, and check the pair is not swapped.
- **Round details stay round.** Studs, rivets, rings and gems show any uneven scaling at once. If a
  part's proportions are wrong for the reference, report it as a fault of the part — do not stretch it.

## Order of work
**1. New file. Reference first.** Import the reference model — the whole character generated as one
piece, wearing everything. It is the target for scale, proportion and where each part sits. Never
edit it. Set the fixed cameras now (see Review) and render the reference with them.

**2. Fit the base body to the reference — and do not move on until it is right.** Everything
downstream inherits this.
- Match overall scale and proportion: height, shoulder and hip width, arm span, limb positions.
  Ignore hair, teeth and face detail. Do not stretch parts of the body to force a match — distortion
  is worse than a small difference.
- Try the fit on the TRUNK (ignore arms, hands, head, hair) and on the whole body; keep the one
  with the smaller error in height and limb position, say which, then compare each limb separately. A dressed
  reference is thicker than a bare body front to back — expect that; match heights, joint positions
  and limb directions, not surface depth.
- Measure, don't eyeball: compare body and reference at the places parts will sit — forearm and
  wrist thickness (BOTH arms, along their length), waist, chest depth, ankle, foot length. Write the
  differences down; a generated body is rarely symmetric. These numbers, not the reference's, set
  the SIZE of anything worn on a limb or the waist — the reference gives position, orientation and look.
- Spend extra rounds here if the proportions are off. Render body over reference (two colours or
  side by side) from front, side and top to judge.

**3. Place the parts against the reference, one at a time, with the body hidden.** For each part:
- Hide the body. Place the part on the reference where the reference wears it, matching position,
  orientation and size. Take extra rounds until it matches.
- Rings and symmetric parts (belts, cuffs, plates, skirts) can fit equally well turned 180° — set
  which way is front explicitly (buckle, gem, opening, how the tabs line up) and confirm it in a picture.
- Parts that sit on other parts (a plate on a strap) are placed after the part they sit on, touching it.
- Checkpoint, then HIDE that part and bring in the next. Repeat until every part is placed.

**4. Swap the reference for the body and judge the result.** Hide the reference; show the body and
all the parts together. Is it satisfactory? If not, tweak — within your fix rounds:
- A part must fit the BODY it is worn on. Where the body differs from the reference (your step-2
  list), size the part to the body, measured along the part's whole length, not one slice (limbs
  taper).
- Pairs: mirror one side onto the other only if the body is the same on both sides there (an
  independent fit of the other side lands within about 5 mm); otherwise fit each side to its own limb.
- A straight rigid cuff on a limb that bends or tapers: place it on the limb's axis at the cuff's
  middle and size it to the thickest point along its length; deal with what still shows by changing
  the hidden body (see the part kinds), not by bending the cuff.
- Ring parts must be at least as wide as the body, clothing included, where they sit — check that
  before anything else at the waist.
- Rerun ONLY the part that failed, from its checkpoint — not the whole assembly.
- **When two rules pull apart, the body wins the fit and the reference keeps the look.** A ring that
  must clear the body grows only in the directions that need it; its length and its details keep the
  reference's proportions.
- **A part that cannot be made to fit is a question, not a tweak.** A cuff whose opening is smaller
  than the limb, a part whose own proportions differ from the reference's, a shoe whose straps sit
  lower than the foot: measure it as soon as the part is placed, and ask the lead which way to go
  (bigger part, changed hidden body, or a new part) before spending attempts on it.

**5. Final review against the reference — before you report.** Put the reference and the finished
assembly in the same views (the review verb gives side-by-side pairs) and go through every camera,
then the whole set again in views A, B and C: what differs in size, position, route,
fit, handedness? Write each difference down as fixed, accepted (say why) or still wrong. Most faults
that reach the user are visible in this comparison; do it even when the numbers all pass.

**6. Detail swaps last** (a higher-detail head, hand or foot): only after the dressing passes its
checks, one at a time, cut hidden as in the rules. Expect a skin-tone step at the join; say so —
matching it is a painting job.

## Milestone pictures (always, so the progression can be seen afterwards)
Same cameras each time; keep every milestone under its own fixed name, never overwritten:
1. **Body matched to the reference** — both visible (two colours or overlaid), showing how well it
   matched and where it did not.
2. **All parts matched to the reference** — reference and parts visible, body hidden.
3. **Reference hidden, body and all parts** — the first look at the real result, before any tweak.
4. **After tweaking** — body and parts. One per tweak round if there is more than one.

## Numbers to check at every stage (gate: do not continue past a failure)
- Per part: non-manifold edges (0), loose islands (1), triangle count against its budget.
- Part to body: signed distance from the part's surface to the body — median, deepest sink, furthest
  float. A cuff floating centimetres off the arm, or skin outside it, is a fail.
- Part size against the same part on the reference (width × height × depth).
- Left/right placement difference for pairs. Mounted parts: the gap between the part's contact
  face and its host (median and worst), not just the nearest point. Clearance between neighbours
  (plate to face, belt to skirt).
- Body showing through a CLOSED part (cuff, belt): test with rays cast outward from the body
  surface inside the part's region — comparing radii or bounding sizes misleads.
- A "how much body is covered" percentage is meaningless for slatted or open parts (kilts, sandals,
  harnesses) — use the renders for those.

## Looking: the views, and when to look
The tool captures every camera after every step, in four views, and you open those same pictures
(the look verb) — you do not render your own unless no camera gives you the view.
**Judge a fit only in a picture the part fills.** A whole-character view tells you a part exists and
is roughly placed; it cannot show a gap, a sunk strap or a stretched stud, and passing a fit on one
is a fail of the review. Whole-character views are for the person watching and for proportion and
silhouette; every fit, contact and rim is judged in a close-up where the part takes up most of the frame.
- **Plain** — the piece as it will be seen. For "does this look right?"
- **A** (reference grey, parts in colour) — where a part sits against the reference: what pokes out,
  what has sunk in.
- **B** (reference see-through, parts as bright wire) — whether a part follows the surface under it:
  lines sunk into the reference go dim.
- **C** (reference as wire, parts grey) — where the reference is bulkier than what covers it.
Try all of them on a part early and keep using the ones that show you most; no single view shows
everything. Views never use normal maps — you are seeing the true geometry.

**Cameras.** Pick the view by what the part is, not by habit — a level front view hides most faults:
- **A ring round a limb or the waist** (cuff, band, belt): look ALONG the limb, from beyond its end,
  so the whole gap between ring and body shows all the way round; then at its rims from the side.
- **Feet and what is strapped to them:** from the front and ABOVE (tops of the feet, straps over the
  instep), and each foot from the outer side and at three-quarter.
- **A part mounted on another:** edge-on, so a hover shows as daylight between the two.
At step 1, before placing anything, read the camera list and save any of these this character
still lacks: every place a part ends on the body, every ring, each foot and hand.

**Rhythm.**
- **One change, one look.** After every run that changes a shape, look at that part from at least
  two directions before the next change. Numbers alone have misjudged fits both ways.
- After placing each part: its numbers, then side and three-quarter views, then the next part.
- At milestone 3: **stop and review the whole set** in Plain and A, then write the fix list.
- **A tweak round is ONE fault:** decide the method, make the change, look, record the result. It is
  not a batch of fixes followed by one review.
- **Two failed attempts at the same fault = stop.** Before a third, write down the method and what
  the numbers and the picture must show for it to pass.
- Every run that changes a result is an attempt; dry runs and read-only measures are not. Count
  attempts and report them. Stay inside the allowance you were given; stop and report when it is used.
- Do not cap a value to hide a bad fit.

## Decimation and export
- Decimate per part after welding. Starting budgets: body ~60k triangles, garments 10–20k each,
  whole character under ~200k. Thin rims and strap edges tear at low budgets — give them more, or
  say they are ragged.
- Export one GLB with the parts as separate meshes. Scale textures to 2048 and store them as JPEG
  except normal maps, so the file stays loadable on a phone.
- Before publishing, read the export's mesh list and triangle total: the reference and any duplicate
  body must not be in it.
- Publish to the Library, and put the fixed-camera renders in the room's top-level assets under names
  that never change (overwrite the same names each round).

## Report
The published id, which inputs you used, the numbers above, how many attempts and render views you
used, and — plainly — what is still wrong. Look at your own final renders before writing it.

## Related
`character-kit-parts` (making the part pictures and models) · the local Linux runner (see the package readme.md) ·
`agent-share` (posting renders).
