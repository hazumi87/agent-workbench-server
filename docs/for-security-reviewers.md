# What to review

This assessment covers the complete server distribution in this repository. It is not a final release or a blanket finding-closure claim. For reporting, use [SECURITY](../SECURITY.md); for reproducible commands, use [BUILDING](../BUILDING.md).

## Establish the supplied identity

Read the provenance and source/output manifests. Verify the supplied inventory, file hashes and executable modes against the snapshot you intend to assess. Keep the engine content identity, browser input identity, built-app manifest and assembly revision distinct. A changed export or app needs its own result record; an earlier count is not evidence for changed contents.

## Follow the components and accounts

The engine is in briefing-table; pty-broker is its included sibling dependency. Deployment examples are in deploy/reference. The Handbook is inside briefing-table/docs/handbook. Room tasks and assets are engine code, not separate services. There is no desktop checkout, separate workbench-broker, fabric, realm, voice or Codex connector dependency in this server runtime.

The supported reference is one person per instance, with distinct engine and agent OS accounts. Agents retain their account's files, credentials and network access. Review the [operator reference](../deploy/reference/README.md) for account modes, loopback services, SSO on every network path, engine identity, pane credentials, node/target matching and backup responsibilities. Source contracts and deployment requirements are not automatically measured results.

## Include every served byte

Review web-ui and web-app, engine-served legacy pages, bundled tools and added-tool interfaces. Dormant desktop branches inside shared renderer files remain shipped browser code and stay in scope. A hidden control or feature flag is not a security boundary. The sandbox does not completely contain disclosure of data a person granted to an untrusted tool.

Connect every output to its source, dependency or recorded transformation. Include static copies and build-only validators in the input closure; a bundler metafile alone is incomplete. Rebuild with the desktop repository unavailable and compare the complete file list, bytes and MANIFEST, not just JavaScript.

## Examine authority and admission

Follow engine sign-in separately from proxy SSO; person and pane credentials separately from master engine credentials; Host/Origin/refusal paths; broker admission; filesystem permissions; MIME/download handling; app and module CSP classes; tool consent, integrity and binding revocation; and person-initiated terminal input.

The picker root is a navigation limit, not execution containment. Native vendor permissions, auto-approve, explicit folder trust, room approval replies and tool consent are independent choices. Browser storage must not persist credentials or message/note/file bodies. Multi-person per-owner process isolation and send-as authority are not supplied by this one-person reference.

## Reproduce the local proofs

[Run the shipped local proofs](../BUILDING.md#run-the-shipped-local-proofs) documents component working directories and dependencies. The ordinary success run, typed-delivery negative control and actual viewer/attachment browser proof are separate commands with different success conditions. The negative control intentionally exits 1 only for its named failed assertions; do not confuse that with valid green evidence or hide it in a success batch.

These helpers use synthetic identities and scratch state, without model credentials or external services. Read the logs and control assertions as well as the exit code. Missing inputs, timeout or setup error do not reproduce a security finding. Counts must reflect the exported source and actual shipped HTML inventory.

## Current evidence and limitations

Clean engine/broker installation, engine typecheck, locked browser download and source/fixture consistency have setup evidence. Runtime evidence must be read with its input and rerun scope:

The current exported engine's affected setup and settings suites measured **94 pass / 0 fail**, exit 0 (13 setup checks and 81 settings checks). The earlier engine export measured **11 combined proof suites:427 pass /0 fail**, exit 0, and a separate typed-delivery negative control: **15 pass /3 expected failures**, exit 1. Those earlier results are carried to the current engine by an approved diff: only derived hosted/bareShell fields and their tests changed; the nineteen proof files are byte/mode-identical. They were **not freshly rerun on the current engine**. The expected negative-control failures are message-body leakage, fixed-ring admission and independent origin-trace admission; setup and correlation controls passed.

The earlier exported ordinary-suite run selected 338 suites: 332 passed initially, three failed and three were skipped. First-run check totals were 14742 pass/two fail, with one failed suite lacking a summary. A later **captured** rerun of the three failed suites measured 129 pass/zero fail, exit 0. The first run was not clean; skipped suites remain skipped, and an earlier uncaptured rerun is not the receipt. These ordinary results remain attributed to that earlier engine export, separately from the proof counts and current affected suites.

The fresh exported viewer/attachment browser proof (L2) measured **9 pass /0 fail**, exit 0, on the accepted current engine and scrubbed final browser export. It ran 2026-10-27T12:56:55Z–12:57:01Z with Chromium 148.0.7778.96, Playwright 1.60.0 and Node 22.23.1. Log SHA-256: `5cae302d7eae223d7c4aa6959ac35c453f23dd0bb2e0ae53def643ec26230e0e`. Engine export inventory: `61e94dfc9862fedb8c3ff711442bc16cfa0e6e6b07beaa3329d7b08e7f825b8f`; app export inventory: `e7eaf77b3eddf9ae41969c5292360ca4f121791a1b241259f8dc28df0d328213`; app MANIFEST SHA-256: `02d4059b4cfcaa451e383c915ae68335c37ff980088857ebdc5724b07f7d36be`. Post-run source hashes and modes were unchanged. This is fresh exported L2 evidence, separate from carried engine proofs, native delivery and customer-home compatibility.

The standalone browser rebuild is verified: a fresh output directory built from the exported browser source is byte-identical to the supplied scrubbed app, **211/211 files**, including MANIFEST. The source inventory has **267 entries**; with SOURCES.json and the two scan-policy files, the assembled web-ui directory contains **270 files**. The frozen handoff checksums and inventory were independently verified. Build equality alone does not establish runtime or unit results; their completed measurements are recorded separately below.

The exported browser runtime replay measured strict smoke **PASS** and **18/18 probe suites PASS**, including phone Terminals **90/0**, hosted Terminals **38/0** and the keypad's 32 checks. The frozen source and output inventories were unchanged after execution. These are exported-tree measurements, separate from the private application's own full suite.

**The exported app unit result is NON-CLEAN: 2843 pass / 22 fail**, with 5 skipped and 18 todo. The verified failure-name set is identical to the earlier browser replay: 19 pre-existing connector failures, 2 bridge-equality artifacts involving an unshipped tool, and 1 assertion pinned to a pre-scrub tone hash. The shipped tone bytes match the exported engine; the unshipped bridge source is outside this distribution's closure. No new failure names were observed, but these explanations do not turn the run into a passing unit suite. Keep the failures visible and the unit result separate from passing runtime probes, L2 and carried engine proofs.

Whole-tree content, secret and history checks are required separately for each release commit; their receipts identify the checked commit. Documentation alone does not grant release or publication clearance.

Results apply to the recorded input identities; compare provenance and manifests before carrying them to a different tree.

Review the current capability fields at the authenticated setup endpoint: they derive from the engine profile, not a caller-controlled persisted setting. Inspect both local and hosted answers and the app's absent-field fallback. The selected browser changes hosted Shell offerings, phone terminal layers and clipboard input. Review trusted-click admission, controlling lease/focus gates, terminal-owned paste, marker/control sanitization and complete oversized rejection. Source inspection does not replace the measured exported browser proof, runtime probes or non-clean unit result. The final whole-tree and history checks require separate release receipts.

The security-review answer, per-finding correspondence and private operational evidence remain in a separately supplied package. Product documentation does not import that answer or claim its findings closed.
