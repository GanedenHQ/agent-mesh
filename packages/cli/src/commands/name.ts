import { NAMES_FILE, projectDir, resolveUsername, writeName } from '../../../mcp/src/config.js';
import { normalizeUsername } from '../../../mcp/src/mailbox.js';

/**
 * `agent-mesh name`        → print the name a session started here gets
 * `agent-mesh name <name>` → set it for this project (stored in ~/.agent-mesh/names.json,
 *                             never in the repo, so a cloned repo can't pick its own name)
 */
export async function cmdName(args: string[]): Promise<void> {
  const wanted = args[0];
  if (!wanted) {
    console.log(`@${resolveUsername({ dryRun: true })}`);
    return;
  }
  const name = normalizeUsername(wanted);
  const dir = projectDir();
  writeName(dir, name);
  console.log(`✓ sessions started in ${dir} are now @${name}  (${NAMES_FILE})`);
  console.log('  (restart a session that is already running to pick it up)');
  if (process.env['MESH_USERNAME']) {
    console.log(`  ⚠ MESH_USERNAME=${process.env['MESH_USERNAME']} is set and takes precedence`);
  }
}
