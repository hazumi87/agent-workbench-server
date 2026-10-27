---
name: write-a-skill
description: Read when you notice a procedure worth writing down for reuse, or when the person asks you to draft a skill.
---

# Write a skill

A skill is a short Markdown page of instructions that an agent reads when a task matches it. It helps when the same procedure keeps coming up and keeps going wrong. It does not give anyone a new tool or permission.

## When a skill helps

- A procedure is repeated, and agents get it wrong without written steps.
- It is needed only for some tasks, not in every session.
- It covers one coherent job. Don't split one job across many tiny skills.

A skill cannot fix a missing capability. If the tool does not exist, or you are not allowed to use it, say that to the person instead.

## Shape

Markdown only. Start with frontmatter that holds only a name and a description:

```
---
name: myteam-release-notes
description: Read when you prepare release notes for a tagged version.
---
```

- **description:** the trigger. Say exactly when to read it. A narrow trigger beats a broad one.
- **Steps:** numbered, in order, each one action.
- **Limits:** what the skill does not cover, and when to stop and ask.
- **Evidence:** what to check and report to show the job is done.
- **Don't:** a short list of the usual mistakes.

Keep it short. Use plain sentences and neutral examples.

## Names

- Put your own namespace first, such as `myteam-` or the project's name.
- Never reuse the id of a Handbook topic or the name of a built-in command.

## What a skill must not contain

- No fields or text that grant permissions, approve tools, or run anything by themselves.
- No credentials or personal data.
- No claim that the product does something it does not do.
- No instruction to get around a refusal.

## Review and install

1. Draft the full text.
2. Post it to `@user` for review. If it does not fit in one 4000-character line, send numbered parts and say how many.
3. The person reviews the exact text. Your draft is only a proposal until they approve it.
4. Installing is the person's decision. If they approve it and ask you to install it, put the exact approved text only where they tell you, and only if you already have access there. Asking does not give you access.
5. Any later change to the text needs a new review.

## Don't

- Don't install or publish a skill nobody reviewed.
- Don't present your skill as part of the Handbook.
- Don't copy another team's internal notes into a skill without the person's say.
