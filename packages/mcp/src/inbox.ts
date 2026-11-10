import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Message } from './types.js';

/** How many trailing bytes of the archive to scan for dedup. Bounds the hot path
 * regardless of how large the archive grows. */
const ARCHIVE_DEDUP_TAIL_BYTES = 64 * 1024;

/**
 * Append received messages to the local JSONL inbox (one JSON object per line,
 * `read: false`). The inbox holds the *unread* working set only — read messages
 * are moved to the sibling archive by {@link archiveRead}. Idempotent on message id:
 * skips anything already in the inbox or in the recent tail of the archive.
 */
export async function appendLocalInbox(
  inboxPath: string,
  archivePath: string,
  messages: Message[],
): Promise<void> {
  if (messages.length === 0) return;
  await mkdir(dirname(inboxPath), { recursive: true });
  const seen = new Set((await readLocalInboxRaw(inboxPath)).map((m) => m.id));
  for (const id of await readRecentIds(archivePath, ARCHIVE_DEDUP_TAIL_BYTES)) seen.add(id);
  const fresh = messages.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) return;
  const lines = fresh.map((m) => JSON.stringify({ ...m, read: false })).join('\n') + '\n';
  await appendFile(inboxPath, lines, 'utf8');
}

/** Read every entry for idempotency checks. */
async function readLocalInboxRaw(path: string): Promise<Array<Message & { read?: boolean }>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<Message & { read?: boolean }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Message & { read?: boolean });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Read unread messages from the local JSONL inbox cache (written by the channel's
 * WebSocket client). Lines are append-only JSON objects; any `read: true` line is
 * legacy residue (pre-archive) and is skipped here — {@link archiveRead} sweeps it out.
 */
export async function readLocalInbox(path: string): Promise<Message[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const messages: Message[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Message & { read?: boolean };
      if (entry.read) continue;
      messages.push(entry);
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}

/**
 * Move read messages out of the inbox into the durable archive, keeping `inbox.jsonl`
 * down to the unread working set. A line is archived when its id is in `messageIds`
 * OR it already carries `read: true` (legacy sweep / re-entrancy). The remaining
 * unread lines are rewritten back to the inbox. Returns the number archived.
 */
export async function archiveRead(
  inboxPath: string,
  archivePath: string,
  messageIds: string[],
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(inboxPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }

  const idSet = new Set(messageIds);
  const keep: string[] = [];
  const archived: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Message & { read?: boolean; archivedAt?: number };
    try {
      entry = JSON.parse(line) as Message & { read?: boolean; archivedAt?: number };
    } catch {
      keep.push(line); // preserve malformed lines untouched
      continue;
    }
    if (idSet.has(entry.id) || entry.read) {
      archived.push(JSON.stringify({ ...entry, read: true, archivedAt: entry.archivedAt ?? Date.now() }));
    } else {
      keep.push(line);
    }
  }

  if (archived.length === 0) return 0;
  await mkdir(dirname(archivePath), { recursive: true });
  await appendFile(archivePath, archived.join('\n') + '\n', 'utf8');
  await writeFile(inboxPath, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
  return archived.length;
}

/**
 * Collect message ids from the trailing `maxBytes` of a JSONL file, for dedup.
 * Reading only the tail keeps the cost bounded as the archive grows. Returns an
 * empty set if the file does not exist.
 */
async function readRecentIds(path: string, maxBytes: number): Promise<Set<string>> {
  const ids = new Set<string>();
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ids;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return ids;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // We started mid-file: the first line is likely partial — drop it.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        ids.add((JSON.parse(line) as { id: string }).id);
      } catch {
        /* skip */
      }
    }
    return ids;
  } finally {
    await fh.close();
  }
}
