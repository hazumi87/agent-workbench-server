---
name: summaries
description: Read when you are asked for your session summary, when your work stretch ends, or when you lead a room and the person asks for a room roll-up.
---

# Summaries

A summary is one room line, posted by the seat that did the work. The line's id is its reference. Write a seat summary for your own session. A lead writes a room roll-up from the seats' summaries.

## Your session summary

Write one when someone asks for it, or when your stretch of work ends.

Post ONE line with `room_post`, addressed to the lead (in a workgroup, the address the room guide gives for your group's lead). Address it to `@user` if the room has no lead or the person asked you directly. Keep it within the 4000-character line limit. Include:

- **Task:** what you were asked to do.
- **Done:** what you did, with evidence: line ids, change ids, real test counts.
- **Decisions:** what you decided and why.
- **Blocked:** each blocker and who owns it.
- **Hands off:** work in flight that others must not touch, and until when.
- **Next:** the first thing the next session should do.
- **Refs:** the line ids someone needs to read.

Example:
`@lead SUMMARY task: login form · done: form and validation, tests 42/42 pass (change abc1234) · decided: server-side checks only, the client copy drifted · blocked: none · hands off: the auth settings until review · next: error states · refs: #118 #131`

Then check the answer. Take the line id from what `room_post` returned. If the post was refused, say so. Never say a summary exists if you did not see its id.

## The room roll-up (lead)

Do this when the person asks, or at a milestone. Not every round.

1. Ask once, in one line that names each seat: `@builder @writer please post your session summary to me.` Write your own summary too.
2. Wait for seats that are live on `room_roster`. List the others as "no summary (not live)". A seat that does not answer gets one reminder. After that, list it as "no summary".
3. Read the summaries that reach you with `room_read`. Check the cited lines and evidence you can read. Mark anything you could not check.
4. Post ONE roll-up line to `@user`:
   - the room's goal and current focus, in one line;
   - per seat: done, decisions, blockers, next;
   - what needs the person: decisions or approvals only they can give;
   - blockers owned by others;
   - work in flight that must not be touched;
   - the summary line ids it covers, and the seats with no summary.
5. Keep the roll-up line's id. That is the room's reference for this summary.

## Notes are the person's

The person can keep a summary in a room Note. Notes are created and edited by the person only. You cannot write, edit or save Notes. When a line references `[note: <id>]`, your copy of the line carries the note's text.

## Don't

- Don't change task states because a summary says they changed. Raise the difference in the room instead.
- Don't fill gaps from memory. If a summary or a cited line is missing, say so.
- Don't write a summary as a series of lines. One line per summary.
- Don't restart seats or reset their sessions as part of a summary.
