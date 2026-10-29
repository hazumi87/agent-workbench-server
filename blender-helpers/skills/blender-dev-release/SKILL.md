---
name: blender-dev-release
description: "Implement and validate Blender workshop changes through the operator entrypoint, document their contracts and prepare an authorized release."
---

# Build and release a Blender capability

Use a separate development checkout and a fresh job directory. Reproduce the problem with a
synthetic fixture when possible; keep private scene-dependent reproductions outside the public repo.

1. State the required observable result and protected inputs. Modify the smallest relevant operation.
2. Test through `scripts/verb.mjs`, including argument parsing, affected-object counts, checkpoint
   saving and the exported result. A helper-level test alone does not cover the operator's path.
3. Run the applicable unit checks and one representative behavior check. Repeat broader tests only
   for new changes, failures or unresolved concerns.
4. Document typed required/optional settings, units, coordinate frame, defaults, selection rules,
   shared-data effects, dry-run writes, outputs, known limits and a synthetic example.
5. Prepare a reviewable diff and release summary. Use the user's existing authorization for the
   stated release; obtain any missing authorization before outward changes. Coordinate installation
   with the owner of running jobs; a successful merge does not prove an installed version is active.

Hand back the exact documented invocation, availability, tested scope, limitations and one
operator acceptance check. Never publish a private scene as a test fixture or attach raw job history
to a public change. Review examples, hidden files and generated bundles as well as source changes.
