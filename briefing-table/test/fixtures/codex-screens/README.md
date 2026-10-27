# Codex startup screens (observed fixtures)

Captured by Owner's Codex seat from **Codex 0.162.1** on 2026-10-11, using disposable profiles, no real
credentials and no submitted model prompt. Relayed to the cloud agent for job 3 (`the design notes`).

- `trust.txt`: the folder-trust dialog. Shown for a NONEMPTY git project; an empty scratch folder skipped it.
  `<absolute project path>` stands for the real path.
- `login.txt`: the fresh-profile login screen.

They cover this version's two startup screens only, not every Codex dialog and not an expired-login state.

Detection rules the capturer asked for: match these as CURRENT visible dialogs, tolerant of line wrapping,
whitespace and selection-marker (`›` / `>`) changes; test split output chunks, a quiet dialog lasting past the
settle time, and the block clearing once the dialog disappears; never match a lone "Sign in" substring; never let an
old scrollback match keep blocking a ready composer. While blocked: no handover line, show trust/login guidance.
The real first-launch check on hosted Basic stays open.
