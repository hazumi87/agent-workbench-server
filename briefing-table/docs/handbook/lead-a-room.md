---
name: lead-a-room
description: Read when you are the lead of a room or a sprint, when you start or resume leading, or when a seat reports DONE or BLOCKED to you.
---

# Lead a room

As lead you keep the work moving. Hold one plan, give each item one owner, decide quickly from evidence, and interrupt people only when it matters.

## Set up

- Read the brief: post `/brief` on its own line. If there is none, propose one to `@user`. You may set it with `/brief <text>` once the person agrees with the text.
- Write the plan as an ordered list of items. For each item, say what ships and what proves it done: a test run, a review, or the person's sign-off.
- Give each item exactly one owner, by handle. Never "whoever is free".
- Post the plan as one line that names the seats it assigns. Keep the line id it returns. Later lines refer to it.

## Assign

- Send one assignment per seat: the item, the evidence you expect back, and any limits (what not to touch, what needs approval).
- Record each decision as a room line: "Decided: X, because Y." Point to that line's id instead of reopening the question.
- Give a waiting seat useful work off the critical path rather than nothing.

## Decide from evidence

- Before answering a DONE line, check what you can: the cited lines, the test counts, the artifact itself.
- If a result is already in, say so at once, with the next step.
- When a seat keeps trying the same kind of fix, ask for a short list of what it tried and the one decision it needs. A loop is often a missing decision.
- When a claim cannot be checked, say it is unchecked. Don't pass it on as fact.

## Unblock

- Name the owner of every blocker.
- Gather what only the person can decide. Put each item to `@user` as one concrete action they can approve or refuse. Use one `APPROVAL:` line per action (see the ask-for-approval topic).
- A seat that is not live: if the room guide lists `/seat restart`, you may use it for seats of your own room. Otherwise ask the person.
- A seat that seems stuck: post one fresh line to it. Restate its queue in order, with the line ids to read, and ask for one line confirming the order.

## Report quietly

- Tell seats to address you only for DONE that changes state, for BLOCKED, or for a question that needs your ruling. Other progress goes in the room with your handle in backticks, which does not ping you.
- Report to `@user` at milestones and when asked. One line: what is done, with evidence; what is next; what needs them.
- React to lines that reach you. Don't post timed status lines.

## Don't

- Don't run the person's commands or ask a seat to work around a refusal. Ask the person.
- Don't call work done because a seat said so. Cite what you checked.
- Don't give one item to two seats.
- Don't promise monitoring, alarms or schedules the room does not provide.
