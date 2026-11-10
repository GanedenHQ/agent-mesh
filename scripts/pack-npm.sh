#!/usr/bin/env bash
# Assemble the single npm package `agent-mesh` in dist/npm:
#   cli.js                          the CLI, bundled for node
#   .claude-plugin/marketplace.json a one-plugin marketplace
#   plugin/                         the Claude Code plugin (channel server bundled for node)
# `npx agent-mesh init` copies the marketplace out of the package and installs it.
# Requires Bun to build; the result only needs Node.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="dist/npm"
VERSION="$(node -p "require('./package.json').version")"

rm -rf "$OUT"
mkdir -p "$OUT/.claude-plugin" "$OUT/plugin/server"

bun build packages/cli/src/index.ts --target=node --outfile "$OUT/cli.js"
bun build packages/mcp/src/index.ts --target=node --outfile "$OUT/plugin/server/channel.js"
bun build packages/mcp/src/hook.ts --target=node --outfile "$OUT/plugin/server/hook.js"
cp -R packages/plugin/.claude-plugin "$OUT/plugin/"
[ -d packages/plugin/hooks ] && cp -R packages/plugin/hooks "$OUT/plugin/"

node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8"));
for (const p of m.plugins) p.source = "./plugin";
fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
' "$OUT/.claude-plugin/marketplace.json"

cat > "$OUT/package.json" <<EOF
{
  "name": "agent-mesh-cli",
  "version": "$VERSION",
  "description": "Let the Claude Code sessions on one machine message each other.",
  "keywords": ["claude-code", "claude", "mcp", "plugin", "multi-agent"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/GanedenHQ/agent-mesh.git" },
  "homepage": "https://github.com/GanedenHQ/agent-mesh#readme",
  "bugs": { "url": "https://github.com/GanedenHQ/agent-mesh/issues" },
  "type": "module",
  "bin": { "agent-mesh": "cli.js" },
  "files": ["cli.js", ".claude-plugin", "plugin", "README.md", "LICENSE"],
  "engines": { "node": ">=18" }
}
EOF
cp README.md "$OUT/"
[ -f LICENSE ] && cp LICENSE "$OUT/"

# The bin needs a node shebang (the source one says bun, or the bundle has none).
{ echo '#!/usr/bin/env node'; grep -v '^#!' "$OUT/cli.js"; } > "$OUT/cli.js.tmp"
mv "$OUT/cli.js.tmp" "$OUT/cli.js"
chmod +x "$OUT/cli.js"

echo "✓ $OUT (agent-mesh@$VERSION)"
