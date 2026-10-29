# Advice from the Blender developer seat to the operator

Written at the user's request. Role boundary: the developer seat owns verbs, kinds, tests and `OPERATOR-VERBS.md`; the operator owns using them, references, visual acceptance and published assets. This file is advice only; it adds no rules.

## Before a job starts (the three surprises we hit)
1. **Disk.** Check free disk space first. If a job will write many checkpoints (about 100 MB each), create the large-disk link BEFORE its first step: a directory link from `work/<job>` to a large disk (`ln -s /big-disk/blender-work/<job> work/<job>` on Linux). It cannot be moved after files exist without a copy.
2. **Library file limit.** Library takes at most 105 MB per file. Run `source_slim` with `dry_run` on the checkpoint you plan to publish as source; it reports `fits`. Then `publish` with `source_to` (dry_run first).
3. **Provenance.** Pass `room` on publish so the origin room is right; it cannot be patched later until the Library change is deployed.

## When you ask for a tool or report a failure
- Send: the job name and checkpoint, the exact args you passed, the exact error text, what you tried, and the target (size, look, limit). The soil IndexError was solved in one step once the args were visible (`stones` is a colour, not a count).
- Say what "done" looks like (a measurement or a picture), so I can test against it instead of guessing.
- Name what you will NOT accept (e.g. "no baking"), so I do not build around it.

## When a new verb or kind lands
- Re-read its section in `OPERATOR-VERBS.md` (the share copy is refreshed after each merge) and note the "limits" sentence before using it.
- Trial it once on a throwaway job, then use it on the real job. Do not trial on a checkpoint you cannot lose.
- Tell me which limit bit you. A limit that bites twice becomes a feature request.

## Copy, don't retype
Library ids, hashes and job names go in by copy from tool output. One mistyped GLB id cost a round trip.

## Handing back
- Post results as: what you ran, what you measured, what you saw. Mark anything you did not verify.
- Disk and Library-filing questions go to the user or Platform, not to me; I cannot delete, deploy or restart either.

## Deletions
Your "no additional approval needed" does not replace the user's own yes. List folders with sizes and ask the user.

## What the developer seat will change in its own docs (not done yet)
- Add a short "Before you start" checklist to the top of `OPERATOR-VERBS.md` (disk, junction, 105 MB limit, publish room).
- Add a "Known limits" line to every verb section, and a dated change list.
- Keep one known-good example args block per verb.
