import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareSecretaryAvatarWrite,
  readableSecretaryAvatar,
  resolveSecretaryAvatarFile,
} from './avatarFile';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('secretary avatar path', () => {
  it('only resolves the fixed file inside the secretary directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'sec-avatar-'));
    expect(resolveSecretaryAvatarFile(dir)).toEqual({
      root: dir,
      file: join(dir, 'avatar.png'),
    });
    expect(resolveSecretaryAvatarFile('')).toBeNull();
  });

  it('refuses a symlink that points outside the secretary directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'sec-avatar-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'sec-avatar-out-'));
    const outside = join(outsideDir, 'secret.png');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dir, 'avatar.png'));
    expect(readableSecretaryAvatar(dir)).toBeNull();

    const target = prepareSecretaryAvatarWrite(dir);
    expect(target).toBe(join(dir, 'avatar.png'));
    writeFileSync(target ?? '', 'inside');
    expect(readableSecretaryAvatar(dir)).toBe(realpathSync(join(dir, 'avatar.png')));
    expect(readFileSync(outside, 'utf8')).toBe('secret');
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('reads a regular file and a symlink that stays inside the directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'sec-avatar-'));
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'face.png'), 'png');
    symlinkSync(join(nested, 'face.png'), join(dir, 'avatar.png'));
    expect(readableSecretaryAvatar(dir)).toBe(realpathSync(join(nested, 'face.png')));
  });
});
