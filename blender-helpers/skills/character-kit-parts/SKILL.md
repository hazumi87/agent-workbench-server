---
name: character-kit-parts
description: Make one clean picture per PART of a character (base body, head, hand, foot, each garment or piece of armour) with Asset Studio, so each part can go through image-to-3D as its own model and be assembled later. Load BEFORE splitting a character into parts for 3D, generating an "object alone" picture from a character reference, or when a part picture comes back with a body attached, flat, or with something left inside it.
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


Why parts: a character generated as ONE model fuses clothing, straps and skin, and cutting it apart
later damages detail. One picture → one model per part gives far better meshes and textures, and the
parts are assembled by overlap (see `character-kit-assembly`). Asset Studio:
`plugin/asset-studio (relative to the package root)` (verbs via `scripts/studio.sh <verb> <room>`); model
`krea2_turbo_edit`, a batch size within the current allowance. For whole-character views see
`character-turnaround`.

## 1. Agree the part list and the base body FIRST
- List every part with the user before generating: base body, head, hand, foot, then each garment
  and each piece of armour as its own item. Ask which side-pairs can be made once and mirrored
  (bracers, shoes, shoulder plates).
- **The base body wears what will sit UNDER the kit**, never bare and never an outfit that shows:
  keep the character's own under-layer (its tunic or shirt) and give it very short briefs that end at
  the top of the thigh. Long shorts show under a skirt; a foreign white vest clashes at every gap.
- Base body: bare forearms, bare feet, no belts or bands. Check both wrists and the waist in every
  candidate — the edit model likes to keep one bracer or a thin belt.

## 2. The base body pictures
- Edit the character's existing T-pose view: "keep exactly … change ONLY the clothing", naming every
  item to remove and what remains. If something survives, run ONE more edit that removes only that.
- Back view: edit the existing back view with the finished front as the second reference
  (`set_ref` slot 1) so the clothing matches.
- Do NOT try to re-dress side views this way — they come back as sheets of several figures. A front
  plus a back is enough for a multi-view 3D model.
- If a "remove X" edit on a view makes it worse, keep the earlier picture; a small remnant that the
  kit will cover is better than a changed garment.

## 3. One part, alone
Prompt shape that works: *"A product photo of ONE single object: <the part, described by material and
features>. The <part> is alone and empty … No <body part>, no body, no character. Same 3D render
style, materials and colours as the reference. Flat, even, shadowless lighting: no cast shadows, no
drop shadow. Plain flat mid-grey background, the object centered and fully in frame."*
- **Reference = the full character** works for compact objects: bracer, belt, skirt, shoe, foot,
  hand, head.
- **Reference = a TIGHT CROP of just that part** (`crop_region`, upscaled to 1024) is needed when the
  part lies ON the body — chest plates, strap harnesses. From the full character the model draws a
  headless body wearing it. With the crop, say "keep these <straps> exactly … remove everything
  else … they float empty, as if worn by an invisible body".
- **Give the 3D generator depth clues.** A thin object seen flat from the front (a plate, a coin, a
  buckle) comes back as a flat model. Turn it slightly off front and from above so its edge and
  thickness show. Do the angle FIRST; only then a second edit to remove a backing or mount.
- Wearable rings (belt, skirt, cuff): ask for the shape "as when worn", seen from slightly above so
  the opening is visible; hollow cuffs "an open tube".
- Skirts and kilts: match how the original hangs (for example longest at centre front, rising at the
  hips) — it drapes on the body far more easily than a level hem.
- Hands: top view of the BACK of the hand, palm down, fingers straight and fanned wide. A hand will
  grip or make a fist later, so the back matters more than the palm.
- Head: head and bare neck only, cut cleanly at the base of the neck, upright, facing the camera,
  neutral or closed mouth unless the open mouth is wanted in the final character.
- Fasteners sell an object: ask for the buckled straps on a bracer, the buckle on a shoe.

## 4. Check every part picture before it costs credits
One object only · nothing inside it (toes in a sandal, an arm in a cuff) · no second item attached
(a belt on a harness) · whole object in frame · no cast shadow · its depth is readable · colours
match the character. Fix a single fault with ONE more edit that names only that fault, using the
faulty picture as the reference.

## 5. Sending parts to image-to-3D (Scenario)

The asset-developer/provider owner runs the paid job after the operator checks the image and the user approves the quoted cost. The command below documents that owner’s handoff; it is not blanket permission for the operator to spend credits.
`node <ASSET_PLATFORM_INSTALL>/packages/scenario/scenario.mjs run <modelId> --in <input>=<libraryId> …`
— every call is a quote; a real run needs `--confirm-cost <the quoted credits>`. Get the user's go
on the credit total first.
- Parts: single-image model, PBR on. Base body: the multi-view model with `frontImage` + `backImage`
  (a front-only body gets an invented back).
- The plan runs two jobs at a time; a third is refused (not charged) — queue them in pairs.
- The GLB lands in the Library with its settings; make thumbnails with
  `node packages/app/scripts/mesh-thumbs.mjs --no-packs`.

## Related
`character-turnaround` (whole-character views) · `image-techniques` (PBR maps, cut-outs) ·
`character-kit-assembly` (putting the parts together in Blender).
