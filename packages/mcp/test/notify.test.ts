import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so no real notification/sound fires during tests.
const spawnMock = vi.fn((_command: string, _args: string[] = []) => ({ on: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
// Pin the platform so assertions are deterministic regardless of the test host.
vi.mock('node:os', () => ({ platform: () => 'darwin' }));

// notify.ts reads platform() at module load, so import fresh after the mocks.
async function loadNotify() {
  vi.resetModules();
  return (await import('../src/notify')).notify;
}

describe('notify()', () => {
  const prevNotify = process.env['MESH_NOTIFY'];
  const prevSound = process.env['MESH_SOUND'];

  beforeEach(() => {
    spawnMock.mockClear();
    delete process.env['MESH_NOTIFY'];
    delete process.env['MESH_SOUND'];
  });

  afterEach(() => {
    if (prevNotify === undefined) delete process.env['MESH_NOTIFY'];
    else process.env['MESH_NOTIFY'] = prevNotify;
    if (prevSound === undefined) delete process.env['MESH_SOUND'];
    else process.env['MESH_SOUND'] = prevSound;
  });

  it('fires both a notification and a sound when enabled', async () => {
    const notify = await loadNotify();
    notify('@api → @web', 'hello');
    const cmds = spawnMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('osascript'); // visual notification
    expect(cmds).toContain('afplay'); // sound
  });

  it('does nothing when MESH_NOTIFY=0', async () => {
    process.env['MESH_NOTIFY'] = '0';
    const notify = await loadNotify();
    notify('@api → @web', 'hello');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('MESH_NOTIFY=sound keeps the sound and drops the visual banner', async () => {
    // Le mode existe pour une raison précise : sur macOS la bannière passe par
    // `osascript display notification`, que le système attribue à Script Editor
    // (icône générique, clic qui ouvre Automator). Une app hôte qui possède un
    // vrai bundle fait bien mieux — mais le SON reste le signal le moins cher
    // pour une session de terminal, et il n'y a aucune raison de le perdre.
    process.env['MESH_NOTIFY'] = 'sound';
    const notify = await loadNotify();
    notify('@api → @web', 'hello');
    const cmds = spawnMock.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain('osascript');
    expect(cmds).toContain('afplay');
  });

  it('passes untrusted body/title as argv, never interpolated', async () => {
    const notify = await loadNotify();
    const evil = '"; rm -rf / #';
    notify('title', evil);
    const osascript = spawnMock.mock.calls.find((c) => c[0] === 'osascript');
    expect(osascript).toBeDefined();
    // The raw string is present verbatim as an argv element (not escaped into a script).
    expect(osascript?.[1]).toContain(evil);
  });

  it('neutralizes argv flag smuggling (leading dash) and passes -- end-of-options', async () => {
    const notify = await loadNotify();
    notify('--title-flag', '--evil-flag injected');
    const osascript = spawnMock.mock.calls.find((c) => c[0] === 'osascript');
    const args = osascript?.[1] ?? [];
    // `--` marker present, and no untrusted value is left starting with a dash.
    expect(args).toContain('--');
    const afterMarker = args.slice(args.indexOf('--') + 1);
    expect(afterMarker.every((a) => !a.startsWith('-'))).toBe(true);
    expect(afterMarker).toContain(' --evil-flag injected');
    expect(afterMarker).toContain(' --title-flag');
  });

  it('honours MESH_SOUND override', async () => {
    process.env['MESH_SOUND'] = 'Hero';
    const notify = await loadNotify();
    notify('t', 'b');
    const afplay = spawnMock.mock.calls.find((c) => c[0] === 'afplay');
    expect(afplay?.[1]?.[0]).toContain('Hero.aiff');
  });
});
