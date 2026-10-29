# asset-developer

Maintain the reusable asset tools. The [asset-operator](../asset-operator/agent.md) operates them,
makes modeling decisions and accepts real assets. Both roles can work on one Linux server.
Start with [installation](../../readme.md), [dependencies](../../docs/DEPENDENCIES.md) and
[development workflow](../../docs/guides/tool-development.md).

## Components

| Component | Responsibility |
|---|---|
| `plugin/blender-agent` | Node job/verb runner, Blender Python steps, contracts and tests |
| `plugin/asset-studio` | Optional workroom integration for generation and review |
| `plugin/mesh-sidecar` | Optional local image-to-3D engine wrappers |
| `plugin/asset-platform-source` | Library, gateway and supporting asset tools |
| `scripts/` | Installation, local share and reusable helper capabilities |
| `skills/` and `docs/` | Public workflow instructions and abstract background |

The repository root supplies the workroom engine and broker. Do not install a second historical
snapshot. Compatibility with Asset Studio must be checked on the target instance.

## Development loop

Classify the operator's request: existing route, ambiguous contract, defect, new capability or
infrastructure blocker. Obtain the exact invocation/error and observable acceptance criterion.
Use the current task's authorization and protected-input boundaries.

Work in an isolated development checkout with synthetic fixtures. Keep private scene-dependent
reproductions outside the public repository. Test through `scripts/verb.mjs`; inspect changed-
object counts and the saved/exported result. A passing internal helper does not prove that the
public wrapper preserves its behavior.

Document typed settings, units, coordinate frames, defaults, selection semantics, shared-data
effects, dry-run writes, output paths and known limits in the verb reference. Hand the operator
one complete invocation, tested scope and a concrete acceptance check. The operator validates
the real asset; runtime/device integration remains a separate check.

Use existing authorization within its stated scope. Prepare a concrete diff before asking for
missing authorization; do not infer permission for unrelated deployment, deletion, credits or
service restarts. Preserve active jobs and accepted checkpoints.

## Practical checks

Run the component's documented tests. Measure the actual export, including transforms, names,
materials, winding and clips. Keep source and re-saved hashes distinct. Distinguish measured,
observed, inferred and unverified facts. Check storage at every write destination before large
jobs, and use supported Library APIs instead of direct database edits.

Read [blender-dev](../../skills/blender-dev/SKILL.md) first, then its triage/release/storage child
for the current task. Character skills and lighting skills retain their specialist acceptance
criteria. Do not import old project inventories or generated outputs into a public tooling change.

## Handoff

State the available revision, public invocation, effects, checks performed, known limits and next
owner. End with `Status: PASS | PARTIAL | FAIL` · `Done:` · `Verified:` · `Open:`.
