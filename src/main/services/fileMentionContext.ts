import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { FileMentionCandidate } from '@shared/types';

export const MAX_FILE_MENTION_BYTES = 256 * 1024;
export const MAX_FILE_MENTION_TOTAL_BYTES = 512 * 1024;

export interface FileMentionSnapshot {
  readonly id: string;
  readonly label: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly content: string;
}

export interface FileMentionIo {
  realpath(target: string): string;
  open(target: string, flags: number): number;
  fstat(fd: number): Stats;
  stat(target: string): Stats;
  read(fd: number): Buffer;
  close(fd: number): void;
}

const defaultIo: FileMentionIo = {
  realpath: realpathSync,
  open: openSync,
  fstat: fstatSync,
  stat: statSync,
  read: (fd) => readFileSync(fd),
  close: closeSync,
};

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left: Stats, right: Stats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function decodeText(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error('File mention is binary');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('File mention is not valid UTF-8 text');
  }
  for (const byte of buffer) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      throw new Error('File mention contains binary control characters');
    }
  }
  return content;
}

export function readFileMentionSnapshot(
  cwd: string,
  mention: FileMentionCandidate,
  io: FileMentionIo = defaultIo
): FileMentionSnapshot {
  const relativePath = mention.relativePath.replace(/#L\d+(?:-L\d+)?$/, '');
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('File mention path must be relative');
  }

  const root = io.realpath(cwd);
  const requested = path.resolve(root, relativePath);
  if (!isContained(root, requested)) throw new Error('File mention escapes the project root');

  const resolved = io.realpath(requested);
  if (!isContained(root, resolved))
    throw new Error('File mention resolves outside the project root');

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = io.open(resolved, constants.O_RDONLY | noFollow);
  try {
    const before = io.fstat(fd);
    if (!before.isFile()) throw new Error('File mention is not a regular file');
    if (before.size > MAX_FILE_MENTION_BYTES)
      throw new Error('File mention exceeds the size limit');

    const current = io.stat(resolved);
    if (!sameFile(before, current)) throw new Error('File mention changed while opening');

    const buffer = io.read(fd);
    const after = io.fstat(fd);
    if (!unchanged(before, after) || buffer.byteLength !== before.size) {
      throw new Error('File mention changed while reading');
    }

    return Object.freeze({
      id: mention.id,
      label: mention.label,
      relativePath: mention.relativePath,
      absolutePath: resolved,
      size: before.size,
      mtimeMs: before.mtimeMs,
      content: decodeText(buffer),
    });
  } finally {
    io.close(fd);
  }
}

export function resolveFileMentionSnapshots(
  cwd: string,
  mentions: readonly FileMentionCandidate[]
): readonly FileMentionSnapshot[] {
  const snapshots: FileMentionSnapshot[] = [];
  let totalBytes = 0;
  for (const mention of mentions) {
    const snapshot = readFileMentionSnapshot(cwd, mention);
    totalBytes += snapshot.size;
    if (totalBytes > MAX_FILE_MENTION_TOTAL_BYTES) {
      throw new Error('File mention context exceeds the total size limit');
    }
    snapshots.push(snapshot);
  }
  return Object.freeze(snapshots);
}
