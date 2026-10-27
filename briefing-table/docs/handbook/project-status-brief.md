---
name: project-status-brief
description: Read when the person asks "where are we?", asks for a status brief or a project status, or asks how things moved since the last brief.
---

# Project status brief

A status brief tells the person where the work stands: each deliverable, how far along it is, how long it has left, and when it should land in the person's own time. It is one room line, addressed to `@user`. The line's id is its reference.

## Before you write

1. **Find the person's time zone.** Use the time zone your room guide shows. If it shows none, ask once: "What local time zone are you in?" Use the person's answer for this brief, and keep the answer's line id so you can read it again. You can't save it anywhere else.
2. **Collect the numbers.** Take progress from the room's Tasks where your room guide gives you a way to read them, and from the seats' own reports with evidence (line ids, change ids, test counts). Never invent a percentage. If nothing measures a deliverable, write "not measured" and say what would measure it.
3. **Find the baseline.** The first brief you post is the baseline. Keep its line id. For a later brief, read the baseline line with `room_read` and compare with it.

## The format

Post ONE room line with `room_post` (one post, within the 4000-character line limit), with each row below on its own text line inside it:

- The first row: `@user STATUS BRIEF <today's date and time, the person's local time>`, and `· baseline #<id>` for any brief after the first.
- One row per deliverable, in two parts: `<deliverable, a few words> | <% done> · <time left> · est. <delivery, the person's local time> (<the same time in UTC>) · <where it fits>`.
  - "Where it fits" uses the room's own milestone words, for example: the current release, before handoff, after it.
  - The delivery estimate is now plus the time left, written in the person's local time with the zone named.
  - An item that waits on the person ends with `· waiting on you: <the decision or approval, in a few words>`. Its time left starts only when the person answers; say so.
- The last row: `Overall: <one sentence: when the current milestone lands, in the person's local time, and what most decides it>`.

Example (a later brief; all six rows are one post):
`@user STATUS BRIEF Tue 3:10 PM PDT · baseline <prior-brief-id>`
`Login form | 90% done · ~1 h left · est. 4:10 PM PDT (11:10 PM UTC) · current release`
`Export button | 40% done · ~3 h left · est. 6:10 PM PDT (1:10 AM UTC) · current release · slipped: was 4:00 PM PDT, the time-zone tests failed`
`Account page | not started · ~2 h after your answer · before handoff · waiting on you: which sign-in methods to offer`
`Audit log | 0% done · ~4 h left · est. 7:10 PM PDT (2:10 AM UTC) · after handoff · new since baseline`
`Overall: the current release lands about 6:10 PM PDT today; the export tests decide it.`

## Comparing with the baseline

For every deliverable, compare the estimate with the baseline's and mark the change at the end of its row:
- `moved: was <old estimate>` when it lands earlier;
- `slipped: was <old estimate>, <why, in a few words>` when it lands later;
- `new since baseline` for a deliverable the baseline did not have;
- `dropped since baseline: <why>` for one that left the plan.
An unchanged row gets no mark.

## Notes are the person's

The person can keep a brief in a room Note. Notes are created and edited by the person only. You cannot write, edit or save Notes. The baseline is a room line, so keep its id.

## Don't

- Don't invent a percentage or a time. Write "not measured" or "no estimate yet" and say why.
- Don't give times in your own time zone or only in UTC. The person reads their local time first.
- Don't ask the person's time zone again once you have their answer's line id: read that line. Never ask where they are.
- Don't write a brief as a series of separate posts. One line per brief.
- Don't change tasks because a brief says they changed.
