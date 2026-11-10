import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETPLACE_DIR, PLUGIN_REF } from './paths.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Marketplace {
  plugins: Array<{ name: string; source: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * The marketplace this CLI ships with: next to `cli.js` in the npm package,
 * at the repo root when run from a checkout (packages/cli/src → ../../..).
 */
export function bundledMarketplace(): string {
  for (const dir of [HERE, resolve(HERE, '..', '..', '..')]) {
    if (existsSync(join(dir, '.claude-plugin', 'marketplace.json'))) return dir;
  }
  throw new Error('agent-mesh: the plugin is missing from this install (no marketplace.json).');
}

/**
 * Copy the marketplace to ~/.agent-mesh/marketplace. Claude Code keeps reading
 * the path it was given, and an npx cache directory can vanish at any time.
 * The plugin must be built: a checkout needs `bun run build:plugin` first.
 */
export function stageMarketplace(from: string = bundledMarketplace()): string {
  const manifest = JSON.parse(
    readFileSync(join(from, '.claude-plugin', 'marketplace.json'), 'utf8'),
  ) as Marketplace;
  const entry = manifest.plugins.find((p) => p.name === PLUGIN_REF.plugin);
  if (!entry) throw new Error('agent-mesh: marketplace.json does not list the plugin.');
  const pluginDir = resolve(from, entry.source);
  if (!existsSync(join(pluginDir, 'server', 'channel.js'))) {
    throw new Error(
      `agent-mesh: ${join(pluginDir, 'server', 'channel.js')} is missing. ` +
        'In a checkout, run `bun run build:plugin` first.',
    );
  }

  rmSync(MARKETPLACE_DIR, { recursive: true, force: true });
  mkdirSync(join(MARKETPLACE_DIR, '.claude-plugin'), { recursive: true });
  cpSync(pluginDir, join(MARKETPLACE_DIR, 'plugin'), {
    recursive: true,
    // Relative check: under npx the package itself lives inside a node_modules.
    filter: (src) => !relative(pluginDir, src).split(sep).includes('node_modules'),
  });
  entry.source = './plugin';
  writeFileSync(
    join(MARKETPLACE_DIR, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return MARKETPLACE_DIR;
}

export interface Run {
  ok: boolean;
  out: string;
}

export function claude(args: string[]): Run {
  const r = spawnSync('claude', args, { encoding: 'utf8' });
  if (r.error) return { ok: false, out: String(r.error.message) };
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export function claudeInstalled(): boolean {
  return claude(['--version']).ok;
}

function pluginInstalled(): boolean {
  const r = claude(['plugin', 'list', '--json']);
  return r.ok && r.out.includes(`${PLUGIN_REF.plugin}@${PLUGIN_REF.marketplace}`);
}

/** Install the plugin, or update it when it is already there. */
export function installPlugin(marketplaceDir: string): { action: 'installed' | 'updated' } {
  const ref = `${PLUGIN_REF.plugin}@${PLUGIN_REF.marketplace}`;
  if (pluginInstalled()) {
    const refresh = claude(['plugin', 'marketplace', 'update', PLUGIN_REF.marketplace]);
    if (!refresh.ok) throw new Error(`claude plugin marketplace update failed:\n${refresh.out}`);
    const update = claude(['plugin', 'update', ref]);
    if (!update.ok) throw new Error(`claude plugin update failed:\n${update.out}`);
    return { action: 'updated' };
  }
  const install = claude([
    'plugin',
    'install',
    PLUGIN_REF.plugin,
    '--marketplace',
    marketplaceDir,
    '--scope',
    'user',
  ]);
  if (!install.ok) throw new Error(`claude plugin install failed:\n${install.out}`);
  return { action: 'installed' };
}
