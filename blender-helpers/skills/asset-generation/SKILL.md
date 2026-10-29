---
name: asset-generation
description: Start here for any request to make an asset from generated images or models — pictures, icons, backgrounds and seamless tiles, PBR maps, character views and parts, image-to-3D models, rigging, rooms and props in Blender, and the review that puts the result in front of user. A map of the Asset Studio workflow that tells you which specific skill, tool and standing rule fits your scenario. Load FIRST when asked to generate, fix, review or hand over any image or 3D asset, then follow its pointer to the specific skill.
---

# Asset generation: the map

Read this page, pick your row, load that skill. Each specific skill holds the tested recipe, the tool calls and the traps; this page holds only the routing and the rules that apply to everything.

## 1. Which skill for which job
| You are asked to... | Load | Core tool |
|---|---|---|
| Generate or edit pictures (a prompt, references, draft then full size) | this page, §3, then `image-techniques` | Asset Studio verbs (`scripts/studio.sh`), Krea 2 |
| Make an icon, SVG, layered cut-out, de-lit albedo or any PBR map from a picture; remove a background | `image-techniques` | image-ops kit |
| Make a repeating background tile or wallpaper (inspiration, elements, collage, scale in the room) | `seamless-tiles` | tile-builder `tile.mjs`, chat test page |
| Check a tile or texture for seams, a grid, edge bias, blotches; repair it | `seamless-textures` | tile-builder `seam.mjs` |
| Views of one character (front, left, back, right, T-pose) for image-to-3D | `character-turnaround` | Asset Studio |
| One clean picture per PART (body, head, hand, garment, armour) | `character-kit-parts` | Asset Studio |
| Turn pictures into a 3D mesh; quote and run a Scenario job | `model-generation` | `scenario.mjs` (quote, then run) |
| Dress a body with separate part meshes, swap a head or hand, check fit | `character-kit-assembly` | Blender verbs (server) |
| Give a body a skeleton, apply animation clips, export a rigged GLB | `character-rigging` | Blender verbs (server) |
| Build a room or props in Blender (blockout, then colour) | this page §4; packaged Blender verb reference | Blender verbs |
| Move or look at a file, image or zip between agents, user and the server | `agent-share` | share at :8215 |
| Put results in front of user to rate, mark up or approve | this page §5 | `review_add` |

## 2. The pipeline in one line
Pictures (Asset Studio) → cut-outs and maps (image-ops, tile-builder) → mesh (Scenario, `model-generation`) → fit, rig, colour (Blender) → review (`review_add`) → Library. Every image and mesh ends up in the Library with its recipe; Library ids are how steps hand over.

## 3. Pictures: the short version
Asset Studio is a room app: set model, prompt, references and size, `generate`, then LOOK at each result and judge it against the ask. Draft first (`draft: true`), full size for the keeper. References must be images the room made or brought in (`import_ref`). `for: "user"` only when user asked for that render. Details and verbs: `plugin/asset-studio/README.md` and `tool.json`. Passes combine as layers only if every edit keeps the exact position (say so in each prompt).

## 4. Rooms and props (Blender, from video)
Inputs: the reference bundle (room point cloud, camera data, transforms, stills). Build a blockout of floor, walls and the biggest pieces as editable quads at provisional scale, every dimension labelled estimated or inferred; show clay views; then colour; keep a manifest. The final scale and camera fit belongs to whoever integrates it into the scene.

## 5. Review: how results reach user
Use the unified review (`review_add`: purpose status, feedback or vote; a "what changed" summary; one-sentence ask; limits; up to 12 images with a caption per view; the model's Library id among the images for the 3D tile; `.blend`, GLB and manifest as `files`). Entries in `plugin/asset-studio/tool.json` give the exact inputs; `review_look` shows it as user sees it. A tile review shows the tiled or compare picture, not the single tile. user's ratings and pins come back as one line to the requester; pins are readable with `review_marks`.

## 6. Standing rules (all asset work)
- **Credits:** Scenario and any paid step: quote first, then user's "go, N credits". Never start, stop or restart a server service; the GPU is user's. Release the GPU after renders (`release_gpu`).
- **Budgets and limits are user's:** never raise your own. Ask for an explicit allowance (hours or a stop point) and a check-in time before a long run; the clock is guidance but a stop point is a stop.
- Confirm resource limits before memory-intensive image processing; use a bounded resolution and inspect the result.
- **Work on copies; originals and accepted checkpoints are preserved.**
- **Reporting:** milestones, blockers and decisions only. No step-by-step posts, no runner-state lines; keep a running log in your own folder. Don't `@mention` an agent unless it must act (the line is typed into its pane and costs it a turn). One message per request to a developer, with the evidence. Show pictures and numbers, and say plainly what is still wrong.
- **Look before you claim.** Open the file, the view or the number; say what you did not open.
- **Verify against the real thing:** the deployed asset, the live URL, the audit numbers, not a plan or a doc.

## Related
`image-techniques` · `seamless-tiles` · `seamless-textures` · `character-turnaround` · `character-kit-parts` · `model-generation` · `character-kit-assembly` · `character-rigging` · `agent-share`.
