import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from './types.js';

/**
 * What `agent-mesh watch` shows, computed from the mailboxes on disk: each message
 * when it is sent, again when a session picks it up, and sessions coming and going.
 * Read-only: it never claims anything.
 */
export type FeedEvent =
  | { kind: 'sent'; message: Message }
  | { kind: 'picked-up'; message: Message; afterMs: number }
  | { kind: 'online'; username: string }
  | { kind: 'offline'; username: string };

/** Mailbox file names are `<timestamp>-<seq>-<id>.json` (see mailbox.ts). */
function idOf(file: string): string | null {
  const m = /^\d+-\d+-(.+)\.json$/.exec(file);
  return m ? m[1]! : null;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readMessage(path: string): Message | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Message;
  } catch {
    // Moved between readdir and read (new → cur), or half-written: next poll.
    return null;
  }
}

export class FeedTracker {
  /** Messages already reported as sent, by id. */
  private readonly sent = new Map<string, Message>();
  /** Ids already reported as picked up. */
  private readonly picked = new Set<string>();
  private online = new Set<string>();

  constructor(
    private readonly root: string,
    /** Who has a session open right now. */
    private readonly onlineNow: () => Set<string>,
  ) {}

  /**
   * The last `limit` messages already on disk, oldest first: the backlog shown
   * when watch starts. They count as seen, so `poll` only reports what is new.
   */
  history(limit: number): Message[] {
    this.poll();
    return [...this.sent.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-limit);
  }

  poll(): FeedEvent[] {
    const events: FeedEvent[] = [];

    const online = this.onlineNow();
    // Within one poll: arrivals, then messages, then departures — the order they
    // most likely happened in when a short session does all three in one tick.
    for (const u of online) if (!this.online.has(u)) events.push({ kind: 'online', username: u });
    const departures = [...this.online].filter((u) => !online.has(u));
    this.online = online;

    const boxes = join(this.root, 'mailboxes');
    const found: Array<{ message: Message; pickedAt: number | null }> = [];
    for (const user of list(boxes)) {
      for (const box of ['new', 'cur'] as const) {
        const dir = join(boxes, user, box);
        for (const file of list(dir)) {
          const id = idOf(file);
          if (!id) continue;
          const isPicked = box === 'cur';
          // Only open files that can still produce an event.
          if (this.sent.has(id) && (!isPicked || this.picked.has(id))) continue;
          const path = join(dir, file);
          const message = this.sent.get(id) ?? readMessage(path);
          if (!message) continue;
          let pickedAt: number | null = null;
          if (isPicked) {
            try {
              // The claim is a rename, which updates ctime: when the session took it.
              pickedAt = statSync(path).ctimeMs;
            } catch {
              continue;
            }
          }
          found.push({ message, pickedAt });
        }
      }
    }

    found.sort((a, b) => a.message.createdAt - b.message.createdAt);
    for (const { message, pickedAt } of found) {
      if (!this.sent.has(message.id)) {
        this.sent.set(message.id, message);
        events.push({ kind: 'sent', message });
      }
      if (pickedAt !== null && !this.picked.has(message.id)) {
        this.picked.add(message.id);
        events.push({
          kind: 'picked-up',
          message,
          afterMs: Math.max(0, Math.round(pickedAt - message.createdAt)),
        });
      }
    }
    for (const u of departures) events.push({ kind: 'offline', username: u });
    return events;
  }
}
