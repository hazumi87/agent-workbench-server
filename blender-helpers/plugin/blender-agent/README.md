# blender-agent

A headless Blender workshop driven by small, named **steps** ("verbs"). It takes a mesh (usually
an image-to-3D result), repairs and optimises it, unwraps/bakes textures, rigs and animates
characters, lights and bakes scenes, assembles parts, checks the result, and exports GLB/FBX. Every
step is one Blender process that opens the previous checkpoint `.blend`, does one thing, saves the
next checkpoint and writes a JSON report, so every job is replayable and every intermediate state
can be inspected.

It is a tool for an agent or a person at a terminal. It has no UI.

## How it works

```
node scripts/verb.mjs <job> <verb> --b64 <base64 of the settings JSON>
     -> scripts/run-step.mjs -> blender --factory-startup -b <latest.blend> --python scripts/steps/<verb>.py -- <args>
     -> work/<job>/NN-<verb>.blend (checkpoint) + NN-<verb>.report.json + out/ (pictures, exports)
```

- A **verb is a step file**: `scripts/steps/<name>.py`. There is no registry. Built-in verbs that
  are not steps: `fetch`, `post`, `publish`, `journal`, `watch`, `bake_progress`.
- A **job** is a folder `work/<job>/` (lowercase letters, digits, `-`). `job.json` records the steps
  that produced the current state. `--from N` branches from checkpoint N.
- **Recipes** (`recipes/*.json`) chain steps. The three shipped ones are templates: `rig-biped`
  (T/A-pose biped mesh to a rigged, animated character), `texture-rig-biped`, `bust-mouth`
  (mouth shape keys for a head/bust).
- Settings travel as base64 JSON so shell quoting cannot corrupt them.
- Only one verb runs at a time per checkout (`status/.lock`; it is per checkout, not machine-wide).

## Install

Requirements: Linux (or macOS/Windows), Node.js >= 20 (no npm dependencies), Blender 4.5 LTS.
Optional: `numpy`, `scipy`, `Pillow` in Blender's Python for some steps; a venv with `mediapipe`
for `face_landmarks`; `gltfpack` + `three` (npm) for the meshopt export step.

```bash
cp config.example.json config.local.json      # then edit; config.local.json is not committed
export BLENDER_AGENT_BLENDER=/path/to/blender # overrides config "blender"
npm test                                      # runner + job-server tests with a stub Blender
node scripts/preflight.mjs                    # blender / library / share / gpu; exit 0 = ready
```

`config.local.json` keys: `blender` (binary), `libraryUrl` (the Asset Library API base),
`shareUrl` + `shareRoot` + `shareDir` (a file drop for pictures and reports; `preflight` needs
`GET <shareUrl>/health`; `scripts/mini-share.py` in the parent package is a minimal stand-in),
`postRooms` (allowed destination folders for the `post` verb), `room` (provenance recorded on
published assets), `tokenHashFile` (only for `job-server.mjs`: the sha256 of its bearer token).

## Everyday use

```bash
S=$(printf '%s' '{"ids":["<library-mesh-id>"]}' | base64 -w0)
node scripts/verb.mjs my-job fetch --b64 "$S"                       # put Library meshes in downloads/library/
S=$(printf '%s' '{"src":"downloads/library/<library-mesh-id>.glb"}' | base64 -w0)
node scripts/verb.mjs my-job import_mesh --b64 "$S"                 # the imported mesh becomes the reference
node scripts/verb.mjs my-job journal --b64 "$(printf '{}' | base64 -w0)"   # what ran, with settings and errors
node scripts/run-recipe.mjs my-job recipes/rig-biped.json           # a whole recipe
node scripts/publish.mjs job my-job <input-library-id>              # GLB + FBX + preview into the Library
```

`docs/OPERATOR-VERBS.md` is the verb reference: every verb with its settings, an example, its
limits and what it returns. `docs/OPERATOR-ADVICE.md` is a short list of habits that avoid the usual
surprises (disk space, the Library file-size limit, provenance, how to report a failure).
`docs/WATCH.md` describes the live-capture ("watch") frames written after each saving verb.

## What it covers

Import and clean-up; decimation and UV unwrap; texture projection, baking and PBR map packing;
Rigify-based rigging, skinning, idle/motion clips, game-ready one-root skeletons; shape-key mouths;
lighting and ambient-occlusion/lightmap baking for scenes; kit assembly (fitting separately
generated parts to a reference); orientation, overlap and exposure audits; render views
(`kit2_view`, `kit2_look`); validation; GLB/FBX/meshopt export; Library publishing with lineage.

## Deliberate choices

- Blender is pinned (4.5 LTS) and run headless, one step per process, so state is the saved `.blend`.
- GLB is the primary output (three.js); FBX is written alongside for Unity-style humanoid use.
- Deform skeleton: Rigify `DEF-` bones including fingers, at most 4 weights per vertex.
- Mouths and expressions are shape keys, not face bones.
- Hand-fitted or heuristic results (rig joint placement, landmark-based mouth cuts) are checked from
  renders of the mesh itself, not from the drawings it came from.

## Known limits

- Recipes and steps written for T/A-posed, front-facing (-Y) biped characters assume that pose.
- Heat-map skin weights fail on multi-shell/scan meshes and very small models; `skin` falls back to a
  voxel proxy (`method: "proxy"` in its report).
- Modifiers cannot be applied under shape keys; do geometry work before `mouth_keys`.
- The Library accepts files up to about 105 MB; use `source_slim` with `dry_run`, then `publish` with `source_to`.
- The rig verbs need a rig template that you supply (none is shipped): see `docs/RIG-TEMPLATE.md`. Without one they fail with a message that says where to put it.
- Steps named `dev_*.py` are synthetic self-tests, not production verbs.
- Windows-only defaults were removed; set the paths above for your machine.
