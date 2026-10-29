---
name: blender-tool-handoff
description: "Prepare an operator's reproducible request to the Blender developer and accept the returned documented verb or fix. Use when a modelling step lacks a supported operation, settings are ambiguous, a verb fails/no-ops, or its saved/exported result contradicts the request. Keeps model decisions and real-asset acceptance with the operator, implementation and fixture tests with the developer; routes infrastructure blockers to their owner."
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


# Blender Tool Handoff

Child of [blender-asset-operator](../blender-asset-operator/SKILL.md). This is an exchange protocol, not permission to implement tools, change configuration or restart services.

## Request the smallest missing capability

Read the relevant current verb contract first. Determine whether the issue is an existing route/settings question, ambiguous documentation, reproducible defect, missing capability, or infrastructure blocker. An absent capability need not fail twice before requesting help.

Send the responsible developer one bounded message:

```text
Trying to: [brief and observable modelling outcome]
Tried: [job/checkpoint or pinned input; exact verb and settings]
Got: [exact error or changed-object count; report and 1–2 opened views]
Need: [acceptance view/quantity; what must stay unchanged]
Scope: [authorization, allowance, holds; proposed trial copy]
```

Ask for the outcome rather than prescribing implementation. Supply reference crops when construction matters. Link large evidence; do not paste the project history. For workspace preparation include the planned job name and whether its folder already exists, **before the first step**.

## Accept the tool, then the asset

1. Require a ready revision/doc section, exact typed example, effects and dry-run behaviour, tested scope, outputs and known limits. Use [Handoff and evidence contract](references/handoff-contract.md) if any field is unclear.
2. The developer should test through the public `verb.mjs` path and inspect the saved/exported result, not only a helper. A representative fixture usually suffices; an asset-dependent failure needs a copy of the real checkpoint. The original operator job stays protected.
3. Run the returned example on an appropriate safe copy when first accepting a new or changed capability. Confirm counts, warnings and saved effects; then open the specific acceptance view. A developer fixture pass does not establish the operator asset's quality.
4. Return one scoped observation: settings/input, actual result, checked view/quantity and remaining issue. After two failed attempts at the same fault, write down the method before another. Do not repeat a successful test without a new change, failure or unresolved concern.

## Keep the boundary useful

The operator owns references, modelling choices, verb use, visual acceptance and delivery. The developer owns implementation, regression fixtures, docs and release availability. Runtime behaviour belongs to the runtime owner; storage/service access to its authorized owner. Send a compact contract between roles, not both roles' full context.

Read the addressed thread and reconcile delayed lines against already completed work. Summarize corrections with what changes and what remains valid. Do not interpret a queued send as acknowledgement, an accepted proposal as implementation, or a report-only fix as a geometry change.

Carry existing authorization forward. A real tool/approval denial must be reported with its exact action and reason; do not retry through another route to evade it. Continue unaffected work within scope. The developer's counterpart is [blender-dev](../../skills/blender-dev/SKILL.md); its internals need not be loaded here.
