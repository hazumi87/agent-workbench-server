# Agent Workbench Server

Agent Workbench brings terminal agents, saved recipes and shared workrooms into a browser. This repository contains the Linux server, terminal broker, complete browser build inputs and the static web app it serves. The supported deployment is one person per instance, with separate engine and agent operating-system accounts.

This is an **assessment snapshot**. It is available for source review and reproducibility checks; it is not a final release or a claim that every security proof has passed. The current validation state and limitations are listed below.

Start with [What to review](docs/for-security-reviewers.md), [Build and verify](BUILDING.md), [Security scope and reporting](SECURITY.md), and the [reference deployment](deploy/reference/README.md). [Provenance](PROVENANCE.md), source inventories and output manifests identify the supplied contents.

## Components

| Path | Role |
| --- | --- |
| briefing-table/ | Engine: identity, rooms, seats, recipes, tasks, files and served pages |
| briefing-table/docs/handbook/ | Versioned, read-only procedures available through room tools |
| pty-broker/ | Terminal broker and the engine's included local dependency |
| deploy/reference/ | Two-account Linux service, environment and proxy reference |
| web-ui/ | Complete browser source and static/build-input closure |
| web-ui/build-tools/ | Locked browser build dependencies |
| web-app/ | Distributed static browser output, including its manifest |

Engine, broker and built app form the runtime. The unit named workbench-broker.service runs pty-broker; it does not require the separate workbench-broker package. No standalone room-task or room-asset service, fabric, realm, voice service or Codex connector package is required. Hosted Codex uses its CLI through the engine's room tools.

The server has no dependency on a desktop checkout or client directory. Electron is not a server runtime dependency. **Desktop-only branches inside the shared web code are still shipped to browsers and remain in security-review scope.** A hidden control or runtime flag does not remove served code from review.

## Build and deploy

Install locked dependencies only in pty-broker, briefing-table and web-ui/build-tools. The preserved package and lockfile at the web-ui root are source inputs only: **never run npm ci in web-ui itself**. Follow [BUILDING](BUILDING.md) for the exact working directories, browser installation, output comparison and local proof commands.

The deployment operator supplies TLS, SSO on every network route, loopback-only engine and broker listeners, account permissions, vendor licences and sign-ins, backups and upgrades. Engine identity is separate from proxy sign-in. Agents execute with their account's access and can contact their vendors; this is not an agent sandbox or multi-person process isolation.

## Validation state

Available evidence covers a clean engine/broker dependency install, engine typecheck, locked Playwright browser download and source-inventory/fixture consistency checks. Those establish their respective setup properties, not the security assertions of an unexecuted proof.

The current exported engine's affected setup and settings suites measured **94 pass / 0 fail**, exit 0 (13 setup checks and 81 settings checks). The earlier engine export measured **11 combined proof suites:427 pass /0 fail**, exit 0, and a separate typed-delivery negative control: **15 pass /3 expected failures**, exit 1. Those earlier results are carried to the current engine by an approved diff: only derived hosted/bareShell fields and their tests changed; the nineteen proof files are byte/mode-identical. They were **not freshly rerun on the current engine**. The expected negative-control failures are message-body leakage, fixed-ring admission and independent origin-trace admission; setup and correlation controls passed.

The earlier exported ordinary-suite run selected 338 suites: 332 passed initially, three failed and three were skipped. First-run check totals were 14742 pass/two fail, with one failed suite lacking a summary. A later **captured** rerun of the three failed suites measured 129 pass/zero fail, exit 0. The first run was not clean; skipped suites remain skipped, and an earlier uncaptured rerun is not the receipt. These ordinary results remain attributed to that earlier engine export, separately from the proof counts and current affected suites.

The fresh exported viewer/attachment browser proof (L2) measured **9 pass /0 fail**, exit 0, on the accepted current engine and scrubbed final browser export. It ran 2026-10-27T12:56:55Z–12:57:01Z with Chromium 148.0.7778.96, Playwright 1.60.0 and Node 22.23.1. Log SHA-256: `5cae302d7eae223d7c4aa6959ac35c453f23dd0bb2e0ae53def643ec26230e0e`. Engine export inventory: `61e94dfc9862fedb8c3ff711442bc16cfa0e6e6b07beaa3329d7b08e7f825b8f`; app export inventory: `e7eaf77b3eddf9ae41969c5292360ca4f121791a1b241259f8dc28df0d328213`; app MANIFEST SHA-256: `02d4059b4cfcaa451e383c915ae68335c37ff980088857ebdc5724b07f7d36be`. Post-run source hashes and modes were unchanged. This is fresh exported L2 evidence, separate from carried engine proofs, native delivery and customer-home compatibility.

The standalone browser rebuild is verified: a fresh output directory built from the exported browser source is byte-identical to the supplied scrubbed app, **211/211 files**, including MANIFEST. The source inventory has **267 entries**; with SOURCES.json and the two scan-policy files, the assembled web-ui directory contains **270 files**. The frozen handoff checksums and inventory were independently verified. Build equality alone does not establish runtime or unit results; their completed measurements are recorded separately below.

The exported browser runtime replay measured strict smoke **PASS** and **18/18 probe suites PASS**, including phone Terminals **90/0**, hosted Terminals **38/0** and the keypad's 32 checks. The frozen source and output inventories were unchanged after execution. These are exported-tree measurements, separate from the private application's own full suite.

**The exported app unit result is NON-CLEAN: 2843 pass / 22 fail**, with 5 skipped and 18 todo. The verified failure-name set is identical to the earlier browser replay: 19 pre-existing connector failures, 2 bridge-equality artifacts involving an unshipped tool, and 1 assertion pinned to a pre-scrub tone hash. The shipped tone bytes match the exported engine; the unshipped bridge source is outside this distribution's closure. No new failure names were observed, but these explanations do not turn the run into a passing unit suite. Keep the failures visible and the unit result separate from passing runtime probes, L2 and carried engine proofs.

Whole-tree content, secret and history checks are required separately for each release commit; their receipts identify the checked commit. Documentation alone does not grant release or publication clearance.

Results apply to the recorded input identities; compare provenance and manifests before carrying them to a different tree.

## Browser scope under final verification

The selected browser revision includes the phone Terminals page, hosted capability-aware launch controls, full-screen phone terminal layers and a paged touch keypad. Hosted engines offer recipes and Custom command rather than a built-in bare Shell. Custom commands name a program and its options; engine refusal sentences remain authoritative, and OS account permissions remain the execution boundary. Dormant served branches remain in review scope.

Fresh exported L2 and the standalone rebuild are measured as recorded above; runtime probes and units have completed as recorded above; final whole-tree and history checks require separate release receipts. This assessment snapshot does not claim a completed final export, native-agent proof, customer-home compatibility or release acceptance from those selected-source features.

## Licence and notices

Read [LICENSE](LICENSE) and [NOTICE](NOTICE), together with dependency notices included in the distribution. The security-review correspondence and operational evidence package are supplied separately and are not part of this repository.
