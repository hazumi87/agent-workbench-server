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

[Run the shipped local proofs](../BUILDING.md#run-the-shipped-local-proofs) documents component working directories and dependencies. The ordinary success run, typed-delivery negative control and actual viewer/attachment browser proof are separate commands with different success conditions. The negative control intentionally exits1 only for its named failed assertions; do not confuse that with valid green evidence or hide it in a success batch.

These helpers use synthetic identities and scratch state, without model credentials or external services. Read the logs and control assertions as well as the exit code. Missing inputs, timeout or setup error do not reproduce a security finding. Counts must reflect the exported source and actual shipped HTML inventory.

## Current evidence and limitations

Clean engine/broker dependency installation, engine typecheck, locked browser download and source-inventory/fixture consistency have setup evidence. Combined proofs, typed negative-control execution, viewer/attachment proof and final browser-source verification still await measured results for the exported tree. No fixed assertion count or unmeasured pass is claimed.

The current browser snapshot has an empty standalone Terminals destination below600px and a clipped full-page tool back-arrow focus ring at320px. Room-seat terminal views work; the follow-up browser revision and its checks are separate. Source review of these limitations does not remove the affected code from scope.

The security-review answer, per-finding correspondence and private operational evidence remain in a separately supplied package. Product documentation does not import that answer or claim its findings closed.
