import { randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync, type Stats } from 'node:fs';
import { access, chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PatchEntry, PatchIo } from './types';

export function normalizePatchPath(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (!value) throw new Error('Patch path cannot be empty');
  if (platform === 'win32') {
    const target = value.replaceAll('/', '\\');
    const driveAbsolute = /^[A-Za-z]:\\/.test(target);
    if (driveAbsolute) return path.win32.normalize(target);
    if (path.win32.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
      throw new Error(`Patch path is not an absolute Windows path: ${value}`);
    }
    const normalized = path.win32.normalize(target);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.win32.sep}`)) {
      throw new Error(`Patch path escapes the workspace: ${value}`);
    }
    return normalized;
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\')) {
    throw new Error(`Patch path is not valid on this platform: ${value}`);
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (path.posix.isAbsolute(normalized)) return normalized;
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Patch path escapes the workspace: ${value}`);
  }
  return normalized;
}

export function createLocalApplyPatchIo(cwd: string): PatchIo {
  const requestedRoot = path.resolve(cwd);
  const root = realpathSync(cwd);
  const checkSignal = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('apply_patch cancelled');
  };

  const isWithin = (parent: string, target: string): boolean => {
    const relative = path.relative(parent, target);
    return (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const resolveTarget = (value: string) => {
    const normalized = normalizePatchPath(value);
    let target: string;
    if (!path.isAbsolute(normalized)) {
      target = path.resolve(root, normalized);
    } else if (isWithin(requestedRoot, normalized)) {
      target = path.resolve(root, path.relative(requestedRoot, normalized));
    } else {
      target = normalized;
    }
    let anchor = isWithin(root, target) ? root : path.parse(target).root;
    let relative = path.relative(anchor, target);
    // 根目录直属链接只有 root 能建（macOS /tmp、/var → private/*），按系统路径展开
    const head = relative.split(path.sep)[0];
    if (anchor !== root && head && head !== relative) {
      const top = path.join(anchor, head);
      try {
        if (lstatSync(top).isSymbolicLink()) {
          anchor = realpathSync(top);
          relative = path.relative(top, target);
        }
      } catch {
        // 不存在时照常逐级检查
      }
    }
    return {
      target,
      anchor,
      segments: relative ? relative.split(path.sep) : [],
    };
  };

  async function inspect(
    value: string,
    maxBytes = 4 * 1024 * 1024,
    signal?: AbortSignal
  ): Promise<PatchEntry> {
    checkSignal(signal);
    const resolved = resolveTarget(value);
    const { segments } = resolved;
    let current = resolved.anchor;
    if (segments.length === 0) {
      const stats = await lstat(current);
      return {
        kind: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'other',
        canonicalPath: await realpath(current),
      };
    }
    for (let index = 0; index < segments.length; index += 1) {
      checkSignal(signal);
      current = path.join(current, segments[index]);
      let stats: Stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await access(path.dirname(current), constants.W_OK | constants.X_OK);
          return { kind: 'missing', canonicalPath: resolved.target };
        }
        throw error;
      }
      if (stats.isSymbolicLink()) return { kind: 'symlink', canonicalPath: current };
      if (index < segments.length - 1 && !stats.isDirectory()) {
        return { kind: 'other', canonicalPath: current };
      }
      if (index === segments.length - 1) {
        const canonicalPath = await realpath(current);
        if (stats.isDirectory()) return { kind: 'directory', canonicalPath };
        await access(path.dirname(current), constants.W_OK | constants.X_OK);
        if (!stats.isFile()) return { kind: 'other', canonicalPath };
        if (stats.size > maxBytes) throw new Error(`File exceeds apply_patch read limit: ${value}`);
        const handle = await open(current, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(stats.size + 1, maxBytes + 1));
          let length = 0;
          while (length < buffer.length) {
            checkSignal(signal);
            const read = await handle.read(buffer, length, buffer.length - length, null);
            if (read.bytesRead === 0) break;
            length += read.bytesRead;
          }
          const after = await handle.stat();
          if (length > maxBytes) throw new Error(`File exceeds apply_patch read limit: ${value}`);
          if (after.size !== length) throw new Error(`File changed while reading: ${value}`);
          const raw = Buffer.alloc(length);
          buffer.copy(raw, 0, 0, length);
          return { kind: 'file', canonicalPath, raw };
        } finally {
          await handle.close();
        }
      }
    }
    throw new Error(`Invalid patch path: ${value}`);
  }

  async function ensureParents(value: string, signal?: AbortSignal): Promise<void> {
    const resolved = resolveTarget(value);
    const segments = resolved.segments.slice(0, -1);
    let current = resolved.anchor;
    for (const segment of segments) {
      checkSignal(signal);
      current = path.join(current, segment);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error(`Unsafe patch parent: ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        checkSignal(signal);
        await mkdir(current);
      }
    }
  }

  return {
    normalizePath: normalizePatchPath,
    inspect,
    async write(value, raw, options) {
      await ensureParents(value, options.signal);
      checkSignal(options.signal);
      const target = resolveTarget(value).target;
      if (options.exclusive) {
        const handle = await open(target, 'wx');
        try {
          await handle.writeFile(raw);
        } finally {
          await handle.close();
        }
        return;
      }
      const before = await lstat(target);
      checkSignal(options.signal);
      if (before.isSymbolicLink() || !before.isFile())
        throw new Error(`Unsafe update target: ${value}`);
      const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.enso-patch-${process.pid}-${randomUUID()}`
      );
      const handle = await open(temporary, 'wx', before.mode);
      try {
        await handle.writeFile(raw);
        await handle.close();
        await chmod(temporary, before.mode);
        checkSignal(options.signal);
        await rename(temporary, target);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
    async remove(value, signal) {
      const entry = await inspect(value, undefined, signal);
      checkSignal(signal);
      if (entry.kind !== 'file') throw new Error(`Delete target is not a regular file: ${value}`);
      await unlink(resolveTarget(value).target);
    },
  };
}
