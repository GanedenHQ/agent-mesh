#!/usr/bin/env node
/**
 * Plugin hook (SessionStart + UserPromptSubmit): hands new mesh messages to
 * Claude as context, so a plain `claude` launch receives them at its next prompt.
 *
 * With the channel flag on, the MCP server pushes messages live and this hook
 * stays silent, so nothing shows twice. Each message is shown once: what is
 * printed here is archived as read.
 */
import { channelFlagOn } from './channel-flag.js';
import { loadConfig } from './config.js';
import { appendLocalInbox, archiveRead, readLocalInbox } from './inbox.js';
import { Mailbox } from './mailbox.js';
import { formatForContext } from './context.js';

async function readStdin(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (channelFlagOn()) return;

  const cwd =
    typeof input['cwd'] === 'string'
      ? input['cwd']
      : (process.env['CLAUDE_PROJECT_DIR'] ?? undefined);
  const cfg = loadConfig({ cwd, dryRun: true });
  const mailbox = new Mailbox({ root: cfg.localDir, username: cfg.username });

  // Messages the MCP server already took (pushed to nowhere, without the flag),
  // plus any still waiting if the server isn't running.
  const [local, waiting] = await Promise.all([readLocalInbox(cfg.inboxPath), mailbox.readInbox()]);
  const seen = new Set(local.map((m) => m.id));
  const all = [...local, ...waiting.filter((m) => !seen.has(m.id))].sort(
    (a, b) => a.createdAt - b.createdAt,
  );
  if (all.length === 0) return;

  const { text, shown } = formatForContext(cfg.username, all, cfg.archivePath);
  await mailbox.ack(waiting.map((m) => m.id));
  await appendLocalInbox(cfg.inboxPath, cfg.archivePath, waiting);
  // Only what was printed counts as read; a cut-off tail stays for next time.
  await archiveRead(
    cfg.inboxPath,
    cfg.archivePath,
    shown.map((m) => m.id),
  );
  process.stdout.write(text + '\n');
}

main().catch((err: unknown) => {
  // A hook failure must never block the user's prompt.
  process.stderr.write(`[agent-mesh] hook: ${String(err)}\n`);
});
