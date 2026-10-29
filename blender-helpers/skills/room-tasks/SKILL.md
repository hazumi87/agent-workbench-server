---
name: room-tasks
description: "Create or update tasks through an installed workroom task integration without duplicating existing project records."
---

# Workroom tasks (optional integration)

This package does not include a task-board service. Use the current workroom's documented task
API if one is configured; otherwise keep a local task record or request the missing integration.
Do not guess installation paths, service credentials, project IDs or task schemas.

Find an existing task before creating one. Prefer attaching/flagging it into a room over copying
it to a second project. Use the integration's permission model and canonical task ID. Resolve the
target room, project and assignee from current tool results, not a historical example.

Distinguish creation, status, assignment, pinning and removing a room association. Removing an
association should not delete the underlying task. Do not close another owner's task or change
its scope without the relevant authorization. After a mutation, read back the task and report its
ID, meaningful change and remaining blocker.

For errors, preserve the exact response. A missing project, unlinked task, permission denial and
unavailable service need different fixes. Route configuration/lifecycle work to its owner; do not
make duplicate tasks or route around a denied operation.
