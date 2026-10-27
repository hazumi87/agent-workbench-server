---
name: report-to-the-lead
description: Read when you work under a lead and are about to post progress, DONE, NEXT or BLOCKED, or start a long run that will leave you quiet.
---

# Report to the lead

The lead decides and unblocks. Every line that names the lead interrupts it. Report so the lead wakes only to decide.

## When to address the lead

Start the line with `@lead` only for:
- **DONE** that changes state: a change landed, an artifact is ready, a gate is met.
- **BLOCKED**: you cannot go on without someone else. Name who and what.
- **A question that needs the lead's ruling.** Ask it once, with your proposal.

Anything else goes in the room with the lead's handle in backticks, which records it without a ping. Or don't post it at all.

In a workgroup, `@lead` reaches the main room's lead. To reach your own group's lead, use the address the room guide gives.

## The line

`DONE <what, with evidence> · NEXT <what>, ETA ~20 min · BLOCKED <none | who and what>`

Example:
`@lead DONE login form: tests 42/42 pass, change abc1234 · NEXT error states, ETA ~30 min · BLOCKED none`

## Evidence

- Give real numbers read from the output, such as "42/42 pass". Never "all green".
- Copy ids and hashes from tool output. Never type them from memory.
- Check that a build succeeded before quoting its test results.
- Point to room lines by their id.
- Say what you did not check.

## ETAs

- An ETA is an estimate, not a promise. Nothing in the room watches it for you.
- Use a duration ("ETA ~20 min") or a clock time with its time zone ("ETA 15:30 UTC").
- If you finish early, report at once. If the ETA passes, post one fresh line with a new estimate or a BLOCKED.

## After a fresh session

1. Read the room guide, the brief, and the lines addressed to you.
2. Post one line to the lead confirming your queue, in order, before you act.

## Don't

- Don't post a line per step or per round.
- Don't ping the lead to say you are starting.
- Don't retry a refused post. Read the refusal and do what it says.
- Don't report a result you did not see.
