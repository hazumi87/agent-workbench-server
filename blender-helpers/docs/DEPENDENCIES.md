# Dependencies and integration contracts

The core path is Blender + Node runner + Asset Library + local share. The remaining components
are optional. All installation paths and credentials come from the new instance.

| Component | Source | Role |
|---|---|---|
| Blender | Existing installation | Executes Python steps |
| Node.js and Python | System installation | Runner/services and helpers |
| numpy, scipy, Pillow | Blender-visible Python packages | Scientific/image operations |
| pnpm | System package manager | Builds Library source |
| Asset Library/gateway | `plugin/asset-platform-source/` | Asset storage, lineage, viewer |
| Blender runner | `plugin/blender-agent/` | Jobs, checkpoints and verb dispatch |
| Local share | `scripts/mini-share.py` | Health, uploads and shared review files |
| Asset Studio | `plugin/asset-studio/` | Optional workroom review/generation plugin |
| Workroom/PTY broker | [Engine](../../briefing-table/) and [broker](../../pty-broker/) at repository root | Optional Studio host; no duplicate snapshot |
| Mesh sidecar | `plugin/mesh-sidecar/` | Optional local image-to-3D wrappers |
| GPU engines/weights | Each provider's installation | Optional generation; not bundled |
| Scenario API | Scenario CLI in Library source | Optional cloud generation; credentials and paid-operation approval required |
| MediaPipe, gltfpack, three.js | Operation-specific environments | Optional landmarks/compression |

## Asset Studio's workroom contract

`engineUrl` and `engineTokenFile` identify the workroom engine and bearer file. `imageGenUrl`
identifies a separate image-generation service. Do not confuse their tokens or endpoints.

Studio uses room message/metadata/assets endpoints and binds to one room using its documented
binding script. Binding requires the current room/seat context. Panel registration uses the pane
identifier supplied by the workroom. Configure these locally; no live room IDs, bearer files or
binding state are supplied. Without the integration, use Blender previews and the Library viewer.

Read the root [build guide](../../BUILDING.md) for the workroom and broker. A running engine alone
does not establish compatibility with the optional Studio plugin; that integration remains a
target-instance validation task.

## Data and licensing

Library files and its database, share contents, generated models/images, checkpoints and job
reports are separate private data stores. Back them up independently of this code package.
For a fresh install the bundled Library's default rating user is the generic `user`; migrating
an existing database requires an explicit mapping rather than assuming historical IDs match.

No commercial source assets, animation packs, model weights or API accounts are included.
Retain third-party notices and check the selected engine/weight/asset licence before use.
