---
name: blender-dev-storage
description: "Plan storage for Blender checkpoints and exports, handle upload limits and verify archives without losing source assets."
---

# Storage for Blender jobs

Measure current free space at every write destination: active checkpoints, temporary exports,
previews/maps, share uploads and Library storage. Estimate peak copies, not only final output size.
Arrange the job workspace before its first step; verify the first checkpoint reaches that location.
Do not assume that moving the work directory moves caches or upload staging.

When an upload exceeds a configured limit, read the actual response and limit. Use a documented
lossless `source_slim` route where appropriate and compare the resulting geometry, materials and
pixels. Keep the original; do not silently downsample it or change the service limit.

For an authorized archive, copy complete job contents, record byte counts and SHA-256 hashes,
verify the destination and document restoration paths. Copied, verified, restorable and space
reclaimed are separate states. Deletion requires authorization for the specific data and must not
be inferred from a copy request. Private job archives stay outside public source repositories.

Library publication, durable promotion, source linkage and collection membership are separate
checks. Use supported APIs, not direct database edits. See [asset storage](../../docs/guides/asset-storage.md).
