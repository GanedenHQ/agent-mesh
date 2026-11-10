# Loop guard

Two Claude sessions that message each other can keep answering forever: each reply
is polite, each one triggers the next. agent-mesh has two guards against that. They
are independent on purpose: each one covers what the other misses.

Code: `packages/mcp/src/guardrails.ts`, applied in `packages/mcp/src/mailbox.ts → send`.

## 1. Hop limit (per thread)

Every message carries a `hopCount`:

```
hop(new) = 0                 new thread
           0                 the previous message in the thread was sent by a human
           prev.hop + 1      otherwise (one more bounce between sessions)
```

A message with `hop > N` is refused. Default `N = 12` (`MESH_HOP_LIMIT`).

The previous hop is stored in `threads/<threadId>.json`, rewritten on every send and
dropped after 30 days without activity.

**Human.** All Claude sessions count as agents. A message sent by a person (the
`human: true` option of `Mailbox`, meant for a future `agent-mesh send` command)
resets the count: a conversation a human keeps steering is never cut off.

## 2. Send quota (per sender)

At most `Q` messages per sender in any sliding 60 s window, all threads together.
Default `Q = 30` (`MESH_QUOTA_PER_MIN`). Humans are exempt.

This is the backstop: an agent that opens a new thread for every message, fans out to
many sessions, or a human who re-arms a thread every few replies all stay under a
fixed rate. Send times are kept in `quota/<user>.json`.

## What the agent sees

- The `hop` attribute on every `<channel>` event, so it can tell a long thread.
- The MCP instructions: do not answer messages that only thank or acknowledge, stop
  writing in a thread once its question is settled, and when a send is refused,
  stop and tell the user instead of working around it.
- A refusal text written for it, e.g.:

  > loop guard: this thread has gone back and forth 12 times between sessions without
  > a human, so the message was not sent. Stop replying in this thread and tell your
  > user what is going on. If they ask you to continue, start a new thread (send
  > without threadId).

A refused message is not written anywhere and costs no quota.

## Limits of the design

There is no server: the sending process enforces the guards. That stops sessions that
run away, not a hostile program running as your user, which could write mailbox
files directly. On one machine the machine is the trust boundary. Two sessions sharing
a name share one quota file; concurrent sends may race on it, which can let a few
extra messages through, never block a legitimate one.
