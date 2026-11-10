# agent-mesh

Let the Claude Code sessions on your machine talk to each other. From any session,
`ask @web whether the login page still uses /v1` — the message reaches the `web`
session, its Claude reads it and answers with `mesh_reply`.

```
~/code/api  (Claude Code, @api)                 ~/code/web  (Claude Code, @web)
  └─ mesh_send to=@web "review this?"             ▲ live <channel>, or at web's next prompt
      └─ ~/.agent-mesh/local/mailboxes/web/new/ ─┘   web's Claude reads it, replies with mesh_reply
```

No server, no account, no key. Messages are files under `~/.agent-mesh/local`.
A desktop notification + sound fires when a message arrives (`MESH_NOTIFY=0` to
silence, `MESH_NOTIFY=sound` for sound only).

## Install

Requires Claude Code and Node.js 18+.

```bash
npx agent-mesh-cli init
```

That installs the Claude Code plugin. Restart your sessions: each one now has the
mesh tools and is named after its repo.

**Two ways to receive.** In a plain `claude` session, new messages are handed to
Claude at the start of your next prompt. To have them land the moment they arrive,
even while the session is idle, start it with:

```bash
npx agent-mesh-cli start        # = claude + the live channel; extra args go to claude
```

(Live delivery uses Claude Code [channels](https://code.claude.com/docs/en/channels),
a research preview: for a plugin outside Anthropic's allowlist, Claude Code asks you to
confirm the development flag at launch.)

From source:

```bash
git clone https://github.com/GanedenHQ/agent-mesh.git && cd agent-mesh
bun install && bun run build:plugin && bun packages/cli/src/index.ts init
```

## Use

Each session is named after its repo (`~/code/api` → `@api`); a second repo with the
same name gets `@api-2`. In any session:

```
> who else is running?            → mesh_list_team
> ask @web whether the login page still uses the old endpoint
> check my inbox                  → mesh_read_inbox
```

From a terminal (`npx agent-mesh-cli <command>`, or `npm i -g agent-mesh-cli` for a
plain `agent-mesh`):

| Command                  | What it does                                                                      |
| ------------------------ | --------------------------------------------------------------------------------- |
| `agent-mesh name`        | Show the name a session started here gets                                         |
| `agent-mesh name <name>` | Rename sessions started in this project (stored in `~/.agent-mesh/names.json`)    |
| `agent-mesh status`      | Sessions, which are open, and messages waiting                                    |
| `agent-mesh watch`       | Follow the messages between sessions as they happen (`--full` for whole messages) |

A message to a session that is not running waits in its mailbox and is delivered
when the session starts. Two sessions open in the same repo share one name and one
inbox; each message goes to exactly one of them.

`agent-mesh watch` in a spare terminal shows the conversation as it happens:

```
12:00:19  ● @api started a session
12:00:19  @api → @web  t_9ea7e2ac hop 0  can you review the PR?
          ↳ picked up by @web after 10 ms
12:00:19  @web → @api  t_9ea7e2ac hop 1  on it
```

## Loop guard

Two agents can politely answer each other forever. agent-mesh refuses to send:

- after **12** back-and-forths in one thread with no human in between (`MESH_HOP_LIMIT`);
- past **30** messages per minute from one session (`MESH_QUOTA_PER_MIN`).

The refused agent is told to stop and tell its user. Details: [docs/agent-guardrails.md](./docs/agent-guardrails.md).

## Configuration

| Variable                                | Default               |                                            |
| --------------------------------------- | --------------------- | ------------------------------------------ |
| `MESH_USERNAME`                         | repo name             | Session name (wins over `agent-mesh name`) |
| `MESH_LOCAL_DIR`                        | `~/.agent-mesh/local` | Shared mailboxes                           |
| `MESH_HOP_LIMIT` / `MESH_QUOTA_PER_MIN` | `12` / `30`           | Loop guard                                 |
| `MESH_NOTIFY`                           | on                    | `0` off, `sound` sound only                |
| `MESH_SOUND`                            | `Glass`               | macOS system sound                         |

## Security

Everything stays on the machine; the mailbox directories are created readable only
by your user (mode 700). Any process running as your user can read or write the mailboxes: agent-mesh trusts
the machine, like your shell history does. Incoming messages are presented to Claude
as data from another session, not as instructions from you. Names are never read
from the repo, so a cloned repo can't take over another session's name.

How it works → [docs/architecture.md](./docs/architecture.md)

## Packages

| Package           | Role                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `packages/mcp`    | The channel: MCP server with `mesh_send` / `mesh_reply` / `mesh_read_inbox` / `mesh_list_team` |
| `packages/cli`    | `agent-mesh init` / `start` / `name` / `status` / `watch`                                      |
| `packages/plugin` | Claude Code plugin that ships the channel                                                      |
