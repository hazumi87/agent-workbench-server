# asset-studio

A small web app and HTTP API for **reviewing generated images and 3D models** and handing the
verdicts back to an agent. It is one "room app": it works inside one bound workroom, posts one
line per action there, and files its outputs in the Asset Library with lineage.

Three parts:
- **Image review** — numbered reviews with versions, ratings per image, marks (points dragged onto
  an image), notes, references, "send review to the requester".
- **Model review** — a GLB viewer (three.js, vendored) with camera presets, animation clips, and
  the live capture frames that `blender-agent` writes after each saving verb (see its `docs/WATCH.md`).
- **Renders** — `review_look` makes headless-browser pictures of a review for an agent that cannot
  open a browser.

Zero npm dependencies except `express`. Node >= 20.

## Requirements and limits

- **A bound workroom.** The server serves only the ONE room bound with `scripts/bind.sh <room-id>`
  (the binding file lives in `~/.local/state/asset-studio/binding.json`, mode 0600; any other room gets
  HTTP 409). Binding, room lines and panel registration use the workroom app's engine API
  (`engineUrl` + bearer token in `engineTokenFile`). Without that app only `GET /health` and the
  code are usable; the review and room-scoped APIs were not exercised stand-alone.
- The engine endpoints used: `POST /api/rooms/<room>/line`, `GET /api/rooms/<room>`,
  `GET /api/rooms/<room>/assets` (+ `/folder`, `/assets/raw/<name>`).
- Picture generation is NOT the engine: it is `imageGenUrl` (the Library's image-gen tool).

## Install

```bash
npm install
cp config.example.json config.local.json    # edit; config.local.json is not committed
npm test                                     # 94 tests, no external services needed
scripts/start.sh                             # idempotent start; scripts/status.sh, scripts/stop.sh
```

`config.local.json` keys: `libraryUrl` (Library API base), `libraryWebUrl` (what a browser opens),
`libraryStaging` (writable scratch dir on the Library's disk), `imageGenUrl`, `coreUrl` (Model Studio
core), `shareUrl` / `watchBase` (file drop and the live-capture base URL), `engineUrl`,
`engineTokenFile`, `defaultBudget`, `defaultModelBudget`, `playwright` (path to a Playwright install for
`review_look`), `port` (0 = ephemeral).

## Layout

- `app/` server (`server.mjs`), review/model/image logic (`reviews.mjs`, `models.mjs`, `images.mjs`),
  renders (`look.mjs`), and the static UI in `app/static/`.
- `tool.json` declares the tool's verbs (reads, mutations, control) for the workroom app.
- `scripts/` — `start.sh`/`stop.sh`/`status.sh`, `bind.sh`, `post.sh` (post a picture or report),
  `look.sh` and `review-look.mjs` (render a review), `rooms.sh`, `register-panel.sh`, `preflight.sh`.
- `test/` — API, model and watch tests with stub engine/Library servers.
