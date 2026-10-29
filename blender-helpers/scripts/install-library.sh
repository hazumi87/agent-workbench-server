#!/usr/bin/env bash
# Assemble the Asset Library runtime from plugin/asset-platform-source/ (copied to a build dir; the source folder is not modified).
# Layout built: <ROOT>/_gateway, <ROOT>/asset-library, <ROOT>/asset-kit, <ROOT>/asset-library-shell, <ROOT>/image-gen, <ROOT>/image-ops, <ROOT>/model-studio.
# Server packages are installed with `pnpm deploy --prod`, so their dependencies are exactly the versions pinned in pnpm-lock.yaml
# (including its overrides), not a fresh resolution.
# Usage: install-library.sh <package-dir> <runtime-root>      e.g. install-library.sh . ~/asset-management
set -euo pipefail
PKG="$(cd "${1:?package dir}" && pwd)"; ROOT="${2:?runtime root}"
SRC="$ROOT/.src"
mkdir -p "$SRC" "$ROOT"
rsync -a --exclude node_modules --exclude dist "$PKG/plugin/asset-platform-source/" "$SRC/"
# Supported: pnpm 9.x (tested with 9.15.9, the version pinned by "packageManager" in the Library package.json; `corepack enable` selects it).
# The version is read INSIDE the copied Library source, where that pin applies, not in the caller's directory.
# pnpm 10+ changed `pnpm deploy` (it needs injectWorkspacePackages or --legacy) and was not tested here, so it is refused.
PNPM_VERSION="$(cd "$SRC" && pnpm --version)"
case "$PNPM_VERSION" in 9.*) ;; *) echo "unsupported pnpm $PNPM_VERSION (read in $SRC): use pnpm 9.x (run 'corepack enable' so the pinned 9.15.9 is used)" >&2; exit 1 ;; esac
P="$SRC/packages"

( cd "$SRC" && pnpm install --frozen-lockfile )
( cd "$SRC" && pnpm --filter @asset/kit build && pnpm --filter @asset/app build )

# server packages: production dependencies exactly as locked
for pair in "@asset-tools/gateway:_gateway" "@asset-tools/asset-library:asset-library" "@asset-tools/image-gen:image-gen" "image-ops:image-ops" "model-studio:model-studio"; do
  name="${pair%%:*}"; dir="${pair##*:}"
  if [ -n "$(ls -A "$ROOT/$dir" 2>/dev/null)" ]; then echo "refusing to overwrite $ROOT/$dir (not empty): use a fresh runtime root or move it away" >&2; exit 1; fi
  ( cd "$SRC" && pnpm --filter "$name" deploy --prod "$ROOT/$dir" )
done
# the UI: kit bundle + the Library shell SPA (static files and a tiny server each)
mkdir -p "$ROOT/asset-kit" && cp -r "$P/kit/dist" "$ROOT/asset-kit/dist" && cp "$P/kit/kit-server.js" "$ROOT/asset-kit/server.js"
mkdir -p "$ROOT/asset-library-shell" && cp -r "$P/app/dist" "$ROOT/asset-library-shell/dist" && cp "$P/app/shell-server.js" "$ROOT/asset-library-shell/server.js"
echo "done. start: ASSET_PLATFORM_ROOT=$ROOT ASSET_LIBRARY_APPDATA=<dir> ASSET_LIBRARY_ASSETS_ROOT=<dir>/assets node $ROOT/_gateway/server.js"
