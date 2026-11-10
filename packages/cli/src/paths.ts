import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const MESH_DIR = join(HOME, '.agent-mesh');
export const LOCAL_DIR = process.env['MESH_LOCAL_DIR'] ?? join(MESH_DIR, 'local');

export const CLAUDE_SETTINGS = join(HOME, '.claude', 'settings.json');

/** Marketplace + plugin names, as declared in .claude-plugin/marketplace.json. */
export const PLUGIN_REF = { marketplace: 'agent-mesh', plugin: 'agent-mesh' } as const;

/** Stable copy of the marketplace that Claude Code installs the plugin from. */
export const MARKETPLACE_DIR = join(MESH_DIR, 'marketplace');
