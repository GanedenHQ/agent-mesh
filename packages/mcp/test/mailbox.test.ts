import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mailbox } from '../src/mailbox';
import type { Message } from '../src/types';

let root: string;
const open: Mailbox[] = [];

function transport(
  username: string,
  extra: Partial<ConstructorParameters<typeof Mailbox>[0]> = {},
): Mailbox {
  const t = new Mailbox({ root, username, pollMs: 20, ...extra });
  open.push(t);
  return t;
}

async function waitFor<T>(get: () => T | undefined, ms = 2_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mesh-local-'));
});

afterEach(() => {
  for (const t of open.splice(0)) t.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('Mailbox', () => {
  it('delivers a message live to the recipient session, once', async () => {
    const alice = transport('alice');
    const bob = transport('bob');
    const got: Message[] = [];
    await alice.start(() => undefined);
    await bob.start((m) => got.push(m));

    const sent = await alice.send({ to: '@Bob', content: 'review my PR?' });
    const received = await waitFor(() => got[0]);

    expect(received.id).toBe(sent.id);
    expect(received.from).toBe('alice');
    expect(received.to).toBe('bob');
    expect(received.content).toBe('review my PR?');
    expect(received.deliveredAt).not.toBeNull();
    // Claimed: no longer waiting.
    expect(await bob.readInbox()).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(got).toHaveLength(1);
  });

  it('keeps messages for an offline recipient until its session starts', async () => {
    const alice = transport('alice');
    const bob = transport('bob');
    await alice.start(() => undefined);
    await bob.start(() => undefined);
    bob.stop();

    await alice.send({ to: 'bob', content: 'first' });
    await alice.send({ to: 'bob', content: 'second' });
    expect((await bob.readInbox()).map((m) => m.content)).toEqual(['first', 'second']);

    const got: Message[] = [];
    const bobAgain = transport('bob');
    await bobAgain.start((m) => got.push(m));
    expect(got.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('gives each message to exactly one of two sessions sharing an identity', async () => {
    const alice = transport('alice');
    await alice.start(() => undefined);
    const got: string[] = [];
    await transport('bob').start((m) => got.push(`a:${m.content}`));
    await transport('bob').start((m) => got.push(`b:${m.content}`));

    for (let i = 0; i < 20; i++) await alice.send({ to: 'bob', content: String(i) });
    await waitFor(() => (got.length >= 20 ? true : undefined));
    await new Promise((r) => setTimeout(r, 60));

    const contents = got.map((g) => g.slice(2)).sort((x, y) => Number(x) - Number(y));
    expect(contents).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });

  it('keeps the thread id on replies', async () => {
    const alice = transport('alice');
    const bob = transport('bob');
    await alice.start(() => undefined);
    await bob.start(() => undefined);
    const first = await alice.send({ to: 'bob', content: 'q' });
    const reply = await bob.send({ to: 'alice', content: 'a', threadId: first.threadId });
    expect(reply.threadId).toBe(first.threadId);
  });

  it('refuses an unknown recipient and names the known ones', async () => {
    const alice = transport('alice');
    await alice.start(() => undefined);
    await transport('bob').start(() => undefined);
    await expect(alice.send({ to: 'bbo', content: 'x' })).rejects.toThrow(/@bbo.*@alice, @bob/);
  });

  it('refuses usernames that could escape the mailbox directory', async () => {
    const alice = transport('alice');
    await alice.start(() => undefined);
    await expect(alice.send({ to: '../etc', content: 'x' })).rejects.toThrow(/invalid username/);
    expect(() => transport('a/b')).toThrow(/invalid username/);
  });

  it('reports presence from live sessions only', async () => {
    const alice = transport('alice');
    const bob = transport('bob');
    expect(alice.presenceObserved).toBe(false);
    await alice.start(() => undefined);
    await bob.start(() => undefined);
    expect(alice.presenceObserved).toBe(true);
    expect(alice.isOnline('bob')).toBe(true);

    bob.stop();
    expect(alice.isOnline('bob')).toBe(false);
    const team = await alice.listTeam();
    expect(team).toEqual([
      { username: 'alice', online: true },
      { username: 'bob', online: false },
    ]);
  });

  it('drops the session file of a process that died', async () => {
    const alice = transport('alice');
    await alice.start(() => undefined);
    const ghost = join(root, 'sessions', 'carol.999999.json');
    writeFileSync(
      ghost,
      JSON.stringify({
        username: 'carol',
        pid: 999_999,
        cwd: '/',
        startedAt: 0,
        heartbeatAt: Date.now(),
      }),
    );
    expect(alice.isOnline('carol')).toBe(false);
    expect(readdirSync(join(root, 'sessions'))).not.toContain('carol.999999.json');
  });

  it('acks messages read through readInbox', async () => {
    const alice = transport('alice');
    const bob = transport('bob');
    await alice.start(() => undefined);
    await bob.start(() => undefined);
    bob.stop();
    const m = await alice.send({ to: 'bob', content: 'x' });
    await bob.ack([m.id]);
    expect(await bob.readInbox()).toEqual([]);
  });
});

describe('Mailbox guardrails', () => {
  const limits = { hopLimit: 2, quotaPerMin: 100 };

  it('stops a thread that bounces between sessions too many times', async () => {
    const a = transport('alice', { limits });
    const b = transport('bob', { limits });
    // Alice's session is live and may claim at any moment: count what reaches it,
    // waiting in the mailbox or already delivered, not just what still waits.
    const deliveredToAlice: string[] = [];
    await a.start((m) => deliveredToAlice.push(m.id));
    await b.start(() => undefined);

    const m0 = await a.send({ to: 'bob', content: 'q' });
    const m1 = await b.send({ to: 'alice', content: 'r', threadId: m0.threadId });
    const m2 = await a.send({ to: 'bob', content: 'r', threadId: m0.threadId });
    expect([m0.hopCount, m1.hopCount, m2.hopCount]).toEqual([0, 1, 2]);
    await expect(b.send({ to: 'alice', content: 'r', threadId: m0.threadId })).rejects.toThrow(
      /loop guard/,
    );
    // The refused message never reached alice: only m1 did.
    await new Promise((r) => setTimeout(r, 60));
    const reached = [...deliveredToAlice, ...(await a.readInbox()).map((m) => m.id)];
    expect(reached).toEqual([m1.id]);
    // A new thread starts over.
    expect((await b.send({ to: 'alice', content: 'new' })).hopCount).toBe(0);
  });

  it('resets the count when a human writes in the thread', async () => {
    const a = transport('alice', { limits });
    const b = transport('bob', { limits });
    const me = transport('me', { limits, human: true });
    await a.start(() => undefined);
    await b.start(() => undefined);
    await me.start(() => undefined);

    const m0 = await a.send({ to: 'bob', content: 'q' });
    await b.send({ to: 'alice', content: 'r', threadId: m0.threadId });
    await a.send({ to: 'bob', content: 'r', threadId: m0.threadId });
    const human = await me.send({ to: 'bob', content: 'keep going', threadId: m0.threadId });
    expect(human.hopCount).toBe(0);
    // The contract resets on the message AFTER a human one too.
    const after = await b.send({ to: 'alice', content: 'ok', threadId: m0.threadId });
    expect(after.hopCount).toBe(0);
  });

  it('caps how many messages a session sends per minute, across threads', async () => {
    const a = transport('alice', { limits: { hopLimit: 12, quotaPerMin: 3 } });
    await a.start(() => undefined);
    await transport('bob').start(() => undefined);
    for (let i = 0; i < 3; i++) await a.send({ to: 'bob', content: String(i) });
    await expect(a.send({ to: 'bob', content: 'x' })).rejects.toThrow(/rate limit/);
  });

  it('does not apply the quota to a human', async () => {
    const me = transport('me', { limits: { hopLimit: 12, quotaPerMin: 1 }, human: true });
    await me.start(() => undefined);
    await transport('bob').start(() => undefined);
    await me.send({ to: 'bob', content: '1' });
    await me.send({ to: 'bob', content: '2' });
  });

  it('refuses a thread id that could escape the threads directory', async () => {
    const a = transport('alice');
    await a.start(() => undefined);
    await transport('bob').start(() => undefined);
    await expect(a.send({ to: 'bob', content: 'x', threadId: '../../x' })).rejects.toThrow(
      /invalid threadId/,
    );
  });
});
