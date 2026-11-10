import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkEnsoCommand, readShellIntegrationStatusSync, unlinkEnsoCommand } from './shellCommand';

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

describe('readShellIntegrationStatusSync', () => {
  let root: string;
  let source: string;
  let command: string;
  let workflow: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'enso-status-'));
    source = path.join(root, 'enso');
    command = path.join(root, 'bin', 'enso');
    workflow = path.join(root, 'Open with EnsoCode.workflow');
    await writeFile(source, '#!/bin/sh\n');
    await mkdir(path.dirname(command));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const status = () =>
    readShellIntegrationStatusSync({ ensoCommand: command, finderQuickAction: workflow });

  it('is installed only when enso is a symlink and the workflow path exists', async () => {
    expect(status()).toEqual({ ensoCommand: false, finderQuickAction: false });
    await writeFile(command, 'plain file');
    await mkdir(workflow);
    expect(status()).toEqual({ ensoCommand: false, finderQuickAction: true });
    await rm(command);
    await symlink(source, command);
    expect(status()).toEqual({ ensoCommand: true, finderQuickAction: true });
  });
});

describe('unlinkEnsoCommand', () => {
  let root: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'enso-unlink-'));
    source = path.join(root, 'enso');
    await writeFile(source, '#!/bin/sh\n');
    await mkdir(path.join(root, 'bin'));
    target = path.join(root, 'bin/enso');
  });

  afterEach(async () => {
    await chmod(path.join(root, 'bin'), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('removes a symlink and does nothing when it is already gone', async () => {
    await symlink(source, target);
    await unlinkEnsoCommand(target);
    await unlinkEnsoCommand(target);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to delete a regular file that is not ours', async () => {
    await writeFile(target, 'someone else');
    await expect(unlinkEnsoCommand(target)).rejects.toThrow(/already exists/);
    expect((await lstat(target)).isFile()).toBe(true);
  });

  it('reports a permission failure so the caller can elevate', async () => {
    await symlink(source, target);
    await chmod(path.join(root, 'bin'), 0o555);
    await expect(unlinkEnsoCommand(target)).rejects.toMatchObject({
      code: 'EACCES',
      ensoCommandLink: true,
    });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });
});
