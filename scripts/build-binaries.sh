#!/usr/bin/env bash
# Compile standalone agent-mesh binaries (channel + CLI) for every platform.
# Used for the CI/headless distribution and GitHub Releases. Requires Bun.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="dist/binaries"
mkdir -p "$OUT"

TARGETS=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-windows-x64:windows-x64"
)

for t in "${TARGETS[@]}"; do
  target="${t%%:*}"
  label="${t##*:}"
  ext=""
  [[ "$label" == windows-* ]] && ext=".exe"

  echo "▸ channel  $label"
  bun build packages/mcp/src/index.ts --compile --target="$target" \
    --outfile "$OUT/agent-mesh-channel-$label$ext"

  echo "▸ cli      $label"
  bun build packages/cli/src/index.ts --compile --target="$target" \
    --outfile "$OUT/agent-mesh-$label$ext"
done

echo "✓ binaries in $OUT/"
ls -la "$OUT/"
