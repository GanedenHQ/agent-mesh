#!/usr/bin/env bun
import { cmdInit } from './commands/init.js';
import { cmdName } from './commands/name.js';
import { cmdStart } from './commands/start.js';
import { cmdStatus } from './commands/status.js';
import { cmdWatch } from './commands/watch.js';

const HELP = `
agent-mesh — let the Claude Code sessions on this machine message each other

Usage:
  agent-mesh init            Install (or update) the Claude Code plugin
  agent-mesh start [args…]  Run claude with messages delivered live (args go to claude)
  agent-mesh name [<name>]  Show, or set, the name of sessions started in this project
  agent-mesh status         List sessions, which are open, and waiting messages
  agent-mesh watch [--full] Follow the messages between sessions as they happen
  agent-mesh help           Show this help

A session is named after its repo by default (~/code/api → @api). In a plain
\`claude\` session, messages show up at each prompt; \`agent-mesh start\` delivers
them the moment they arrive.
`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  switch (cmd) {
    case 'init':
      await cmdInit();
      return;
    case 'start':
      await cmdStart(process.argv.slice(3));
      return;
    case 'name':
      await cmdName(process.argv.slice(3));
      return;
    case 'status':
    case 'ls':
      await cmdStatus();
      return;
    case 'watch':
      await cmdWatch(process.argv.slice(3));
      return;
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
