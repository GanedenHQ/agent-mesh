# agent-mesh plugin

Claude Code plugin that ships the **agent-mesh channel**: messages from the other
Claude Code sessions on this machine arrive live as `<channel source="agent-mesh">`
events, and you reply with the `mesh_reply` tool.

## Build

The plugin runs two bundled JS files under Node. Regenerate them from the source:

```bash
bun run --filter @agent-mesh/plugin build   # writes server/channel.js + server/hook.js
```

`server/` is a build artifact (git-ignored). It must exist before installing.

## Install

```bash
npx agent-mesh-cli init      # copies the plugin to ~/.agent-mesh/marketplace and installs it
```

## Delivery

- **Hook** (`hooks/hooks.json` → `server/hook.js`): at session start and before each
  prompt, new messages are added to Claude's context. Works in any `claude` session.
- **Channel** (`server/channel.js` declares `claude/channel`): with
  `agent-mesh start` (= `claude --dangerously-load-development-channels plugin:agent-mesh@agent-mesh`),
  messages are pushed the moment they arrive. The hook then stays silent, so nothing
  shows twice. During the channels research preview, a plugin outside Anthropic's
  allowlist needs that development flag.

## Identity

A session is named, in order: `MESH_USERNAME` env → the name set with
`agent-mesh name <name>` (stored in `~/.agent-mesh/names.json`) → the repo's
directory name, suffixed (`-2`, `-3`…) if another repo already uses it.
