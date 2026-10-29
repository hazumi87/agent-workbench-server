---
name: character-turnaround
description: Produce a consistent set of character views (front / left / back / right, optional T-pose) with Asset Studio for image-to-3D — the tested order of operations, the Asset Studio verbs to use at each step, and the failure modes to check. Load BEFORE generating turnaround, profile, back or T-pose views of a character, or when views of the same character don't match each other.
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


Asset Studio:
`plugin/asset-studio (relative to the package root)` (`README.md`, `tool.json`; call verbs with
`scripts/studio.sh <verb> <room>`). The bar is **consistency across views** — a 3D generator
fuses them; a mismatched ear, part or scale becomes a broken mesh.

## Order of operations
1. **Import + fix the FRONT first** (`import_ref`, then edits). It's the reference every other
   view is judged and colour-matched against. For small additions (such as an earring), try
   `krea2_turbo_edit`; say whose side ("HIS left ear") and check it.
2. **Pose (T-pose) in ONE step** if needed: generate a plain grey mannequin in the pose with
   `krea2_turbo` (text only), then `krea2_turbo_edit` with refs `[subject, mannequin]`, a wide
   aspect (3:2). Reject any output where the mannequin bled in (white limb).
3. **Local fixes by REGION EDIT, never whole-image prompts** (eyes, fingers, a stud):
   `crop_region` (upscale to ~1024, leave margin) → `set_ref` + `generate` "keep exactly, change
   ONLY the <thing>" → `paste_region` (feather ~20; no feather on a side touching the image edge).
4. **Rotated views from a TURNAROUND SHEET, not single-view edits.** The edit model re-poses but
   will not rotate a body (you get a three-quarter view, or the front with the face erased).
   - Full body: "turnaround sheet … FOUR full-body views in one row: front, left side, back,
     right side", `width 2048, height 768`, refs `[perfected front, original]`.
   - Head / bust: a left+right PAIR sheet, `raw_edit`, ref = the front.
   - Count the figures (sheets often draw 5 or 3). Keep YOUR front; take the others.
5. **Cut the views out onto the front's canvas at the front's scale:** ruler overlay to read
   each figure's x-range and height → `crop_region` with `canvas {w, h, fit_h, bg}` (fit_h =
   the front's subject height ÷ the sheet subject's height × the slice height). Verify with a
   ruler lineup; re-cut if off. Blank a neighbour's intruding hand with a background patch
   (`crop_region` of empty background → `paste_region`, feather 0).
6. **`color_match` every view to the front** (hair / skin / cloth matched separately; lift_dark
   on). Never fix colour with prompt words — they oscillate.
7. **Lineup check** (all four side by side), then `move_image` the set to `favorites`,
   rejects to `recycle`.

## Checks before calling a set done
Same canvas + background · same subject scale · same face shape · hair length, PART and colour ·
accessories on the correct side · no extra figures / bleeds · eyes symmetric · hands as asked.

## Settings that matter
- `krea2_turbo_edit`  to explore; `krea2_raw_edit`  when a painted style
  must hold. Choose batch size within the current allowance.
- Lock what's right ("keep X unchanged") and change ONE thing per round.
- Never write "turnaround / reference sheet" when you want ONE view (you'll get several).
- `clear_ref` before switching to a text-only model. Iterate with `for` omitted (lines go to
  you); `for: "user"` only when the user asked for that render.
- Slow batches? Check `GET …/image-gen/api/health` — GPU contention can change latency.
  The asset-developer owns the image engine on this Linux server.
- Waiting on a render: run the queue itself in the background; never a `pgrep` watcher on a
  pattern your own command line contains (it matches itself and never fires).

## Related
- One picture per PART (body, head, hand, garment) for a modular character: the
  `character-kit-parts` skill.
