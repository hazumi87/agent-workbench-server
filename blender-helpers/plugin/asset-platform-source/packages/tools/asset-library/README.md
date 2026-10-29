# asset-tools-asset-library (P1)

Relational index over a curated asset store, audio-first. Files live in the data directory (<data-dir>/assets/audio/{samples,voices}); this service owns a sibling SQLite
index (node:sqlite, built into Node 22; tested with 22.23.1) at <data-dir>/assets.db
and serves assets BY ID (no session cookie → cross-origin trivial).

Lineage is first-class: parent_id (NULL=source root) + root_id (denormalized ultimate
source) + derived_op {tool,params,seed} — reproducible provenance. Transient working tier
(scratch/) is pruned MANUALLY (POST /api/scratch/clear); no auto-reap.

Mounted by the asset-tools gateway under /asset-tools/asset-library/.
API: GET /api/assets (filter), /assets/:id, /assets/:id/lineage, /assets/:id/file,
POST /assets (register on-disk), /assets/upload (multipart), PATCH /assets/:id
(rename|promote), DELETE /assets/:id (?force=1), POST /api/scratch/clear, GET /api/scratch/stats.

Blueprint: the design notes. Vikunja project 26.
