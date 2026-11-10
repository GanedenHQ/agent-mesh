import { FeedTracker, type FeedEvent } from '../../../mcp/src/feed.js';
import { Mailbox } from '../../../mcp/src/mailbox.js';
import type { Message } from '../../../mcp/src/types.js';
import { LOCAL_DIR } from '../paths.js';

const POLL_MS = 300;
const HISTORY = 10;

const tty = process.stdout.isTTY === true && !process.env['NO_COLOR'];
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');

const time = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/**
 * Message fields are written by other sessions: never let them drive the
 * terminal. Control characters (ESC sequences can set the title, write the
 * clipboard, clear the screen) become a visible `\xNN`; `keepLines` keeps
 * newlines and tabs for --full.
 */
export function safe(text: string, keepLines = false): string {
  const re = keepLines
    ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
    : /[\u0000-\u001f\u007f-\u009f]/g;
  return String(text).replace(re, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function oneLine(text: string, width: number): string {
  const flat = safe(text.replace(/\s+/g, ' ').trim());
  return flat.length > width ? `${flat.slice(0, Math.max(0, width - 1))}…` : flat;
}

export function formatMessage(raw: Message, full: boolean, columns: number): string {
  const m = { ...raw, from: safe(raw.from), to: safe(raw.to), threadId: safe(raw.threadId) };
  const hop = m.hopCount !== undefined ? ` hop ${m.hopCount}` : '';
  const head = `${dim(time(m.createdAt))}  ${bold(`@${m.from}`)} → ${bold(`@${m.to}`)}  ${dim(`${m.threadId}${hop}`)}`;
  if (full) return `${head}\n${safe(m.content, true).replace(/^/gm, '    ')}`;
  // Visible width of the head, without color codes.
  const headWidth = `${time(m.createdAt)}  @${m.from} → @${m.to}  ${m.threadId}${hop}`.length;
  return `${head}  ${oneLine(m.content, Math.max(20, columns - headWidth - 2))}`;
}

function formatEvent(e: FeedEvent, full: boolean, columns: number): string {
  switch (e.kind) {
    case 'sent':
      return formatMessage(e.message, full, columns);
    case 'picked-up':
      return dim(`          ↳ picked up by @${safe(e.message.to)} after ${e.afterMs} ms`);
    case 'online':
      return green(`${time(Date.now())}  ● @${safe(e.username)} started a session`);
    case 'offline':
      return yellow(`${time(Date.now())}  ○ @${safe(e.username)} ended its session`);
  }
}

/**
 * `agent-mesh watch [--full]`: the messages between sessions as they happen,
 * plus sessions starting and ending. Read-only. Ctrl-C to stop.
 */
export async function cmdWatch(args: string[]): Promise<void> {
  const full = args.includes('--full');
  const columns = () => process.stdout.columns || 100;
  const presence = new Mailbox({ root: LOCAL_DIR, username: 'watch' });
  const feed = new FeedTracker(LOCAL_DIR, () => presence.onlineUsers());

  const backlog = feed.history(HISTORY);
  const online = [...presence.onlineUsers()].sort();
  console.log(
    `${bold('agent-mesh watch')}  ${dim(LOCAL_DIR)}\n` +
      `online: ${online.length ? online.map((u) => green(`@${safe(u)}`)).join(' ') : dim('nobody')}\n`,
  );
  if (backlog.length) {
    console.log(dim(`last ${backlog.length} message(s):`));
    for (const m of backlog) console.log(formatMessage(m, full, columns()));
    console.log(dim('— live —'));
  } else {
    console.log(dim('waiting for messages… (Ctrl-C to stop)'));
  }

  const timer = setInterval(() => {
    for (const e of feed.poll()) console.log(formatEvent(e, full, columns()));
  }, POLL_MS);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      clearInterval(timer);
      resolve();
    });
  });
}
