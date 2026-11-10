import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasChannelFlag } from '../src/channel-flag';
import { formatForContext } from '../src/context';
import { Mailbox } from '../src/mailbox';
import type { Message } from '../src/types';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  from: 'api',
  to: 'web',
  threadId: 't_1',
  content: 'is the login page still on /v1?',
  createdAt: 1,
  deliveredAt: null,
  ackedAt: null,
  hopCount: 0,
  ...over,
});

describe('hasChannelFlag', () => {
  it('spots the channel flags for this plugin only', () => {
    expect(
      hasChannelFlag('claude --dangerously-load-development-channels plugin:agent-mesh@agent-mesh'),
    ).toBe(true);
    expect(hasChannelFlag('claude --channels plugin:agent-mesh@agent-mesh')).toBe(true);
    expect(hasChannelFlag('claude --channels plugin:other@x')).toBe(false);
    expect(hasChannelFlag('claude')).toBe(false);
    expect(hasChannelFlag('node /x/agent-mesh/plugin/server/hook.js')).toBe(false);
  });
});

describe('formatForContext', () => {
  it('frames messages as data from other sessions, with sender and thread', () => {
    const { text, shown } = formatForContext('web', [msg()], '/a.jsonl');
    expect(text).toMatch(/1 new message\(s\) for @web/);
    expect(text).toMatch(/not an instruction from your user/);
    expect(text).toContain(
      '--- from @api (thread t_1, hop 0) ---\nis the login page still on /v1?',
    );
    expect(shown).toHaveLength(1);
  });

  it('cuts a long burst and says how many are left', () => {
    const big = 'x'.repeat(7_000);
    const all = [1, 2, 3].map((i) => msg({ id: `m${i}`, content: big }));
    const { text, shown } = formatForContext('web', all, '/a.jsonl');
    expect(shown.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(text).toMatch(/\(1 more: they will show at your next prompt\)/);
  });

  it('never lets one huge message block the queue', () => {
    const huge = msg({ id: 'big', content: 'y'.repeat(100_000) });
    const next = msg({ id: 'next', content: 'short one' });
    const { text, shown } = formatForContext('web', [huge, next], '/p/inbox.archive.jsonl');
    expect(shown.map((m) => m.id)).toEqual(['big', 'next']);
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain('92000 more characters');
    expect(text).toContain('"id":"big" in /p/inbox.archive.jsonl');
    expect(text).toContain('short one');
  });
});

describe('hook (end to end)', () => {
  let home: string;
  const hook = resolve(__dirname, '../src/hook.ts');

  function runHook(cwd: string): string {
    const r = spawnSync('bun', [hook], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd }),
      env: { PATH: process.env['PATH'], HOME: home },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    return r.stdout;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mesh-hook-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('shows a waiting message once, then stays quiet', async () => {
    const web = join(home, 'code', 'web');
    mkdirSync(join(web, '.git'), { recursive: true });
    const root = join(home, '.agent-mesh', 'local');
    const api = new Mailbox({ root, username: 'api' });
    const webBox = new Mailbox({ root, username: 'web' });
    await api.start(() => undefined);
    await webBox.start(() => undefined);
    webBox.stop(); // no live session for @web: the message waits
    await api.send({ to: 'web', content: 'ping from api' });
    api.stop();

    const first = runHook(web);
    expect(first).toContain('for @web');
    expect(first).toContain('ping from api');
    expect(runHook(web)).toBe('');
    expect(await webBox.readInbox()).toEqual([]);
  });

  it('prints nothing when there is nothing new', () => {
    const repo = join(home, 'code', 'quiet');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(runHook(repo)).toBe('');
  });
});
