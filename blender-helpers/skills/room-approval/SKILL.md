---
name: room-approval
description: "Present a concrete action for approval through an available workroom approval UI when authorization is missing; recognize existing authorization."
---

# Workroom approval

Use this only when the action needs authorization that the current conversation has not already
provided. A request to carry out a specific action can supply that authority; do not ask the user
to approve the same scope again merely because its implementation is now ready.

Before asking, make the proposed result reviewable. State the exact destination, affected scope,
and any material irreversible effect. Separate a normal removal commit from rewriting public
history. Ask for the missing choice directly when the issue is scope rather than permission.

If the installed workroom supports `APPROVAL:` messages, use its documented syntax and reply
tracking. Other runtimes may use ordinary text or a native approval tool. Do not require a
particular button when the user has already given clear authorization by supported means.

Keep the request pending until answered; elapsed time is not approval. A reply changing scope
requires updating the concrete proposal. Record the action and verified result after execution.
