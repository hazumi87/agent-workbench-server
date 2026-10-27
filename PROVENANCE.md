# Source and artifact provenance

This distribution contains the Workbench server and its browser interface. It is a standalone source package: no desktop repository is required to build or run it.

| Path | Role |
| --- | --- |
| `briefing-table/` | Engine source, its tests and legacy served pages |
| `briefing-table/docs/handbook/` | Product procedures read through the room tools |
| `pty-broker/` | The engine's local terminal-broker dependency |
| `deploy/reference/` | Reference two-account Linux deployment |
| `web-ui/` | Browser source and every static/build input |
| `web-ui/build-tools/` | Locked browser build dependencies |
| `web-app/` | The distributed browser bundle |

`FILES.sha256` records the bytes of the distribution, excluding that checksum file itself. `web-ui/SOURCES.json` records each browser source/build input and its SHA-256 digest. `web-app/MANIFEST.json` records each generated browser file and its digest. The preserved app package and lockfile at the root of `web-ui/` are source inputs; install only the dependency sets classified in `ci/dependency-scopes.json`.

This distribution is prepared for public release with internal references removed and project-specific examples and instructions replaced with product wording. The engine uses the included sibling broker as a local dependency. Design assets keep their original versions; scrubbed comments and sample text have refreshed hash manifests. The Handbook retains its versioned product text.

The reload welcome points agents to the room guide, brief, addressed lines and lead, with the Handbook's summaries and safe-handoff procedures. Internal MCP display aliases are removed; unknown server names retain the raw-name fallback. Cross-room refusal wording is product terminology. Test examples are transformed consistently with these changes.

Build and compare the browser output using [BUILDING.md](BUILDING.md). A comparison passes only when the file lists, every file's bytes and `MANIFEST.json` match. A build success alone is not a comparison result. Content identities in these manifests describe this distribution; verification results apply only to the exact content tested.

Runtime tests, privacy/secret scans, dependency checks and independent rebuild results must identify the exact exported tree they measured.
