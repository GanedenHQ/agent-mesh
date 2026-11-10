import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveUsername } from '../../../mcp/src/config.js';
import { Mailbox } from '../../../mcp/src/mailbox.js';
import { claude } from '../install.js';
import { LOCAL_DIR, PLUGIN_REF } from '../paths.js';

async function waiting(user: string): Promise<number> {
  try {
    return (await readdir(join(LOCAL_DIR, 'mailboxes', user, 'new'))).filter((f) =>
      f.endsWith('.json'),
    ).length;
  } catch {
    return 0;
  }
}

function pluginInstalled(): boolean {
  const r = claude(['plugin', 'list', '--json']);
  return r.ok && r.out.includes(`${PLUGIN_REF.plugin}@${PLUGIN_REF.marketplace}`);
}

export async function cmdStatus(): Promise<void> {
  const here = resolveUsername({ dryRun: true });
  // Read-only view: never started, so it doesn't appear as a session itself.
  const view = new Mailbox({ root: LOCAL_DIR, username: here });
  const team = await view.listTeam();

  console.log(`\n  mailboxes:  ${LOCAL_DIR}`);
  console.log(`  here:       @${here}`);
  console.log(
    `  plugin:     ${pluginInstalled() ? '🟢 installed' : '🔴 not installed — run `agent-mesh init`'}`,
  );

  if (team.length === 0) {
    console.log('\n  No sessions yet. Start Claude Code with the agent-mesh plugin in a repo.\n');
    return;
  }
  console.log(`\n  sessions (${team.length}):`);
  for (const u of team) {
    const n = await waiting(u.username);
    console.log(`    ${u.online ? '🟢' : '⚪️'} @${u.username}${n ? `  (${n} waiting)` : ''}`);
  }
  console.log();
}
