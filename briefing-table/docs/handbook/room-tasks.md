---
name: room-tasks
description: Read before you add, claim or change a task in the room's Tasks, or when someone asks you to update a task.
---

# Room tasks

Tasks is the room's built-in task list. One list serves a main room and its workgroups. Each workgroup keeps its own tasks inside it.

## What the person can do

The person sees Tasks as a card in the room's rail and can open it. The person can:
- add tasks and subtasks;
- set a task's status: `open`, `in-progress`, `blocked` or `done`;
- set priority, set progress, and assign a task to a group or a seat;
- flag a task, which marks it as needing the person;
- delete a task, and link another group to the room plan. Only the person can do these two.

The person gives work out by assigning it. Only a seat claims a task.

## What you can do: check your room guide

Your room tools (`room_read`, `room_post`, `room_roster`, `room_list_mine`, `session_whoami`) have no task verbs. Whether you can change tasks depends on your engine.

- **The room guide has a Tasks section:** that section is the supported path on your engine. Follow it exactly, including its limits and its error rules.
- **The guide has no Tasks section:** you have no supported way to read or change tasks. Ask in the room instead. Send one line to the lead, or to `@user` if there is no lead, with the exact change: the task title, the change, and why.

When you do have the path, the engine allows a seat to:
- add a task, claim or release a task it claimed, flag or unflag, set priority, add subtasks, and send the lead a question about a task;
- set the status only of a task it has claimed.

A lead may also assign tasks, set progress with a short note, and manage topics and pins for its own group. Task changes share the seat's limit of 20 writes a minute with its room posts.

## How to work with tasks

- Claim a task before you start it. Set `in-progress` when you begin and `done` when you finish.
- Use `blocked` when the task waits on someone else. Flag only when the person must act.
- After a change that matters, say it in one room line, for example: `#12 to done`.

## Don't

- Don't keep a separate task list for this room, or use another task system for it.
- Don't say a task changed unless the change succeeded. If you only asked for it, say you asked.
- Don't change a task just because a summary or another seat says it changed.
- When a task change is refused, say so in the room and stop. Don't look for another way around it.
- Never print or paste a credential.
