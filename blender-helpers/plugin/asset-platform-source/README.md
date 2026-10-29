# Asset Library (source)

The store and viewer behind the Blender workflow: every image, mesh, GLB and BLEND is a record with
parents/lineage, labels and a preview, served by one Express gateway on port 8260.

Layout (a pnpm monorepo):
- `packages/gateway` — the single server. It mounts each tool's `register(app)` from `<ROOT>/<tool>/server.js`
  (`ASSET_PLATFORM_ROOT`), listed in the `TOOLS` array at the top of `server.js`.
- `packages/tools/asset-library` — the data API (SQLite via `ASSET_LIBRARY_APPDATA`, files under
  `ASSET_LIBRARY_ASSETS_ROOT`): upload (`POST /asset-management/library/api/assets/upload`), list/search,
  file/thumb/reference download, lineage, scratch/promote tiers.
- `packages/tools/image-gen`, `image-ops` — image generation front-end and image operations (crop, trim, resize,
  threshold, to_svg, background removal).
- `packages/tools/model-studio` — the core that orchestrates 3D backends (such as `mesh-sidecar` and `blender-agent`'s
  job server) from a human-edited config.
- `packages/app` (the Library SPA) and `packages/kit` (the React/Web Components kit), built with Vite.
- Also present: `packages/scenario`, `tile-builder`, `timeline` (separate small tools).

Install on Linux with `scripts/install-library.sh` from the parent package; it builds `kit` and `app`, assembles
the runtime layout (`_gateway`, `asset-library`, `asset-kit`, `asset-library-shell`) and prints the start command.
Do not edit the SQLite database by hand. `POST /api/scratch/clear` deletes the transient tier with no
confirmation: do not call it casually.

## Optional voice and transcription services
The voice features are off unless you point them at services you run. Nothing is hard-coded to a port:
- `VITE_VOICE_URL` (set when building the app, e.g. `VITE_VOICE_URL=http://127.0.0.1:8221 pnpm --filter @asset/app build`): base URL of a text-to-speech service the browser calls (`/synthesize_ref`, `/health`). Note that "127.0.0.1" in the browser means the viewer's own machine, so use an address the browser can reach.
- `TRANSCRIBE_URL` (environment of the gateway): base URL of the transcription sidecar (`transcribe_sidecar.py`, with `transcribe-requirements.txt`). Unset, `POST .../api/transcribe` answers 503.
- `V2V_REGISTER_URL` (gateway environment): URL of a voice-registration endpoint. Unset, voice registration reports "not configured".

Use HTTPS for services reached across a network. Plain HTTP is suitable for a service confined to
loopback on the same machine. Browser requests must also meet the service's CORS policy; an HTTPS
Library page cannot use an ordinary remote HTTP endpoint because browsers block mixed content.
