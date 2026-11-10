import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultUsername, projectDir, resolveUsername, writeName } from '../src/config';

let base: string;
let localDir: string;
let namesPath: string;

function repo(...parts: string[]): string {
  const dir = join(base, ...parts);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

const resolveIn = (cwd: string, dryRun = false) =>
  resolveUsername({ cwd, localDir, namesPath, dryRun });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mesh-config-'));
  localDir = join(base, 'local');
  namesPath = join(base, 'names.json');
  delete process.env['MESH_USERNAME'];
  delete process.env['MESH_PROFILE'];
});

afterEach(() => {
  delete process.env['MESH_USERNAME'];
  rmSync(base, { recursive: true, force: true });
});

describe('resolveUsername', () => {
  it('names a session after its repo, from any subdirectory', () => {
    const api = repo('code', 'api');
    mkdirSync(join(api, 'src', 'routes'), { recursive: true });
    expect(resolveIn(join(api, 'src', 'routes'))).toBe('api');
    expect(projectDir(join(api, 'src'))).toBe(realpathSync(api));
  });

  it('keeps the name for the same repo across restarts', () => {
    const api = repo('code', 'api');
    expect(resolveIn(api)).toBe('api');
    expect(resolveIn(api)).toBe('api');
  });

  it('gives a second repo with the same directory name its own name', () => {
    expect(resolveIn(repo('code', 'app'))).toBe('app');
    expect(resolveIn(repo('other', 'app'))).toBe('app-2');
    expect(resolveIn(repo('third', 'app'))).toBe('app-3');
  });

  it('ignores a .agent-mesh file committed in a repo', () => {
    expect(resolveIn(repo('code', 'api'))).toBe('api');
    const cloned = repo('downloads', 'innocent');
    writeFileSync(join(cloned, '.agent-mesh'), 'api\n');
    expect(resolveIn(cloned)).toBe('innocent');
  });

  it('uses the name the user chose for a project', () => {
    const web = repo('code', 'web');
    writeName(web, 'front', namesPath);
    expect(resolveIn(web)).toBe('front');
  });

  it('lets a chosen name take a name over, and moves the old owner aside', () => {
    const api = repo('code', 'api');
    expect(resolveIn(api)).toBe('api');
    const v2 = repo('code', 'api-v2');
    writeName(v2, 'api', namesPath);
    expect(resolveIn(v2)).toBe('api');
    expect(resolveIn(api)).toBe('api-2');
  });

  it('gives MESH_USERNAME the last word', () => {
    process.env['MESH_USERNAME'] = 'Reviewer';
    expect(resolveIn(repo('code', 'api'))).toBe('reviewer');
  });

  it('refuses a chosen name that is not a safe file name', () => {
    process.env['MESH_USERNAME'] = '../escape';
    expect(() => resolveIn(repo('code', 'api'))).toThrow(/invalid username/);
  });

  it('records nothing in dry-run mode', () => {
    expect(resolveIn(repo('code', 'app'), true)).toBe('app');
    expect(resolveIn(repo('other', 'app'), true)).toBe('app');
  });
});

describe('defaultUsername', () => {
  it('turns a directory into a username', () => {
    expect(defaultUsername('/home/me/code/My API')).toBe('my-api');
    expect(defaultUsername('/home/me/agent-mesh')).toBe('agent-mesh');
    expect(defaultUsername('/')).toBe('claude');
  });
});

describe('projectDir', () => {
  it('gives the same directory through a symlink', async () => {
    const { symlinkSync } = await import('node:fs');
    const real = repo('code', 'linked');
    const link = join(base, 'shortcut');
    symlinkSync(real, link);
    expect(projectDir(link)).toBe(projectDir(real));
    expect(resolveIn(link)).toBe(resolveIn(real));
  });
});
