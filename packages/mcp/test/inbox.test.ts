import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLocalInbox, archiveRead, readLocalInbox } from '../src/inbox';
import type { Message } from '../src/types';

describe('MCP inbox JSONL', () => {
  let tmp: string;
  let inboxPath: string;
  let archivePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mesh-mcp-test-'));
    inboxPath = join(tmp, 'inbox.jsonl');
    archivePath = join(tmp, 'inbox.archive.jsonl');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function entry(id: string, read = false) {
    return JSON.stringify({
      id,
      from: 'alice',
      to: 'bob',
      threadId: 't_1',
      content: `msg ${id}`,
      createdAt: 1,
      deliveredAt: null,
      ackedAt: null,
      read,
    });
  }

  async function ids(path: string): Promise<string[]> {
    const raw = await readFile(path, 'utf8').catch(() => '');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { id: string }).id);
  }

  it('returns [] when file missing', async () => {
    expect(await readLocalInbox(inboxPath)).toEqual([]);
  });

  it('reads unread entries', async () => {
    await writeFile(inboxPath, [entry('m1'), entry('m2'), entry('m3')].join('\n') + '\n');
    const got = await readLocalInbox(inboxPath);
    expect(got.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('filters out read entries', async () => {
    await writeFile(inboxPath, [entry('m1', true), entry('m2'), entry('m3', true)].join('\n') + '\n');
    const got = await readLocalInbox(inboxPath);
    expect(got.map((m) => m.id)).toEqual(['m2']);
  });

  it('ignores malformed lines', async () => {
    await writeFile(inboxPath, [entry('m1'), 'not json', '', entry('m2')].join('\n') + '\n');
    const got = await readLocalInbox(inboxPath);
    expect(got.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('archiveRead moves named ids out of the inbox into the archive', async () => {
    await writeFile(inboxPath, [entry('m1'), entry('m2'), entry('m3')].join('\n') + '\n');
    const moved = await archiveRead(inboxPath, archivePath, ['m1', 'm3']);
    expect(moved).toBe(2);

    // Inbox keeps only the still-unread message.
    expect(await ids(inboxPath)).toEqual(['m2']);
    expect((await readLocalInbox(inboxPath)).map((m) => m.id)).toEqual(['m2']);

    // Archive holds the read ones, flagged + stamped.
    expect((await ids(archivePath)).sort()).toEqual(['m1', 'm3']);
    const archived = (await readFile(archivePath, 'utf8'))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { read: boolean; archivedAt: number });
    expect(archived.every((e) => e.read === true && typeof e.archivedAt === 'number')).toBe(true);
  });

  it('archiveRead sweeps legacy read:true lines even without ids', async () => {
    await writeFile(inboxPath, [entry('m1', true), entry('m2')].join('\n') + '\n');
    const moved = await archiveRead(inboxPath, archivePath, []);
    expect(moved).toBe(1);
    expect(await ids(inboxPath)).toEqual(['m2']);
    expect(await ids(archivePath)).toEqual(['m1']);
  });

  it('archiveRead empties the inbox file when nothing remains unread', async () => {
    await writeFile(inboxPath, [entry('m1'), entry('m2')].join('\n') + '\n');
    await archiveRead(inboxPath, archivePath, ['m1', 'm2']);
    expect(await readFile(inboxPath, 'utf8')).toBe('');
    expect(await readLocalInbox(inboxPath)).toEqual([]);
  });

  it('archiveRead is a no-op when nothing matches', async () => {
    await writeFile(inboxPath, entry('m1') + '\n');
    expect(await archiveRead(inboxPath, archivePath, ['nope'])).toBe(0);
    expect(await ids(inboxPath)).toEqual(['m1']);
  });

  it('archiveRead returns 0 on missing file', async () => {
    expect(await archiveRead(inboxPath, archivePath, ['m1'])).toBe(0);
  });

  function msg(id: string): Message {
    return { id, from: 'alice', to: 'bob', threadId: 't_1', content: `msg ${id}`, createdAt: 1, deliveredAt: null, ackedAt: null };
  }

  it('appendLocalInbox writes received messages as unread', async () => {
    await appendLocalInbox(inboxPath, archivePath, [msg('m1'), msg('m2')]);
    const got = await readLocalInbox(inboxPath);
    expect(got.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('appendLocalInbox is idempotent against the active inbox', async () => {
    await appendLocalInbox(inboxPath, archivePath, [msg('m1')]);
    await appendLocalInbox(inboxPath, archivePath, [msg('m1'), msg('m2')]);
    expect((await readLocalInbox(inboxPath)).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('appendLocalInbox dedups against already-archived messages', async () => {
    // m1 received, read+archived, then redelivered by a socket replay → must not reappear.
    await appendLocalInbox(inboxPath, archivePath, [msg('m1')]);
    await archiveRead(inboxPath, archivePath, ['m1']);
    await appendLocalInbox(inboxPath, archivePath, [msg('m1'), msg('m2')]);
    expect((await readLocalInbox(inboxPath)).map((m) => m.id)).toEqual(['m2']);
  });

  it('appendLocalInbox no-op on empty input', async () => {
    await appendLocalInbox(inboxPath, archivePath, []);
    expect(await readLocalInbox(inboxPath)).toEqual([]);
  });
});
