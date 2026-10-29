---
name: blender-dev-triage
description: Triage an operator request or failure for the Blender developer seat and write the handoff back. Load BEFORE building anything in response to an operator ask, and BEFORE posting a delivery (the handoff template and evidence vocabulary live here).
---

## 1. Classify first (reply with one)
existing verb/settings · documentation ambiguity · reproduced defect · missing capability · infrastructure/owner blocker.
Give the documented route first when it fits (soil `stones` is a colour [r,g,b], not a count; `shade_smooth` is the smoothing verb). A failed setting is not automatically a feature request; a blocking capability need not fail twice before escalating.

## 2. Packet you need from the operator
Scope/permission and any hold · job + checkpoint (or pinned file) · exact verb/args/error · one or two decisive images or a bounded report · desired observable result · protected elements. Ask only for what stops you reproducing or accepting. Pull extra scene detail on demand.

## 3. Test through the public entrypoint
Run via `verb.mjs` (the path the operator uses), not just the helper: confirm changed-object counts and the saved/exported result. Minimal fixture of the failure; a safe copy of the checkpoint if the failure depends on the asset. Never touch the operator's job. The developer proves the capability; the operator proves the asset. Do not rerun a passed check unless something changed.

## 4. Report vocabulary
Label observed / measured / inferred / unverified. Name the tested revision, input and hash; original hash vs `job_copy` re-saved hash. Say whether an image was actually opened. Bounds and sampled probes are not exhaustive proofs. Correct a claim by saying what changed and what still holds.

## 5. Handoff template (keep short; link long reports)
Outcome: existing route / fix / new capability / blocked · Ready at: doc section + revision + checkout availability · Run: one complete typed settings example · Effects: what changes, dry-run behaviour, outputs, protected inputs · Tested: entrypoint, fixture/copy, pin, checks, views opened · Limits: unsupported, approximations, untested · Operator acceptance: one run/view/check · Next owner.
Then stop; wait for a concrete operator result.

See [tool development](../../docs/guides/tool-development.md) for the reusable workflow.

