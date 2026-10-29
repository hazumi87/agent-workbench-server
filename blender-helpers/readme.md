# Blender helpers

Reusable tools, skills and technical background for producing assets on one Linux server with
Blender already installed. This package contains no production job archive, generated models,
reference photographs, generated textures or per-project result reports.

Start with the [package map](MANIFEST.md), [workflow guides](docs/readme.md), or the briefing for
[asset-operator](agents/asset-operator/agent.md) / [asset-developer](agents/asset-developer/claude.md).
The **user** provides the brief, judges results and authorizes costs and other scoped actions.

## Package and private workspaces

`plugin/` contains the Blender runner, optional Studio/mesh integration and Library source.
`scripts/` contains installation/share helpers and reusable utilities. `skills/` contains the
active workflow skills. `docs/` summarizes methods without real project records.

Keep private inputs, checkpoints, images, maps and reports outside version control. The runner's
job directory and local config are ignored; use a dedicated private working copy or storage
location for actual jobs. Publish code changes by an explicit file list, not by archiving a whole
working directory.

Examples demonstrate syntax with synthetic or placeholder inputs. For an actual job, obtain exact
dimensions, positions, profiles and asset IDs from the current brief and measurements. Follow each
verb's documented units, defaults and numeric tolerances; example values do not override its contract.
Record measurement uncertainty and inspect the result against the references before accepting it.

Procedural defaults produce generic geometry. The lathe's default dome is not a reconstruction of
a particular object: supply a measured `profile` when matching one. Kit assembly requires the current
job's part inputs and placement settings, and biped rigging requires a locally supplied template.
Missing measurements must be resolved or reported as uncertain rather than replaced with example values.

## 1. Prerequisites

| Dependency | Needed for |
|---|---|
| Blender 4.5.4 LTS-compatible installation | Blender Python steps; the toolchain was authored against this version |
| Node.js 22.23.1 (tested version) | Runner, Library and optional Studio; the Library requires the built-in `node:sqlite` module |
| Python 3.10 or newer | Local share and standalone helpers |
| pnpm 9.x (tested 9.15.9), git, curl, rsync | Building/installing the Library; the installer rejects pnpm 10 and later |
| numpy, scipy, Pillow visible to Blender's Python | Scientific/image helper operations |
| Optional GPU engines, weights or provider credentials | Image generation and image-to-3D |

Set the absolute package path and Blender binary:

```bash
export PKG=/absolute/path/to/agent-workbench-server/blender-helpers
export BL=/absolute/path/to/blender
```

Check packages using Blender's interpreter:

```bash
"$BL" -b --python-expr 'import numpy,scipy,PIL;print("deps ok")'
```

If imports fail, install the missing packages into the Python environment used by that Blender
installation. A portable Blender often has its own Python under `sys.prefix`; a distribution build
may use system Python. Locate the interpreter before installing, then repeat the import check.
Do not assume `sys.executable` is Python: it may be the Blender binary.

Face-landmark operations need a separate MediaPipe environment. Meshopt export needs the
documented gltfpack/three.js tooling. Read the relevant verb before installing optional packages
and pass Linux interpreter/tool paths explicitly when an operation's default is Windows-specific.
These optional paths need a target-server smoke test.

Biped rigging requires a locally supplied rig template. Follow the
[template format and setup](plugin/blender-agent/docs/RIG-TEMPLATE.md), then set
`BLENDER_AGENT_RIG_TEMPLATE` to its absolute path or pass `rig_template` in the verb settings.
Keep this asset data in your private workspace.

## 2. Install the Library

The source is unpacked at `plugin/asset-platform-source/`. The install script copies it into a
separate build directory and assembles the runtime from the pinned pnpm lockfile, including its
dependency overrides. Choose fresh writable directories; existing server-package directories
are not overwritten:

```bash
cd "$PKG/plugin/asset-platform-source"
corepack enable
export LIB_ROOT="$HOME/asset-management"
export LIB_DATA="$HOME/asset-library-data"
"$PKG/scripts/install-library.sh" "$PKG" "$LIB_ROOT"
mkdir -p "$LIB_DATA/assets"
cd "$LIB_ROOT/_gateway"
ASSET_PLATFORM_ROOT="$LIB_ROOT" ASSET_LIBRARY_APPDATA="$LIB_DATA" \
  ASSET_LIBRARY_ASSETS_ROOT="$LIB_DATA/assets" node server.js
```

The default gateway port is 8260. Check `/asset-management/library/api/assets` and
`/asset-management/library/`. Optional uninstalled tools may report registration failures; verify
the Library itself is available. Back up the data directory. Use supported APIs for filing and
retention; the scratch-clear endpoint deletes transient data and is not a routine cleanup step.

Optional tools such as image generation require their own packages and configuration; see their
source README files and [dependencies](docs/DEPENDENCIES.md). No credentials or weights are bundled.

## 3. Start a local file share

The runner preflight expects a share with `/health`. The supplied stand-in binds to loopback and
supports uploads without overwriting existing names:

```bash
mkdir -p "$HOME/agent-share"
python3 "$PKG/scripts/mini-share.py" "$HOME/agent-share" 8215
```

Check `http://127.0.0.1:8215/health`. A bare `python -m http.server` lacks that health contract.
Share contents are private job data and are not part of this source package.

## 4. Configure the Blender runner

```bash
cd "$PKG/plugin/blender-agent"
cp config.example.json config.local.json
export BLENDER_AGENT_BLENDER="$BL"
npm test
```

Set the following in the local config, using the current example/schema:

| Setting | Value |
|---|---|
| `blender` | Your absolute Blender path, or use `BLENDER_AGENT_BLENDER` |
| `libraryUrl` | `http://127.0.0.1:8260/asset-management/library` |
| `shareUrl` | `http://127.0.0.1:8215` |
| `shareRoot` | Absolute writable directory served by the share |
| `shareDir` | Relative job/review folder under that directory |
| Room/agent fields | Your current workroom binding, if using that integration |
| `tokenHashFile` | Your bearer-hash file if enabling the optional job server |

Keep local config and credentials out of Git. Run `node scripts/preflight.mjs`; inspect Blender,
Library, share and GPU checks. Missing GPU discovery is different from a failed Blender check.

The [verb reference](plugin/blender-agent/docs/OPERATOR-VERBS.md) describes supported operations.
Use explicit typed settings and preserve accepted checkpoints. Do not copy a real project's
settings into a public example.

## 5. Target-server smoke test

Use a small synthetic model supplied by you, and keep the resulting job private:

1. Run the runner tests and preflight above.
2. Upload the synthetic GLB to the Library and copy its returned ID.
3. Run the documented `fetch`, `import_mesh` (with `src`) and `journal` verbs in a new job.
   Settings are base64-encoded JSON via `--b64`.
4. Inspect the numbered checkpoint and JSON report; open the exported result if the test includes
   export. Process success alone does not establish visual correctness.
5. For a failure, send the developer the exact verb/settings, input pin, error and expected result.

```bash
S=$(printf '%s' '{"ids":["<your-library-id>"]}' | base64 -w0)
node scripts/verb.mjs smoke fetch --b64 "$S"
S=$(printf '%s' '{"src":"downloads/library/<your-library-id>.glb"}' | base64 -w0)
node scripts/verb.mjs smoke import_mesh --b64 "$S"
S=$(printf '%s' '{}' | base64 -w0)
node scripts/verb.mjs smoke journal --b64 "$S"
```

## 6. Optional Asset Studio and generation

Asset Studio is a workroom plugin, not a standalone review service. Install its dependencies,
copy `config.example.json` to `config.local.json`, and configure the Library/share plus the
workroom's `engineUrl` and bearer-token file. It serves a bound room; use the documented binding
and panel registration steps. Use the repository root workroom engine and PTY broker according
to the root build guide. Their compatibility with this plugin requires a target-instance check.

`imageGenUrl` identifies the image-generation API; it is separate from the workroom engine URL.
Local mesh engines require their own weights, environments and compute. Cloud generation needs
provider credentials and a fresh quote/authorization for paid runs. Neither is supplied here.
The Library viewer and Blender verbs can be used without a workroom UI.

## 7. Agent setup and skills

Keep the package in place so relative links resolve. Give a new agent the absolute path to
`agents/asset-operator/agent.md` or `agents/asset-developer/claude.md`, and tell it the package root.
Register or symlink `skills/*` into its supported skill directory rather than copying disconnected
files. The room-task and room-approval skills describe optional workroom integrations.

Use [asset-generation](skills/asset-generation/SKILL.md) to choose a workflow, or
[blender-asset-operator](skills/blender-asset-operator/SKILL.md) for Blender work. Developers start
with [blender-dev](skills/blender-dev/SKILL.md). All current inputs, limits and results belong in a
private brief/job record; these skills do not supply old approvals or model data.

## Validation scope

The runner's 16 tests and Studio's 94 tests passed against test services. The Library installer
was exercised on Linux, with its API and page returning HTTP 200. These checks do not execute
the Blender steps. A full Blender job on a fresh Linux host, live workroom integration and GPU
engines require the target-server smoke tests above.
The image-ops suite passed 37 tests with two model-dependent tests skipped: background removal
and face matching. The updated rembg/Pillow environment resolved and imported successfully,
but those two operations still need end-to-end tests with the models installed on the target host.
The package supplies source and methods, not model weights, paid assets, animation libraries,
provider accounts or proof of deployment.
