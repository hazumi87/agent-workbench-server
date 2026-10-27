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

The combined success proofs, typed-delivery negative control and actual viewer/attachment browser proof still need measured exported-tree results. The final browser update and its independent source/output verification are also outstanding. Run the commands in BUILDING against this snapshot and record actual source identities, browser, outcomes and limitations; no earlier candidate count is a result for this tree.

## Current browser limitations

Below600px, the standalone Terminals destination in this snapshot has no terminal list or start controls; terminal views opened from room seats work. A phone Terminals page is being added in a subsequent review revision. At320px, the full-page tool back-arrow focus ring can clip at the screen corner; its correction is also outstanding. Do not treat this snapshot as the completed phone workflow.

These limits do not remove any shipped file from review. Native-agent delivery, browser proofs, customer-home compatibility and build reproduction are separate claims requiring their own scoped evidence.

## Licence and notices

Read [LICENSE](LICENSE) and [NOTICE](NOTICE), together with dependency notices included in the distribution. The security-review correspondence and operational evidence package are supplied separately and are not part of this repository.
