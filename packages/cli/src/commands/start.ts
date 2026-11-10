import { spawn } from 'node:child_process';
import { PLUGIN_REF } from '../paths.js';

/**
 * `agent-mesh start [claude args…]`: run `claude` with the agent-mesh channel on,
 * so messages land in the session the moment they arrive.
 *
 * While channels are a research preview, Claude Code only accepts `--channels`
 * for plugins on Anthropic's allowlist; any other plugin needs the development
 * flag, which Claude Code confirms with the user at launch.
 */
export function startArgs(extra: string[]): string[] {
  return [
    '--dangerously-load-development-channels',
    `plugin:${PLUGIN_REF.plugin}@${PLUGIN_REF.marketplace}`,
    ...extra,
  ];
}

export async function cmdStart(extra: string[]): Promise<void> {
  const child = spawn('claude', startArgs(extra), { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    child.on('error', (err) =>
      reject(new Error(`could not run claude: ${err.message}. Is Claude Code installed?`)),
    );
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
