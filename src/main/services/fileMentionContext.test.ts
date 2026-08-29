import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FileMentionIo,
  MAX_FILE_MENTION_BYTES,
  readFileMentionSnapshot,
  resolveFileMentionSnapshots,
} from './fileMentionContext';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'enso-file-mention-'));
  roots.push(root);
  return root;
}

function mention(relativePath: string) {
  return { kind: 'file' as const, id: relativePath, label: relativePath, relativePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fileMentionContext', () => {
  it('reads one immutable UTF-8 snapshot inside cwd', () => {
    const root = tempRoot();
    writeFileSync(path.join(root, 'note.txt'), 'hello');

    const snapshot = readFileMentionSnapshot(root, mention('note.txt'));

    expect(snapshot.content).toBe('hello');
    expect(snapshot.absolutePath).toBe(realpathSync(path.join(root, 'note.txt')));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(resolveFileMentionSnapshots(root, [mention('note.txt')]))).toBe(true);
  });

  it('rejects traversal and symlinks resolving outside cwd', () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));

    expect(() => readFileMentionSnapshot(root, mention('../secret.txt'))).toThrow(/escapes/);
    expect(() => readFileMentionSnapshot(root, mention('escape.txt'))).toThrow(/outside/);
  });

  it('rejects oversized and binary files', () => {
    const root = tempRoot();
    writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(MAX_FILE_MENTION_BYTES + 1, 0x61));
    writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0x61, 0, 0x62]));

    expect(() => readFileMentionSnapshot(root, mention('large.txt'))).toThrow(/size limit/);
    expect(() => readFileMentionSnapshot(root, mention('binary.dat'))).toThrow(/binary/);
  });

  it('rejects a file changed after open and before the snapshot completes', () => {
    const root = tempRoot();
    const target = path.join(root, 'race.txt');
    writeFileSync(target, 'before');
    let fstatCalls = 0;
    const io: FileMentionIo = {
      realpath: realpathSync,
      open: openSync,
      fstat(fd) {
        const current = fstatSync(fd);
        fstatCalls += 1;
        if (fstatCalls === 1) return current;
        return {
          ...current,
          size: current.size + 1,
          isFile: () => true,
        } as unknown as Stats;
      },
      stat: statSync,
      read: (fd) => readFileSync(fd),
      close: closeSync,
    };

    expect(() => readFileMentionSnapshot(root, mention('race.txt'), io)).toThrow(/changed/);
  });
});
