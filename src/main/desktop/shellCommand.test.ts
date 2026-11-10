import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkEnsoCommand } from './shellCommand';

describe('linkEnsoCommand', () => {
  let root: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'enso-cmd-'));
    source = path.join(root, 'EnsoCode.app/Contents/Resources/bin/enso');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, '#!/bin/sh\n');
    await mkdir(path.join(root, 'bin'));
    target = path.join(root, 'bin/enso');
  });

  afterEach(async () => {
    await chmod(path.join(root, 'bin'), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('links the command to the bundled script', async () => {
    await linkEnsoCommand(source, target);
    expect(await readlink(target)).toBe(source);
  });

  it('replaces a stale link and stays idempotent', async () => {
    await symlink('/Applications/Old.app/Contents/Resources/bin/enso', target);
    await linkEnsoCommand(source, target);
    await linkEnsoCommand(source, target);
    expect(await readlink(target)).toBe(source);
  });

  it('refuses to overwrite a regular file that is not ours', async () => {
    await writeFile(target, 'someone else');
    await expect(linkEnsoCommand(source, target)).rejects.toThrow(/already exists/);
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
  });

  it('reports a permission failure so the caller can elevate', async () => {
    await chmod(path.join(root, 'bin'), 0o555);
    await expect(linkEnsoCommand(source, target)).rejects.toMatchObject({ code: 'EACCES' });
  });
});
