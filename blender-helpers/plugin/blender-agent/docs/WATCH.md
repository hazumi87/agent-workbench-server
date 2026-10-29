# Live watch — for the developer and the Model Studio panel (not for the operator)

After every verb that **saves a checkpoint**, the wrapper (`scripts/verb.mjs`) starts a background capture (`scripts/watch.mjs`, which runs
`scripts/steps/watch_capture.py` in a separate headless Blender on that checkpoint). The operator does nothing, sees nothing, and pays
nothing: the verb returns at once with only a short extra field `"watch":"queued"`. Read-only verbs (checks, probes, `export_kit`,
`fetch`, `post`, `publish`, `kit2_review`, `kit2_look`) never trigger a capture. `kit2_view` files its picture into the latest step (see Agent's view). `kit2_camera` triggers a capture of the latest checkpoint for the new camera (below).

## Where it goes

`rooms/<room>/model-studio-live/` on the room share (disk: `<share-root>/...`):

    index.json                              {"jobs":[{"job","updated","steps"}]}          newest first
    <job>/manifest.json                     see below
    <job>/frames/<cameraId>/<modeId>/<n>.jpg   one 768 x 768 JPEG per camera, per view (mode), per step
    <job>/frames/agent/plain/<n>.jpg        the operator's own close-up (below)
    <job>/frames/agent-wide/plain/<n>.jpg   the same view, zoomed out
    <job>/model/latest.glb                  the light preview model, overwritten each time
    <job>/model/reference.glb               the reference alone, written once per job (below)

`manifest.json` and `index.json` are written last, to a temporary file that is then renamed, so a reader never sees a half-written one.

    {"job","updated" (UTC ISO),"latest":<n>,
     "modes":[{"id":"plain","label":"Plain","short":"Plain"},{"id":"color","label":"Colour on grey reference","short":"A"},
              {"id":"wire","label":"Wireframe on see-through reference","short":"B","alpha":0.5},{"id":"refwire","label":"Grey on reference wireframe","short":"C"}],
     "cameras":[{"id","label","position":[x,y,z],"target":[x,y,z],"fov":<vertical degrees>}, ..., {"id":"agent","label":"Agent's view"},{"id":"agent-wide","label":"Agent's view, zoomed out"}],
     "steps":[{"n","verb","at" (UTC ISO),"note","focus":"<object, joint or clip name>" (when the verb has one subject),"focus_nodes":[...] (when it has several),"opening":true (first capture only),"frames":{"<cameraId>":{"<modeId>":"frames/<cameraId>/<modeId>/<n>.jpg"}}}],
     "model":{"file":"model/latest.glb","step":<n>},
     "reference":{"file":"model/reference.glb","solid":"ref","grid":"ref-grid"}}

`cameras` are in the order shown: the stored default set, then the operator's saved cameras in the order saved, then `agent` and `agent-wide` (no pose).
`note` is one short line made from the verb, its settings and its result (for example "placed harness (fit error 3.5 mm)").
A step has a frame only for the cameras that existed when it was captured; a camera saved later gets a frame for the latest step only.
`agent` and `agent-wide` have the one mode `plain`. Manifests written before the modes existed had a plain string per camera; the next capture of a
job rewrites those as `{"plain": <old path>}` (the old files are the plain view).

## Camera poses and the coordinate convention

- **Poses in the manifest are in the GLB's own space.** glTF is Y-up and the Blender scene is Z-up, so a Blender point `[x, y, z]` is written
  `[x, z, -y]` (metres), for `position` and `target`. The character faces +Z in the GLB (it faces -Y in Blender); its left hand is +X in both.
- `fov` is the **vertical** field of view in degrees. Every frame is **square**, so it is also the horizontal field of view.
- The same cameras are **camera nodes in `model/latest.glb`**, named by camera id (perspective, `yfov` = `fov`, aspect 1, near 0.02 m, far 60 m).
  A glTF camera looks along its own -Z; a viewer that places its camera at `position` looking at `target` sees the frame's framing.
- Default cameras: 21, perspective, 2.5 m from the target (front, back, left, right, top, chest, waist, waist-below, waist-side, wrist-left,
  wrist-right, foot, feet-top, foot-left-side, foot-right-side, foot-left-34, foot-right-34, elbow-left, elbow-right, arm-left-end, arm-right-end). `arm-left-end` / `arm-right-end` look back along each arm from beyond the fingertips toward the elbow and shoulder, a little in front of and above the arm's axis (fov 32), so the hand is nearest, then the wrist and forearm with the whole ring of a cuff visible; they are placed from the reference's measured arm (fingertip, narrowest cross-section = wrist, elbow at the template proportion). `feet-top` (both feet from in front and 50 degrees above) and the four `foot-*` cameras are placed per character, from the reference's measured feet (centre, length, width, stance) by `kit2_cams.py` at every capture; the manifest and the GLB carry the poses actually used. The other cameras are fixed numbers for a 0.8 m T-pose character. The operator's saved cameras are added after them.
- **Checks:** the exported GLB's camera nodes can be read back and compared with the manifest poses; load the GLB in an empty scene and compare a stored frame with the render to confirm a camera matches. Verify your own viewer separately.

## What a frame shows: the four views

Every camera of a step is rendered in four views (`modes` in the manifest; the letters are the Watch tab's buttons and what the user calls view A/B/C):

- `plain` (**Plain**): the body and all current parts in colour; the reference hidden. **Opening shot:** the first capture of a job (the reference imported,
  no parts yet) shows the reference instead, in every camera (`"opening": true` on that step).
- `color` (**A**): the reference solid grey, the parts in colour.
- `wire` (**B**): the reference in colour and **see-through at opacity 0.5** (`wire_alpha`, a job setting, also written as `alpha` on the mode), the parts as
  bright yellow wireframe. Lines behind the reference surface look dimmer through it.
- `refwire` (**C**): the reference as a cyan wireframe grid, the parts solid grey.

Wireframe is real geometry, because Workbench's final render ignores its wireframe shading: each part is reduced to a quarter of its triangles and given a
Wireframe modifier (2 mm struts); the reference is voxel-remeshed to a 12 mm grid and wired (1.2 mm struts). They are built once per capture
**No normal maps** in any view (Workbench's texture colour does not use them); studio lighting with a specular highlight, no shadows or cavity.
The exported model keeps its normal maps. Textures are downscaled to 1024 px (a cache by content hash in `work/<job>/watch/cache/`).
Engine: **Workbench** (studio lighting, texture colour, standard colour transform, +0.45 exposure). Metals show as light grey. It uses the GPU through
OpenGL for a few seconds per step with modest VRAM; it starts and stops no service. With another engine only `plain` is rendered.
Settings per job (`verb.mjs <job> watch --b64 ...`): `engine` (`workbench` default | `cycles` | `eevee`), `samples`, `tex` (default 1024), `res` (default 768),
`model_every`, `modes` (a list of mode ids to render; default all four), `wire_alpha` (default 0.5), `enabled`.


## `model/latest.glb` and `model/reference.glb`

`latest.glb` holds exactly what the Plain view shows: the body and every current part (the objects of the scene without `ref`), and never the reference,
except at the opening shot, where the scene holds only the reference and so does the file. It carries all cameras as nodes, is rewritten at every step
(`model_every`), and uses the same space as the frames (glTF Y up).

`reference.glb` is written ONCE per job: at the opening capture, again only when a capture follows an `import_mesh` (a re-imported reference), and
whenever the file is missing. Same space and scale as `latest.glb`, no cameras, two nodes:
- `ref`: the reference mesh with its colour texture (1024 px), reduced to about 125 000 triangles (`ref_tris`) with a collapse decimation; stray edges removed.
- `ref-grid`: the voxel grid of view C (12 mm voxels) as **edges only**: one glTF LINES primitive (mode 1), no faces, no struts, with a flat material the viewer can ignore.
The manifest names it: `"reference":{"file":"model/reference.glb","solid":"ref","grid":"ref-grid"}`. It costs a few seconds once (a decimation); a
whole-character file is about 5.7 MB.

## `focus`

`steps[].focus` is the name of the part the verb acted on: the scene's object name (the node name in `latest.glb`) for `kit2_part`, `kit2_transform`,
`kit2_bodyedit`, `kit2_tweak` (when it names one object), `kit2_restore` (one object), `body` for `kit2_body` and `rig_biped`, the joint for `rig_joint`,
the clip name for `rig_clip`. A pair (`kit2_part` with `pair`) has `focus` = the base name and `focus_nodes` = `["name_L","name_R"]`; a verb with several
subjects has `focus_nodes` only; a verb with no single subject has neither.

## Agent's view and looks: the operator and the watch see the same pictures

The operator opens the watch's own frames with the `kit2_look` verb (share refs of any camera, view and step); it makes no separate render of a standard view.
Everything the operator renders itself (`kit2_view`, `kit2_review`) is recorded in the watch **at the latest step** in a per-step list:

    "looks":[{"file":"looks/<n>/<label>-<ms>.jpg","wide":"looks/<n>/<label>-<ms>-wide.jpg" | null,"at":<UTC ISO>,"label":"<picture name>"}]

in the order rendered, accumulating over several calls. `file` is the picture (768 px wide; a sheet or a review pair 1024), `wide` its zoomed-out companion
(kit2_view only). The last close-up of the last `kit2_view` call is also the camera `agent`, and its companion `agent-wide`
(`frames.agent.plain`, `frames.agent-wide.plain`): two separate pictures, never composited, so a panel that only knows `frames` keeps working.
`kit2_view` renders in the watch's own Workbench look by default (same lighting, no normal maps, same `wire_alpha`). `kit2_review` pictures are looks but do not
change `agent`. The frame strips of `rig_motion` (filed at the latest step) and of `rig_clip` (filed at the step that applied the clip) are looks too: labels `rig-<motion>` and `rig-clip-<clip>`, one horizontal strip of 4 to 6 pictures. A call before any saved step has nothing to attach to and is not filed. The capture of a saving verb no longer sweeps up old PNGs: a picture is
filed when it is rendered. If the step's own capture is still running, the filing waits for the step to appear in the manifest (up to 60 s).

## Switching it off, and failure

- Per job: `node scripts\verb.mjs <job> watch --b64 <{"enabled":false}>` (writes `work/<job>/watch.json`); `true` switches it back on.
  Everywhere: set the environment variable `BLENDER_AGENT_WATCH=0`.
- A capture failure never fails or slows the verb. It is caught and written to `work/<job>/watch/log.jsonl` (one line per capture with
  timings and `errors`, or `ok:false` and the error). Tested: a deliberately bad setting made the capture fail while the verb returned `ok:true`.
- Captures of one job run one at a time (a lock file); two captures started together both finished and both frames reached the manifest.
- Per-capture working files (args, report, log, task) stay in `work/<job>/watch/`.

## Cost

The verb only starts the background capture (tens of milliseconds); the capture runs after it and its time grows with the number of views, cameras, parts and textures. Textures are decoded once and cached by content hash, so later captures of a job are faster than the first. Time it on your own scene before relying on a figure. Model size grows with the mesh and the number of camera nodes.
