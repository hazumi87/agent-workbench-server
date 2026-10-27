# Security scope and reporting

## Report privately

Use the private security contact supplied with your delivery. If no contact was supplied, ask the repository owner for a private reporting channel before sending reproduction details. Do not put credentials, session cookies, private project files or terminal transcripts in a public issue.

Identify the affected snapshot and its content identities from the supplied provenance and manifests. Include the path or route, expected boundary, minimal synthetic reproduction, browser/OS and sanitized error. Distinguish an assertion failure from missing setup, a timeout or an unavailable dependency.

## Supported assessment scope

This repository is an assessment snapshot, not final release acceptance. Review the entire distribution: engine and broker processes, authentication and authorization, legacy served pages, web-ui, web-app, included tools, deployment helpers, dependencies and source/output metadata.

Desktop-only branches inside shared renderer files remain shipped browser code and stay in scope even when their controls are hidden. Electron is not a server runtime dependency; that does not exempt renderer code copied into this distribution. A separate desktop repository is not a build dependency.

## Trust boundaries

The supported deployment is one person per instance, with separate engine and agent OS accounts. The account split protects engine-private files through filesystem permissions. Agents retain their own account's project files, vendor credentials and network access; agents under the same account are not isolated from one another. Multiple engine sign-in accounts do not establish per-owner process isolation or send-as authorization.

The SSO proxy protects every network route, including API-token routes. Engine and broker remain loopback-only; pane-token clients reach the engine there. The engine separately identifies its account by password/passkey or configured linked OIDC sign-in, never proxy identity headers.

The folder picker limits navigation, not all possible launches. OS permissions are the execution boundary. Engine auto-approve, native vendor permission settings, explicit folder trust, replying to an approval line and tool consent are separate decisions. A room approval reply is not an independent gate around every native command.

Cross-account pane credentials use the broker's spawn environment, with no pane-token file. Processes under that agent account can read its environment. Room files are authenticated server files and never public agent-share links. Page-managed browser storage must not contain credentials or message, note or file bodies; local UI metadata is person-scoped and cleared at sign-out/person changes.

Review the app and sandbox response policies separately. App scripts require asset-scoped or nonce authority without unsafe-inline/eval; inline styles remain a residual. Sandboxed tool self-navigation can disclose data the person granted, so the sandbox is not complete network containment. Engine login/error pages have framing protection without a full script policy; do not assume CSP everywhere.

## Validation limits

Clean dependency installation, typechecking, browser download and fixture/source consistency do not prove runtime security properties. Combined success proofs, the separate typed-delivery negative control and the viewer/attachment browser proof still await measured results for this exported tree. The final browser revision and its checks are separate work. No finding is closed merely by this document or a source description.

See [What to review](docs/for-security-reviewers.md), [BUILDING](BUILDING.md) and the [operator reference](deploy/reference/README.md). The review answer, finding matrix, private evidence and residual-risk correspondence remain outside this repository.
