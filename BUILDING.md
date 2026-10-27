# Build and verify the server distribution

This assessment snapshot contains the engine and broker as sibling components, complete browser inputs and a distributed static app. Clean engine/broker installation, engine typecheck and locked browser download have setup evidence. Exported runtime proofs and the final browser revision still need their own measured results. The commands below describe how to reproduce and check this tree; they do not assert those outstanding runs passed.

## Prerequisites and dependency scopes

Use Linux, Node22, npm, bash and the committed lockfiles. The recorded setup used Node22.23.1 on Linux x64. Native dependencies need Python3, make and a C/C++ toolchain; terminal proofs also need cc, /proc and /dev/pts. Browser execution needs the appropriate Linux browser libraries supplied through your approved OS setup. Dependency and browser installation can need network access; the local proofs need no external service or model credentials.

| Directory | Purpose | Install here? |
| --- | --- | --- |
| pty-broker | Terminal broker and development checks | Yes |
| briefing-table | Engine and development checks | Yes |
| web-ui/build-tools | Locked esbuild and xterm build dependencies | Yes |
| web-ui | Preserved source package and lockfile | **No: source inputs only** |

Never run npm ci at the web-ui root. That preserved package includes desktop dependencies and is not the server installation contract. The machine-readable classification is ci/dependency-scopes.json. Keep briefing-table and pty-broker as siblings so file:../pty-broker resolves within this repository. No private checkout, ambient source symlink or undeclared sibling may supply a missing input.

From the repository root:

```sh
npm --prefix pty-broker ci
npm --prefix briefing-table ci
npm --prefix web-ui/build-tools ci
```

Engine and broker installs have clean setup evidence. The final browser-source install/rebuild and exported proof results remain separate. Server components execute TypeScript through their installed tooling; Electron is not a server runtime dependency.

The declared typechecks are:

```sh
npm --prefix pty-broker run typecheck
npm --prefix briefing-table run typecheck
```

The available measured typecheck is for the engine. Do not infer a broker or browser proof result from it.

## Build and compare the browser app

Verify the source/output inventories supplied with the snapshot before comparing. SOURCES.json under web-ui inventories static and build inputs as well as bundled source. An esbuild metafile alone omits static-copy and build-only inputs. The browser builder and dependency versions come from web-ui/build-tools and its lockfile.

From the repository root, use a fresh comparison output. This reads the intended identity from the supplied, checksum-verified app manifest; it does not substitute the assembly repository's unrelated HEAD:

```sh
set -eu
wb_app_identity="$(node -p "require('./web-app/MANIFEST.json').sourceCommit")"
test ! -e web-app-rebuilt
(
  cd web-ui
  WB_ESBUILD_FROM=build-tools node scripts/web/build-web.mjs \
    --out ../web-app-rebuilt \
    --nm build-tools/node_modules \
    --source-commit "$wb_app_identity"
)
diff -qr web-app web-app-rebuilt
```

If the comparison directory already exists, choose a new empty output path. Keep the supplied web-app intact. A passing comparison requires identical complete relative file lists and bytes, including MANIFEST.json, static resources and xterm runtime files. Do not normalize code differences away. Any approved metadata transformation must be recorded explicitly in provenance.

The independent final browser rebuild remains outstanding for this review snapshot. A successful build or manifest comparison alone is not native-agent or security acceptance.

## Install the locked proof browser

From the repository root, enter the engine component. All remaining commands run there:

```sh
cd briefing-table
node node_modules/playwright/cli.js install chromium
```

This uses the installed locked CLI instead of fetching a newer package. The clean setup verified Playwright1.60.0 with a fresh browser cache: Chromium and Chrome Headless Shell148.0.7778.96,revision1223,with dependency validation successful. The command downloads the browser; it does not install OS libraries or require sudo. If using PLAYWRIGHT_BROWSERS_PATH, use the same cache setting for installation and execution.

This is browser-install evidence, not a passed runtime proof. Record the actual executable/version used by each run.

## Run the shipped local proofs

Proof sources are in test/, including test/l2/, relative to the engine component. Helpers create their own scratch engines, broker, identities and files. No vendor login, account credentials, external engine/broker, private checkout or live service is required. Use disposable scratch data and unoccupied ports; do not redirect them to an existing operator instance.

Required inputs include the shipped sanitizer and HTML, scripts/hosted-workbench.ts, scripts/identity.ts, test/identity-engine.test.mjs (synthetic sign-in fixture), test/fixtures/gemini-gate/ and the installed node_modules/pty-broker/src/main.ts. Preserve their declared dependencies and record any fixture-only adaptation. Source inventory and fixture consistency checks do not run the proof assertions.

### Ordinary success run

```sh
env -u WB_TEST_LOCAL_MODE -u WB_PROOF_T1_DELIVERY \
  WB_PROOF_H3_PROFILE=hosted \
  node scripts/run-tests.mjs --offset 1200 \
  proof-h1 proof-h2 proof-h3 proof-h5 proof-l4 proof-l5 proof-m14 proof-m6 \
  proof-w1-terminal-trace doorbell-guards doorbell
```

Success requires exit0 without assertion or setup failures. The command selects the hosted profile and clears the typed-delivery diagnostic. Report actual exported-tree suite/check counts: the HTML-policy proof inventories the pages actually shipped, so an earlier tree's count is not this tree's result.

### Typed-delivery negative control

Run separately:

```sh
env -u WB_TEST_LOCAL_MODE WB_PROOF_H3_PROFILE=hosted \
  WB_PROOF_T1_DELIVERY=typed \
  node scripts/run-tests.mjs --offset 1200 proof-w1-terminal-trace
```

This opt-in diagnostic deliberately expects exit1. Only the message-body leak, fixed-ring whitelist and independent origin-trace whitelist assertions should fail. Setup, owned-process detection, persisted author/body, exact chat correlation and broker/trace byte equality controls must pass. A timeout, absent dependency or unrelated failure is not valid negative-control evidence. Do not include this command in an exit0 success batch; the ordinary command above clears its override.

### Viewer and attachment browser proof

Set EXPECTED_APP_PIN and EXPECTED_ENGINE_PIN to the intended identities from the checksum-verified snapshot provenance before running, and CHROMIUM_EXECUTABLE to the installed Chromium148 executable. Do not discover arbitrary current values just to make the runner accept them. A source tree without a Git revision can use its independently verified SHA-256 tree digest as its engine label. The runner checks the built-app identity and every manifest entry.

From the engine component:

```sh
: "${EXPECTED_APP_PIN:?Set the intended app identity}"
: "${EXPECTED_ENGINE_PIN:?Set the intended engine identity}"
: "${CHROMIUM_EXECUTABLE:?Set the installed Chromium148 executable}"
env WB_TEST_PORT_OFFSET=2000 \
  WB_LOCAL_ENGINE_ROOT="$PWD" WB_PROOF_ENGINE_PIN="$EXPECTED_ENGINE_PIN" \
  WB_PROOF_BUILT_APP="$PWD/../web-app" WB_PROOF_APP_PIN="$EXPECTED_APP_PIN" \
  WB_PLAYWRIGHT_MODULE="$PWD/node_modules/playwright" \
  CHROMIUM_EXECUTABLE="$CHROMIUM_EXECUTABLE" \
  node test/l2/run.mjs
```

Success requires exit0 with no assertion or setup failures. The proof uses a fresh strict-hosted engine, synthetic sign-in, active-content controls, the picture viewer and actual attachment routes, then closes its browser/engine and removes scratch data. It starts no real vendor CLI. Keep browser proof, native delivery and customer-home compatibility distinct.

## Record results and limits

Combined success, typed negative-control and viewer/attachment executions still await measured exported-tree results. No fixed pass count is claimed here. Record the exact source digest, app identity, command, browser, counts, exit code and sanitized evidence. An expected negative-control failure must match its named assertions; a setup failure cannot stand in for it.

Runtime tests, independent browser-source reproduction and full privacy/secret/dependency/licence gates remain separate checks. A passing subset or an earlier private run is not final acceptance of this snapshot. The final browser update will be a separate reviewed revision; do not transfer results across changed inputs without recording the scope.

## Provenance

FILES.sha256, web-ui/SOURCES.json, web-app/MANIFEST.json, dependency classifications and notices must describe the same distributed contents. Public provenance records content identities, component roles and transformations. Shared renderer copies must derive from the same scrubbed source and be compared for equality. The private security-review correspondence and operational evidence stay outside this repository.
