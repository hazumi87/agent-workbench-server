# Build and verify the server distribution

This assessment snapshot contains the engine and broker as sibling components, complete browser inputs and a distributed static app. Clean engine/broker installation, engine typecheck and locked browser download have setup evidence. Measured engine evidence and its carry-over limits are recorded below. Fresh exported L2 and the standalone browser rebuild have measured results below; runtime probes and units have completed as recorded below; final whole-tree and history checks require separate release receipts. The commands below describe how to reproduce and check this tree; they do not assert those outstanding runs passed.

## Prerequisites and dependency scopes

Use Linux, Node 22, npm, bash and the committed lockfiles. The recorded setup used Node 22.23.1 on Linux x64. Native dependencies need Python 3, make and a C/C++ toolchain; terminal proofs also need cc, /proc and /dev/pts. Browser execution needs the appropriate Linux browser libraries supplied through your approved OS setup. Dependency and browser installation can need network access; the local proofs need no external service or model credentials.

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

Engine and broker installs have clean setup evidence. The measured standalone browser rebuild and exported proof results are recorded separately below. Server components execute TypeScript through their installed tooling; Electron is not a server runtime dependency.

The declared typechecks are:

```sh
npm --prefix pty-broker run typecheck
npm --prefix briefing-table run typecheck
```

The available measured typecheck is for the engine. Do not infer a broker or browser proof result from it.

## Build and compare the browser app

Verify the source/output inventories supplied with the snapshot before comparing. SOURCES.json under web-ui inventories static and build inputs as well as bundled source. An esbuild metafile alone omits static-copy and build-only inputs. The browser builder and dependency versions come from web-ui/build-tools and its lockfile.

Two scan-policy files are distributed alongside these inputs: `web-ui/osv-scanner.toml` and `web-ui/build-tools/osv-scanner.toml`. They are covered by `FILES.sha256` and are excluded from `SOURCES.json` because they are not browser build inputs. The complete `web-ui/` file set is the `SOURCES.json` entries, `SOURCES.json` itself, and these two policy files.

The build-tools policy excepts only the named esbuild advisory. esbuild runs during browser compilation; the four xterm assets are copied into the served app and remain runtime dependencies. No xterm advisory is ignored by this policy.

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

The independent standalone browser rebuild measured identical output for all 211 files, as recorded below. A successful build or manifest comparison alone is not native-agent or security acceptance.

## Install the locked proof browser

From the repository root, enter the engine component. All remaining commands run there:

```sh
cd briefing-table
node node_modules/playwright/cli.js install chromium
```

This uses the installed locked CLI instead of fetching a newer package. The clean setup verified Playwright 1.60.0 with a fresh browser cache: Chromium and Chrome Headless Shell 148.0.7778.96,revision 1223,with dependency validation successful. The command downloads the browser; it does not install OS libraries or require sudo. If using PLAYWRIGHT_BROWSERS_PATH, use the same cache setting for installation and execution.

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

Success requires exit 0 without assertion or setup failures. The command selects the hosted profile and clears the typed-delivery diagnostic. Report actual exported-tree suite/check counts: the HTML-policy proof inventories the pages actually shipped, so an earlier tree's count is not this tree's result.

### Typed-delivery negative control

Run separately:

```sh
env -u WB_TEST_LOCAL_MODE WB_PROOF_H3_PROFILE=hosted \
  WB_PROOF_T1_DELIVERY=typed \
  node scripts/run-tests.mjs --offset 1200 proof-w1-terminal-trace
```

This opt-in diagnostic deliberately expects exit 1. Only the message-body leak, fixed-ring whitelist and independent origin-trace whitelist assertions should fail. Setup, owned-process detection, persisted author/body, exact chat correlation and broker/trace byte equality controls must pass. A timeout, absent dependency or unrelated failure is not valid negative-control evidence. Do not include this command in an exit 0 success batch; the ordinary command above clears its override.

### Viewer and attachment browser proof

Set EXPECTED_APP_PIN and EXPECTED_ENGINE_PIN to the intended identities from the checksum-verified snapshot provenance before running, and verify the installed Playwright Chromium 148 cache. The measured command uses that installed browser, clearing any ambient CHROMIUM_EXECUTABLE override. Do not discover arbitrary current values just to make the runner accept them. A source tree without a Git revision can use its independently verified SHA-256 tree digest as its engine label. The runner checks the built-app identity and every manifest entry.

From the engine component:

```sh
: "${EXPECTED_APP_PIN:?Set the intended app identity}"
: "${EXPECTED_ENGINE_PIN:?Set the intended engine identity}"
env -u CHROMIUM_EXECUTABLE WB_TEST_PORT_OFFSET=2000 \
  WB_LOCAL_ENGINE_ROOT="$PWD" WB_PROOF_ENGINE_PIN="$EXPECTED_ENGINE_PIN" \
  WB_PROOF_BUILT_APP="$PWD/../web-app" WB_PROOF_APP_PIN="$EXPECTED_APP_PIN" \
  WB_PLAYWRIGHT_MODULE="$PWD/node_modules/playwright" \
  node test/l2/run.mjs
```

Success requires exit 0 with no assertion or setup failures. The proof uses a fresh strict-hosted engine, synthetic sign-in, active-content controls, the picture viewer and actual attachment routes, then closes its browser/engine and removes scratch data. It starts no real vendor CLI. Keep browser proof, native delivery and customer-home compatibility distinct.

## Record results and limits

The current exported engine's affected setup and settings suites measured **94 pass / 0 fail**, exit 0 (13 setup checks and 81 settings checks). The earlier engine export measured **11 combined proof suites:427 pass /0 fail**, exit 0, and a separate typed-delivery negative control: **15 pass /3 expected failures**, exit 1. Those earlier results are carried to the current engine by an approved diff: only derived hosted/bareShell fields and their tests changed; the nineteen proof files are byte/mode-identical. They were **not freshly rerun on the current engine**. The expected negative-control failures are message-body leakage, fixed-ring admission and independent origin-trace admission; setup and correlation controls passed.

The earlier exported ordinary-suite run selected 338 suites: 332 passed initially, three failed and three were skipped. First-run check totals were 14742 pass/two fail, with one failed suite lacking a summary. A later **captured** rerun of the three failed suites measured 129 pass/zero fail, exit 0. The first run was not clean; skipped suites remain skipped, and an earlier uncaptured rerun is not the receipt. These ordinary results remain attributed to that earlier engine export, separately from the proof counts and current affected suites.

The fresh exported viewer/attachment browser proof (L2) measured **9 pass /0 fail**, exit 0, on the accepted current engine and scrubbed final browser export. It ran 2026-10-27T12:56:55Z–12:57:01Z with Chromium 148.0.7778.96, Playwright 1.60.0 and Node 22.23.1. Log SHA-256: `5cae302d7eae223d7c4aa6959ac35c453f23dd0bb2e0ae53def643ec26230e0e`. Engine export inventory: `61e94dfc9862fedb8c3ff711442bc16cfa0e6e6b07beaa3329d7b08e7f825b8f`; app export inventory: `e7eaf77b3eddf9ae41969c5292360ca4f121791a1b241259f8dc28df0d328213`; app MANIFEST SHA-256: `02d4059b4cfcaa451e383c915ae68335c37ff980088857ebdc5724b07f7d36be`. Post-run source hashes and modes were unchanged. This is fresh exported L2 evidence, separate from carried engine proofs, native delivery and customer-home compatibility.

The standalone browser rebuild is verified: a fresh output directory built from the exported browser source is byte-identical to the supplied scrubbed app, **211/211 files**, including MANIFEST. The source inventory has **267 entries**; with SOURCES.json and the two scan-policy files, the assembled web-ui directory contains **270 files**. The frozen handoff checksums and inventory were independently verified. Build equality alone does not establish runtime or unit results; their completed measurements are recorded separately below.

The exported browser runtime replay measured strict smoke **PASS** and **18/18 probe suites PASS**, including phone Terminals **90/0**, hosted Terminals **38/0** and the keypad's 32 checks. The frozen source and output inventories were unchanged after execution. These are exported-tree measurements, separate from the private application's own full suite.

**The exported app unit result is NON-CLEAN: 2843 pass / 22 fail**, with 5 skipped and 18 todo. The verified failure-name set is identical to the earlier browser replay: 19 pre-existing connector failures, 2 bridge-equality artifacts involving an unshipped tool, and 1 assertion pinned to a pre-scrub tone hash. The shipped tone bytes match the exported engine; the unshipped bridge source is outside this distribution's closure. No new failure names were observed, but these explanations do not turn the run into a passing unit suite. Keep the failures visible and the unit result separate from passing runtime probes, L2 and carried engine proofs.

Whole-tree content, secret and history checks are required separately for each release commit; their receipts identify the checked commit. Documentation alone does not grant release or publication clearance.

Results apply to the recorded input identities; compare provenance and manifests before carrying them to a different tree.

Record the exact source digest, app identity, command, browser, counts, exit code and sanitized evidence. The measured proof browser was Chromium 148.0.7778.96. An expected negative-control failure must match its named assertions; a setup failure cannot stand in for it.

Runtime tests, independent browser-source reproduction and full privacy/secret/dependency/licence gates remain separate checks. A passing subset or an earlier private run is not final acceptance of this snapshot. This assembly contains the selected final browser update. Its runtime probes and non-clean unit suite have receipts as recorded above; complete assembly checks require separate release receipts; do not transfer results across changed inputs without recording the scope.

## Provenance

FILES.sha256, web-ui/SOURCES.json, web-app/MANIFEST.json, dependency classifications and notices must describe the same distributed contents. Public provenance records content identities, component roles and transformations. Shared renderer copies must derive from the same scrubbed source and be compared for equality. The private security-review correspondence and operational evidence stay outside this repository.
