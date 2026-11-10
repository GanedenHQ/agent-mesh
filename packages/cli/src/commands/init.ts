import { readFile, writeFile } from 'node:fs/promises';
import { claudeInstalled, installPlugin, stageMarketplace } from '../install.js';
import { CLAUDE_SETTINGS, PLUGIN_REF } from '../paths.js';

interface ClaudeSettings {
  hooks?: { SessionStart?: Array<{ hooks: Array<{ command: string }> }> };
  [key: string]: unknown;
}

/**
 * Older versions wrote an unread-count hook into ~/.claude/settings.json. The
 * plugin ships its own hooks now, so that one would only duplicate them.
 */
async function removeLegacySettingsHook(): Promise<boolean> {
  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(await readFile(CLAUDE_SETTINGS, 'utf8')) as ClaudeSettings;
  } catch {
    return false;
  }
  const before = settings.hooks?.SessionStart;
  if (!before) return false;
  const after = before.filter(
    (h) => !h.hooks.some((s) => /\/\.(claude|agent)-mesh\/profiles/.test(s.command)),
  );
  if (after.length === before.length) return false;
  settings.hooks!.SessionStart = after;
  await writeFile(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

export async function cmdInit(): Promise<void> {
  if (!claudeInstalled()) {
    throw new Error(
      'Claude Code (`claude`) was not found on PATH. Install it first: https://code.claude.com',
    );
  }
  const dir = stageMarketplace();
  const { action } = installPlugin(dir);
  const ref = `${PLUGIN_REF.plugin}@${PLUGIN_REF.marketplace}`;
  console.log(`\n✓ plugin ${ref} ${action} (from ${dir})`);
  if (await removeLegacySettingsHook()) {
    console.log(`✓ removed an old agent-mesh hook from ${CLAUDE_SETTINGS}`);
  }

  console.log(`
That's it. Every Claude Code session now has the mesh tools, and is named after
its repo (~/code/api → @api). Messages from other sessions show up at the start
of each of your prompts.

To get them instantly, even while a session is idle, start it with:

   agent-mesh start          (same as claude, with the live channel on)

Restart sessions that are already running. Then try, in one of them:

   > who else is running?
   > ask @web whether the login page still uses the old endpoint

Rename a session:  agent-mesh name <name>   (run in its repo)
See who is there:  agent-mesh status
`);
}
