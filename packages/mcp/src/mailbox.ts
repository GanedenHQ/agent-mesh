import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PresenceView } from './delivery.js';
import {
  checkQuota,
  limitsFromEnv,
  nextHop,
  type GuardLimits,
  type ThreadState,
} from './guardrails.js';
import type { Message, UserSummary } from './types.js';

/**
 * Sessions on one machine, talking through the filesystem. No server, no account.
 *
 *   <root>/tmp/                        message files are written here first
 *   <root>/mailboxes/<user>/new/       waiting for <user> (rename from tmp = atomic)
 *   <root>/mailboxes/<user>/cur/       claimed by one of <user>'s sessions
 *   <root>/sessions/<user>.<pid>.json  heartbeat of each open session
 *   <root>/threads/<threadId>.json     hop count of the thread's last message
 *   <root>/quota/<user>.json           send times of <user> in the last minute
 *
 * A session claims a message by renaming it from new/ to cur/. Rename is atomic,
 * so when two sessions share an identity exactly one of them gets each message.
 * fs.watch makes delivery instant; a short poll covers platforms where it misses
 * events. Only plain Node APIs are used, so this runs under node and bun alike.
 */

/** Usernames are directory names: keep them to a safe, portable set. */
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function normalizeUsername(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/^@/, '');
  if (!USERNAME_RE.test(name) || name.includes('..')) {
    throw new Error(
      `agent-mesh: invalid username "${raw}" (letters, digits, "_", "-", "."; max 64).`,
    );
  }
  return name;
}

const HEARTBEAT_MS = 5_000;
/** A session whose heartbeat is older than this is treated as gone. */
const STALE_MS = 15_000;
const MAX_CONTENT_CHARS = 100_000;
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Thread state untouched for this long is dropped; a reply then starts at hop 0. */
const THREAD_TTL_MS = 30 * 24 * 3600 * 1000;

/** Orders messages sent by this process within the same millisecond. */
let sendSeq = 0;

interface SessionFile {
  username: string;
  pid: number;
  cwd: string;
  startedAt: number;
  heartbeatAt: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export interface MailboxOptions {
  root: string;
  username: string;
  /** Fallback scan interval. Default 1000 ms (`MESH_LOCAL_POLL_MS`). */
  pollMs?: number;
  /** Anti-loop limits. Default from env (`MESH_HOP_LIMIT`, `MESH_QUOTA_PER_MIN`). */
  limits?: GuardLimits;
  /**
   * True when a person sends through this transport (the CLI), false for a
   * Claude session. A human message resets the thread's hop count and is not
   * subject to the quota.
   */
  human?: boolean;
}

export class Mailbox implements PresenceView {
  readonly root: string;
  private readonly me: string;
  private readonly pollMs: number;
  private readonly limits: GuardLimits;
  private readonly human: boolean;
  private readonly startedAt = Date.now();
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<void> | null = null;
  private rescan = false;
  private started = false;
  private stopped = false;
  private onMessage: (m: Message) => void = () => undefined;

  constructor(opts: MailboxOptions) {
    this.root = opts.root;
    this.me = normalizeUsername(opts.username);
    this.pollMs = opts.pollMs ?? (Number(process.env['MESH_LOCAL_POLL_MS']) || 1_000);
    this.limits = opts.limits ?? limitsFromEnv();
    this.human = opts.human ?? false;
  }

  // --- paths ---------------------------------------------------------------------

  private mailbox(user: string, box: 'new' | 'cur'): string {
    return join(this.root, 'mailboxes', user, box);
  }
  private get sessionsDir(): string {
    return join(this.root, 'sessions');
  }
  private get sessionFile(): string {
    return join(this.sessionsDir, `${this.me}.${process.pid}.json`);
  }

  // --- presence ------------------------------------------------------------------

  get presenceObserved(): boolean {
    return this.started;
  }

  isOnline(username: string): boolean {
    return this.onlineUsers().has(username.toLowerCase().replace(/^@/, ''));
  }

  /** Users with at least one live session. Also sweeps files left by dead sessions. */
  onlineUsers(): Set<string> {
    const online = new Set<string>();
    let names: string[];
    try {
      names = readdirSync(this.sessionsDir);
    } catch {
      return online;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.sessionsDir, name);
      try {
        const s = JSON.parse(readFileSync(path, 'utf8')) as SessionFile;
        if (now - s.heartbeatAt < STALE_MS && pidAlive(s.pid)) {
          online.add(s.username);
        } else if (!pidAlive(s.pid)) {
          unlinkSync(path);
        }
      } catch {
        // Half-written or already removed: skip it this round.
      }
    }
    return online;
  }

  private async beat(): Promise<void> {
    const body: SessionFile = {
      username: this.me,
      pid: process.pid,
      cwd: process.cwd(),
      startedAt: this.startedAt,
      heartbeatAt: Date.now(),
    };
    if (this.stopped) return;
    await this.atomicWrite(this.sessionFile, JSON.stringify(body));
    // stop() may have removed the file while this write was in flight.
    if (this.stopped) await unlink(this.sessionFile).catch(() => undefined);
  }

  // --- messages ------------------------------------------------------------------

  private async atomicWrite(dest: string, data: string): Promise<void> {
    const tmp = join(this.root, 'tmp', `${process.pid}-${randomUUID()}`);
    await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, dest);
  }

  private async ensureLayout(): Promise<void> {
    for (const dir of [
      join(this.root, 'tmp'),
      join(this.root, 'threads'),
      join(this.root, 'quota'),
      this.sessionsDir,
      this.mailbox(this.me, 'new'),
      this.mailbox(this.me, 'cur'),
    ]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
  }

  async knownUsers(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, 'mailboxes'))).sort();
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  async send(args: { to: string; content: string; threadId?: string }): Promise<Message> {
    const to = normalizeUsername(args.to);
    if (args.content.length > MAX_CONTENT_CHARS) {
      throw new Error(
        `agent-mesh: message too long (${args.content.length} > ${MAX_CONTENT_CHARS} chars).`,
      );
    }
    await this.ensureLayout();
    if (!existsSync(join(this.root, 'mailboxes', to))) {
      const known = (await this.knownUsers()).map((u) => `@${u}`).join(', ') || 'nobody yet';
      throw new Error(
        `agent-mesh: no session named @${to} has ever started on this machine. Known: ${known}.`,
      );
    }
    if (args.threadId !== undefined && !THREAD_ID_RE.test(args.threadId)) {
      throw new Error(`agent-mesh: invalid threadId "${args.threadId}".`);
    }
    const threadId = args.threadId ?? `t_${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    // Guards first: a refused message leaves no trace and costs no quota.
    const prev = args.threadId ? await this.readJson<ThreadState>(this.threadFile(threadId)) : null;
    const hopCount = this.human ? 0 : nextHop(prev, this.limits);
    const quota = this.human
      ? null
      : checkQuota((await this.readJson<number[]>(this.quotaFile)) ?? [], now, this.limits);

    const message: Message = {
      id: randomUUID(),
      from: this.me,
      to,
      threadId,
      content: args.content,
      createdAt: now,
      deliveredAt: null,
      ackedAt: null,
      hopCount,
    };
    // Make sure the target dir exists even if the recipient wiped it.
    await mkdir(this.mailbox(to, 'new'), { recursive: true, mode: 0o700 });
    // Sortable name: timestamp, then this process's send order, then the id.
    const seq = String(sendSeq++ % 1_000_000).padStart(6, '0');
    const file = `${String(message.createdAt).padStart(15, '0')}-${seq}-${message.id}.json`;
    await this.atomicWrite(join(this.mailbox(to, 'new'), file), JSON.stringify(message));
    const state: ThreadState = { hop: hopCount, lastFromHuman: this.human };
    await this.atomicWrite(this.threadFile(threadId), JSON.stringify(state));
    if (quota) await this.atomicWrite(this.quotaFile, JSON.stringify(quota));
    return message;
  }

  private threadFile(threadId: string): string {
    return join(this.root, 'threads', `${threadId}.json`);
  }
  private get quotaFile(): string {
    return join(this.root, 'quota', `${this.me}.json`);
  }

  private async pruneThreads(): Promise<void> {
    const dir = join(this.root, 'threads');
    const cutoff = Date.now() - THREAD_TTL_MS;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, name);
      const s = await stat(path).catch(() => null);
      if (s && s.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
    }
  }

  /** Parsed JSON file, or null when it doesn't exist or can't be read. */
  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Waiting messages, oldest first. File names start with the timestamp. */
  private async listNew(): Promise<Array<{ file: string; message: Message }>> {
    let files: string[];
    try {
      files = (await readdir(this.mailbox(this.me, 'new'))).filter((f) => f.endsWith('.json'));
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    files.sort();
    const out: Array<{ file: string; message: Message }> = [];
    for (const file of files) {
      try {
        const message = JSON.parse(
          await readFile(join(this.mailbox(this.me, 'new'), file), 'utf8'),
        ) as Message;
        out.push({ file, message });
      } catch (err) {
        // Claimed by another session between readdir and read: fine.
        if (!isMissing(err)) {
          process.stderr.write(`[agent-mesh] unreadable message ${file}: ${String(err)}\n`);
        }
      }
    }
    return out;
  }

  async readInbox(): Promise<Message[]> {
    return (await this.listNew()).map((e) => e.message);
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    for (const { file, message } of await this.listNew()) {
      if (wanted.has(message.id)) await this.claim(file);
    }
  }

  /** Move a message to cur/. False when another session claimed it first. */
  private async claim(file: string): Promise<boolean> {
    try {
      await rename(
        join(this.mailbox(this.me, 'new'), file),
        join(this.mailbox(this.me, 'cur'), file),
      );
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async listTeam(): Promise<UserSummary[]> {
    const online = this.onlineUsers();
    return (await this.knownUsers()).map((username) => ({
      username,
      online: online.has(username),
    }));
  }

  // --- live delivery -------------------------------------------------------------

  /** Claim and hand over everything waiting. Concurrent calls collapse into one rerun. */
  private scan(): Promise<void> {
    // A stopped session must not claim: the message would be lost with it.
    if (!this.started) return Promise.resolve();
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.rescan = false;
        for (const { file, message } of await this.listNew()) {
          // Re-checked per file: stop() can land while this loop awaits.
          if (!this.started) return;
          if (await this.claim(file)) this.onMessage({ ...message, deliveredAt: Date.now() });
        }
      } while (this.rescan);
    })()
      .catch((err: unknown) => {
        process.stderr.write(`[agent-mesh] local scan failed: ${String(err)}\n`);
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  async start(onMessage: (m: Message) => void): Promise<void> {
    this.onMessage = onMessage;
    await this.ensureLayout();
    await this.beat();
    this.started = true;
    void this.pruneThreads();

    try {
      this.watcher = watch(this.mailbox(this.me, 'new'), () => void this.scan());
      this.watcher.on('error', () => undefined);
    } catch {
      // No watcher on this platform/filesystem: the poll below still delivers.
    }
    this.pollTimer = setInterval(() => void this.scan(), this.pollMs);
    this.heartbeatTimer = setInterval(() => void this.beat().catch(() => undefined), HEARTBEAT_MS);
    this.pollTimer.unref?.();
    this.heartbeatTimer.unref?.();
    await this.scan();
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.watcher = null;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    try {
      unlinkSync(this.sessionFile);
    } catch {
      // Already gone.
    }
  }
}
