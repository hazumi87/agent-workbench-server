---
name: safe-handoff
description: Read when you must stop before the work is finished, when another seat or session will take over, or when you resume work someone else handed off.
---

# Safe handoff

A handoff lets someone else continue without guessing. Write it before you stop, address it to whoever owns the next decision, and then stop changing things.

## When to hand off

- You are blocked and cannot go on without someone else.
- You are being reassigned, or your session is ending.
- You have tried the same fault without progress. Follow the limit the person or the project set. If none was set, stop when another try would only repeat the last one.

## What to write

Post ONE line with `room_post`, addressed to the lead. Address it to `@user` if the room has no lead or the person owns the next decision. Include:

- **Item:** what the work is.
- **Tried:** each attempt and its result, with evidence.
- **State:** what is done, what is half done, and what is in flight and must not be touched.
- **Next safe step:** the first thing to do, and what to check before doing it.
- **Owner:** who owns the work now and who decides.
- **Need:** the exact help needed (a decision, an approval, access) and from whom.
- **Refs:** the line ids to read.

Example:
`@lead HANDOFF export button · tried: fixed the date format, tests still fail 3/40 on time zones (#204) · state: format fix done, time-zone fix half done, don't touch the export settings · next safe step: run the time-zone tests alone first · owner: me until reassigned · need: a ruling on UTC or local time in exports · refs: #198 #204`

Check the answer. Take the line id from what `room_post` returned. That id is the handoff's reference. Then stop.

## Resume from a handoff

1. Read the room guide and the brief (`/brief`).
2. Read the referenced lines: `room_read` with `since` set to just below the first id.
3. `room_read` returns only lines addressed to you, never your own seat's lines. If your seat wrote the handoff in an earlier session, you cannot read it back yourself. Ask the lead, or `@user`, to send you the handoff and your queue in a line addressed to you.
4. Check the state the handoff describes before acting. If a referenced line or piece of evidence cannot be found, say so. Don't fill the gap from a guess.
5. Post one line to the lead confirming your queue, in order. Then start with the next safe step.

## When you receive a handoff as lead

- Decide the owner and the next step, or take what needs the person to `@user`.
- When a fresh session takes over a seat, send it one line, addressed to it, that restates the handoff and its queue with the line ids.

## Don't

- Don't keep changing things after you hand off.
- Don't hand off to "whoever is free". Name the owner.
- Don't restart seats or sessions as part of a handoff. That is the person's or the lead's call, through the room.
- Don't claim permissions or approvals the handoff did not record.
