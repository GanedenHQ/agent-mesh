import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeedTracker } from '../src/feed';
import { Mailbox } from '../src/mailbox';

let root: string;
const open: Mailbox[] = [];
const box = (username: string) => {
  const m = new Mailbox({ root, username, pollMs: 20 });
  open.push(m);
  return m;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mesh-feed-'));
});
afterEach(() => {
  for (const m of open.splice(0)) m.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('FeedTracker', () => {
  it('reports a message when sent, then when picked up, once each', async () => {
    const api = box('api');
    const web = box('web');
    await api.start(() => undefined);
    await web.start(() => undefined);
    web.stop();
    const feed = new FeedTracker(root, () => api.onlineUsers());
    expect(feed.history(10)).toEqual([]);

    const m = await api.send({ to: 'web', content: 'hello' });
    const sent = feed.poll();
    expect(sent).toEqual([{ kind: 'sent', message: expect.objectContaining({ id: m.id }) }]);

    const got: string[] = [];
    const web2 = box('web');
    await web2.start((msg) => got.push(msg.id));
    const after = feed.poll();
    expect(after).toContainEqual({ kind: 'online', username: 'web' });
    expect(after).toContainEqual(
      expect.objectContaining({
        kind: 'picked-up',
        message: expect.objectContaining({ id: m.id }),
      }),
    );
    expect(feed.poll()).toEqual([]);
  });

  it('starts from the backlog without replaying it', async () => {
    const api = box('api');
    await api.start(() => undefined);
    await box('web').start(() => undefined);
    for (const c of ['a', 'b', 'c']) await api.send({ to: 'web', content: c });
    await new Promise((r) => setTimeout(r, 80)); // web picks them up

    const feed = new FeedTracker(root, () => api.onlineUsers());
    expect(feed.history(2).map((m) => m.content)).toEqual(['b', 'c']);
    expect(feed.poll()).toEqual([]);
  });

  it('reports sessions ending', async () => {
    const api = box('api');
    const web = box('web');
    await api.start(() => undefined);
    await web.start(() => undefined);
    const feed = new FeedTracker(root, () => api.onlineUsers());
    feed.history(0);
    web.stop();
    expect(feed.poll()).toEqual([{ kind: 'offline', username: 'web' }]);
  });
});
