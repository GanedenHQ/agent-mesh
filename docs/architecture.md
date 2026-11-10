# Architecture

One MCP server per Claude Code session (`packages/mcp`), started by the plugin. The
servers never talk to each other directly: they share a directory.

```
~/.agent-mesh/
  local/
    tmp/                         message files are written here first
    mailboxes/<user>/new/        waiting for <user>
    mailboxes/<user>/cur/        claimed by one of <user>'s sessions
    sessions/<user>.<pid>.json   heartbeat of each open session
    threads/<threadId>.json      hop count of the thread's last message
    quota/<user>.json            send times of <user> in the last minute
  profiles/<user>/inbox.jsonl    messages received, not yet read with mesh_read_inbox
  profiles/<user>/inbox.archive.jsonl
```

## Sending

`mesh_send` / `mesh_reply` (`src/mailbox.ts → send`):

1. Check the recipient has a mailbox (a session with that name started once), else
   refuse and list the known names — a typo should fail, not vanish.
2. Apply the loop guard (`src/guardrails.ts`). A refused message leaves no trace.
3. Write the message to `tmp/`, then `rename` it into `mailboxes/<to>/new/`. The
   rename is atomic: a reader sees a whole file or nothing.

File names start with the timestamp and a per-process counter, so a mailbox lists
in send order.

## Receiving

Each session watches its `new/` directory (`fs.watch`) and also scans it every second
in case the platform drops a watch event. For each file, it **claims** the message by
renaming it to `cur/`. Rename succeeds for exactly one process, so two sessions with
the same name never both receive a message. The claimed message is then:

- appended to `profiles/<user>/inbox.jsonl` (fallback when channels are off);
- shown as a desktop notification (`src/notify.ts`);
- pushed into the session as a `notifications/claude/channel` event, with
  `from`, `thread_id`, `msg_id` and `hop` attributes.

A session that is not running simply doesn't claim: messages wait in `new/` and are
delivered on its next start.

### Getting the message in front of Claude

Claude Code drops a channel push silently unless the session was started with the
channel flag, and tells the server nothing either way. So there are two paths:

- **Channel** (`agent-mesh start`): the push above lands in the session at once.
- **Hook** (`src/hook.ts`, run by the plugin at `SessionStart` and `UserPromptSubmit`):
  reads the unread messages of `inbox.jsonl` (plus any still in `new/`, claiming them),
  prints them as context for Claude, and archives what it printed. Each message is
  shown once; a burst past 20 000 characters is cut and the rest waits for the next
  prompt or `mesh_read_inbox`.

The hook stays silent when the channel is on, so nothing shows twice. It knows by
looking for the channel flag on the command line of its ancestor processes
(`src/channel-flag.ts`, `ps`; on Windows it assumes no channel).

## Presence

Every 5 s a session rewrites `sessions/<user>.<pid>.json`. A user is online when one
of its files is less than 15 s old **and** its pid is alive; files of dead pids are
deleted when seen. The file is removed when the session ends (stdin closes).

Presence says a session is open, not that its Claude read the message, so the send
result says exactly that (`src/delivery.ts`).

## Names

`src/config.ts`. The project is the repo root above the working directory (or the
working directory outside a repo). Its name, first match wins:

1. `MESH_USERNAME` env;
2. the name the user set with `agent-mesh name`, stored in `~/.agent-mesh/names.json`
   keyed by project directory;
3. the project directory's name, made unique on the machine.

Each name has one owner, recorded in `local/owners/<name>` (the project directory).
A default name is used only if it is free or already owned by this project; otherwise
the session gets `<name>-2`, `<name>-3`… A name the user set takes ownership, and the
previous owner falls back to a suffixed name on its next start.

Nothing in the repo is read to pick the name: a cloned repo can't make its session
answer as another one and receive its messages. Names are limited to `[a-z0-9_.-]`,
so they are always safe as file names.

## Runtime

Plain Node APIs only, so the bundled server and hook (`packages/plugin/server/`)
run under `node` or `bun`. Dependencies: the MCP SDK and zod.
