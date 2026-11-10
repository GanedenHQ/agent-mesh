import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { normalizeUsername } from './mailbox.js';

export interface MeshConfig {
  /** This session's name on the mesh (`@username`). */
  username: string;
  /** Root of the shared mailboxes (`MESH_LOCAL_DIR`, default ~/.agent-mesh/local). */
  localDir: string;
  /** Local cache of unread received messages (per identity). */
  inboxPath: string;
  /** Durable archive of already-read messages (sibling of inboxPath). */
  archivePath: string;
}

export const MESH_DIR = join(homedir(), '.agent-mesh');

/** Where the user's chosen names live: `{ "<repo dir>": "<name>" }`. */
export const NAMES_FILE = join(MESH_DIR, 'names.json');

const MAX_SUFFIX = 99;

/** The repo root containing `cwd`, or `cwd` itself outside a repo. */
export function projectDir(cwd: string = process.cwd()): string {
  // Real path: the MCP server and the hook may be handed the same directory
  // through different symlinks (/var vs /private/var on macOS), and names are
  // owned by directory, so both must spell it the same way.
  const start = realpath(resolve(cwd));
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A directory name turned into a username: `My API` → `my-api`. */
export function defaultUsername(dir: string): string {
  const slug = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 64);
  return slug || 'claude';
}

export function readNames(path: string = NAMES_FILE): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function writeName(dir: string, name: string, path: string = NAMES_FILE): void {
  const names = readNames(path);
  names[realpath(resolve(dir))] = name;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(names, null, 2) + '\n', { mode: 0o600 });
}

/**
 * The name the user asked for, if any: MESH_USERNAME (or MESH_PROFILE) env, then
 * the binding `agent-mesh name` stored for this project. Never read from the
 * repo itself — a cloned repo must not be able to pick its own identity.
 */
function chosenName(dir: string, namesPath: string): string | null {
  const fromEnv = process.env['MESH_USERNAME'] ?? process.env['MESH_PROFILE'];
  if (fromEnv) return fromEnv.toLowerCase();
  return readNames(namesPath)[dir]?.toLowerCase() ?? null;
}

/**
 * Each name belongs to one project directory, recorded in `<localDir>/owners/<name>`.
 * A name the user chose takes ownership. A default name (the directory's) is only
 * used if free or already ours; otherwise the next free `<name>-2`, `<name>-3`…
 * So two repos both called `app` get `@app` and `@app-2` instead of sharing one
 * inbox, and only the user can make a session answer to an existing name.
 */
function firstFreeName(ownersDir: string, wanted: string, dir: string): string {
  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const name = i === 1 ? wanted : `${wanted.slice(0, 60)}-${i}`;
    let owner: string | null = null;
    try {
      owner = readFileSync(join(ownersDir, name), 'utf8').trim();
    } catch {
      // No owner file: the name is free.
    }
    if (owner === null || owner === dir) return name;
  }
  throw new Error(
    `agent-mesh: no free name left for "${wanted}". Pick one: agent-mesh name <name>`,
  );
}

export interface ResolveOptions {
  cwd?: string;
  localDir?: string;
  namesPath?: string;
  /** Read only: report the name without recording ownership. */
  dryRun?: boolean;
}

/**
 * This session's name: the user's choice if any (see {@link chosenName}), else the
 * project directory's name, made unique on this machine (see {@link firstFreeName}).
 */
export function resolveUsername(opts: ResolveOptions = {}): string {
  const dir = projectDir(opts.cwd);
  const ownersDir = join(opts.localDir ?? defaultLocalDir(), 'owners');
  const chosen = chosenName(dir, opts.namesPath ?? NAMES_FILE);
  const name = chosen
    ? normalizeUsername(chosen)
    : firstFreeName(ownersDir, defaultUsername(dir), dir);
  if (!opts.dryRun) {
    mkdirSync(ownersDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(ownersDir, name), dir + '\n', { mode: 0o600 });
  }
  return name;
}

function defaultLocalDir(): string {
  return process.env['MESH_LOCAL_DIR'] ?? join(MESH_DIR, 'local');
}

/**
 * `dryRun` for readers that must not claim a name (the hook, the CLI): they
 * see the name the session's MCP server took.
 */
export function loadConfig(opts: { cwd?: string; dryRun?: boolean } = {}): MeshConfig {
  const localDir = defaultLocalDir();
  const username = resolveUsername({ localDir, cwd: opts.cwd, dryRun: opts.dryRun });
  const inboxPath =
    process.env['MESH_INBOX_PATH'] ?? join(MESH_DIR, 'profiles', username, 'inbox.jsonl');
  // Archive lives next to the inbox: `inbox.jsonl` → `inbox.archive.jsonl`.
  const archivePath =
    process.env['MESH_ARCHIVE_PATH'] ??
    (inboxPath.endsWith('.jsonl')
      ? inboxPath.replace(/\.jsonl$/, '.archive.jsonl')
      : `${inboxPath}.archive`);

  return { username, localDir, inboxPath, archivePath };
}
