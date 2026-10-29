---
name: agent-share
description: Share and inspect local asset files on the single Linux server. Use before handing off images, models, reports or archives.
---

# Local asset sharing

Both roles, **asset-operator** and **asset-developer**, use the same Linux filesystem. Set a writable job/output/share location using the [package installation guide](../../readme.md). No server or execution bridge is required.

1. Preserve source inputs. Put review outputs under a job-specific directory with stable names; avoid overwriting an accepted result.
2. Open generated images with the agent runtime's local image viewer before reporting visual quality. Check reports and the actual exported model as well as the authoring source.
3. Hand the other role an absolute local path or a relative path from the package/job root, plus bytes and SHA-256 when exact identity matters.
4. To provide a browser download, use the serving method configured by the asset-developer. A basic static HTTP server supports downloads, not the original multipart upload API. Do not call `/api/upload` unless that API was installed and documented.
5. Keep credentials out of shared folders. Archive without deleting originals; verify copied files against the source hashes.

Use the local share stand-in from the package installation guide or the current configured file service. Keep its credentials and uploaded project contents outside this source tree.
