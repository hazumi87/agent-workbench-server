# status/

Run files, git-ignored except this README.

| File | Written by | What |
|---|---|---|
| `widget.json` | `run-step.mjs`, `preflight.mjs` | WidgetStatus `{kind: ok\|warn\|cold, text, ts, expiresAt}` for the CLI Manager |
| `.lock` | `run-step.mjs` | `{pid, what, at}` while a step runs — one step at a time; a lock whose pid is gone is stale and is taken over |
