import { spawnSync } from 'node:child_process';

/**
 * Was this Claude Code session launched with the agent-mesh channel turned on?
 *
 * Claude Code gives no signal for it: a channel push to a session started
 * without the flag is dropped silently. The flag is on the `claude` command
 * line, though, and both the MCP server and the hooks run under that process,
 * so we look for it among our ancestors. `ps` exists on macOS and Linux; on
 * Windows this answers false and the hook delivers instead (worst case, a
 * message shows twice).
 */
export function channelFlagOn(startPid: number = process.ppid, maxDepth = 6): boolean {
  if (process.platform === 'win32') return false;
  let pid = startPid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    const r = spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8' });
    const line = (r.stdout ?? '').trim();
    if (!line) return false;
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) return false;
    if (hasChannelFlag(m[2]!)) return true;
    pid = Number(m[1]);
  }
  return false;
}

/** True when a command line turns on the agent-mesh plugin as a channel. */
export function hasChannelFlag(args: string): boolean {
  return (
    /--(dangerously-load-development-)?channels\b/.test(args) && /plugin:agent-mesh@/.test(args)
  );
}
