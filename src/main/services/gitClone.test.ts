import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn }));

import { gitClone } from './gitClone';

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

class FakeGit extends EventEmitter {
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

describe('gitClone', () => {
  let parentDir: string;

  beforeEach(() => {
    parentDir = mkdtempSync(path.join(tmpdir(), 'git-clone-'));
    spawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(parentDir, { recursive: true, force: true });
  });

  function arm(): FakeGit {
    const child = new FakeGit();
    spawn.mockImplementation(() => child);
    return child;
  }

  it.each([
    ['https://github.com/acme/widget.git', 'https://github.com/acme/widget.git', 'widget'],
    ['https://github.com/acme/widget.git/', 'https://github.com/acme/widget.git/', 'widget'],
    ['https://github.com/acme/widget', 'https://github.com/acme/widget', 'widget'],
    ['http://example.com/group/tool.git', 'http://example.com/group/tool.git', 'tool'],
    ['git://github.com/acme/widget.git', 'git://github.com/acme/widget.git', 'widget'],
    ['ssh://git@github.com/acme/widget.git', 'ssh://git@github.com/acme/widget.git', 'widget'],
    ['git@github.com:acme/widget.git', 'git@github.com:acme/widget.git', 'widget'],
    ['acme/widget', 'https://github.com/acme/widget.git', 'widget'],
    ['acme/widget.git', 'https://github.com/acme/widget.git', 'widget'],
    ['  acme/widget  ', 'https://github.com/acme/widget.git', 'widget'],
  ])('clones %j as %s into %s', async (url, cloneUrl, name) => {
    const child = arm();
    const pending = gitClone({ url, parentDir });
    const target = path.join(parentDir, name);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as [string, string[], { shell?: unknown }];
    expect(command).toBe('git');
    expect(args).toEqual(['clone', cloneUrl, target]);
    expect(options.shell).toBeFalsy();
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, path: target });
  });

  it('uses an explicit folder name instead of the url leaf', async () => {
    const child = arm();
    const pending = gitClone({ url: 'acme/widget.git', parentDir, name: '  custom  ' });
    const target = path.join(parentDir, 'custom');
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      'clone',
      'https://github.com/acme/widget.git',
      target,
    ]);
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ ok: true, path: target });
  });

  it('refuses urls that are not a remote and never spawns git', async () => {
    for (const url of [
      '',
      '   ',
      'file:///tmp/repo.git',
      'FILE:///tmp/repo.git',
      '/tmp/repo.git',
      './repo',
      '../repo',
      '~/repo',
      '-upload-pack=touch',
      '--bare',
      'not a url',
      'only-one-segment',
      'a/b/c',
      'http://',
    ]) {
      spawn.mockClear();
      const result = await gitClone({ url, parentDir });
      expect(result.ok).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it('treats a blank name as omitted', async () => {
    const child = arm();
    const pending = gitClone({ url: 'acme/widget', parentDir, name: '   ' });
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({
      ok: true,
      path: path.join(parentDir, 'widget'),
    });
  });

  it('refuses folder names that escape the parent or look like flags', async () => {
    for (const name of ['.', '..', 'a/b', 'a\\b', '-flag', '../x']) {
      spawn.mockClear();
      const result = await gitClone({ url: 'acme/widget', parentDir, name });
      expect(result).toMatchObject({ ok: false });
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing parent, a file parent, and a relative parent', async () => {
    const file = path.join(parentDir, 'file.txt');
    writeFileSync(file, '');
    expect(
      await gitClone({ url: 'acme/widget', parentDir: path.join(parentDir, 'missing') })
    ).toMatchObject({
      ok: false,
    });
    expect(await gitClone({ url: 'acme/widget', parentDir: file })).toMatchObject({ ok: false });
    expect(await gitClone({ url: 'acme/widget', parentDir: 'relative' })).toEqual({
      ok: false,
      error: 'Invalid request.',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('expands ~ and ~/... in the parent directory', async () => {
    const child = arm();
    const home = process.env.HOME;
    expect(home).toBeTruthy();
    const pending = gitClone({ url: 'acme/widget', parentDir: '~' });
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({
      ok: true,
      path: path.join(home as string, 'widget'),
    });
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['clone', 'https://github.com/acme/widget.git', path.join(home as string, 'widget')],
      expect.anything()
    );
  });

  it('refuses when the target already exists', async () => {
    mkdirSync(path.join(parentDir, 'widget'));
    const result = await gitClone({ url: 'acme/widget', parentDir });
    expect(result).toEqual({
      ok: false,
      error: 'A file or folder with that name already exists.',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns the tail of stderr when clone fails', async () => {
    const child = arm();
    const pending = gitClone({ url: 'acme/widget', parentDir });
    child.stderr.emit('data', `${'x'.repeat(80)}\n`.repeat(20));
    child.stderr.emit('data', 'fatal: repository not found\n');
    child.emit('close', 128);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('fatal: repository not found');
      expect(result.error.length).toBeLessThanOrEqual(500);
    }
  });

  it('returns a fallback when git exits without stderr', async () => {
    const child = arm();
    const pending = gitClone({ url: 'acme/widget', parentDir });
    child.emit('close', 1);
    await expect(pending).resolves.toEqual({ ok: false, error: 'git clone failed.' });
  });

  it('returns the spawn error when git cannot be started', async () => {
    const child = arm();
    const pending = gitClone({ url: 'acme/widget', parentDir });
    child.emit('error', new Error('spawn git ENOENT'));
    await expect(pending).resolves.toEqual({ ok: false, error: 'spawn git ENOENT' });
  });

  it('kills the clone after five minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = arm();
    const pending = gitClone({ url: 'acme/widget', parentDir });
    await vi.advanceTimersByTimeAsync(CLONE_TIMEOUT_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it('rejects a malformed request', async () => {
    for (const request of [null, { url: 'acme/widget' }, { url: 1, parentDir }, ['acme/widget']]) {
      const result = await gitClone(request);
      expect(result).toEqual({ ok: false, error: 'Invalid request.' });
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
