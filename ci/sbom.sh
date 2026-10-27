#!/usr/bin/env bash
# One labelled lockfile-only CycloneDX document per dependency set. The source
# input snapshot is not a server installation; its SBOM is labelled accordingly.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/sbom"
inventory="$(node "$root/ci/dependency-scopes.mjs")"
mkdir -p "$out"
n=0
while IFS=$'\t' read -r dir scope; do
  name="${dir//\//-}"
  (cd "$root/$dir" && npx --yes @cyclonedx/cyclonedx-npm@6.0.1 --package-lock-only --omit dev --ignore-npm-errors --output-format JSON --output-file "$out/$scope-$name.cdx.json")
  n=$((n + 1))
done <<< "$inventory"
cp "$root/ci/dependency-scopes.json" "$out/dependency-scopes.json"
echo "sbom: $n dependency sets in $out"
