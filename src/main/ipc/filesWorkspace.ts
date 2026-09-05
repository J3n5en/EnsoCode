import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sniffImageMime } from '@shared/imageSniff';
import { PREVIEW_IMAGE_MAX_BYTES, previewImageMime } from '@shared/markdownPreviewImage';
import { resolveSshTarget } from '@shared/ssh';
import type {
  FilesAbsResult,
  FilesFetchRemoteImageResult,
  FilesListResult,
  FilesMutateResult,
  FilesReadImageResult,
  FilesReadRelResult,
  FilesWatchEvent,
  FilesWatchResult,
  FilesWriteResult,
} from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { app, clipboard, type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import { createSshExecutor } from '../../agent/ssh/executor';
import { resolveLocalCwdForBrowser } from '../services/browserFileRoot';
import {
  assertEntryName,
  createLocalDir,
  createLocalFile,
  EDITOR_MAX_BYTES,
  IGNORED_DIR_NAMES,
  joinUnderCwd,
  listLocalDir,
  RefCountWatchers,
  readLocalFile,
  readLocalImage,
  removeLocal,
  renameLocal,
  resolveLocalUnderCwd,
  watchLocalFile,
  writeLocalFile,
} from '../services/filesWorkspace';
import { writeFileToClipboard } from '../services/filesWorkspaceClipboard';
import { fetchRemoteImageDataUrl, REMOTE_IMAGE_MAX_BYTES } from '../services/remoteImageFetch';
import { getSshConnectionStore } from '../services/sshConnectionStore';
import { getSourceAuthorityRegistry } from './agent';

const watches = new RefCountWatchers();
const hookedSenders = new Set<number>();
const sshPollHashes = new Map<string, string>();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseRequest(
  request: unknown
): { conversationId: string; projectId: string; rel: string } | null {
  if (!request || typeof request !== 'object') return null;
  const conversationId = (request as { conversationId?: unknown }).conversationId;
  const projectId = (request as { projectId?: unknown }).projectId;
  const rel = (request as { rel?: unknown }).rel;
  if (!isNonEmptyString(conversationId) || !isNonEmptyString(projectId)) return null;
  if (rel !== undefined && typeof rel !== 'string') return null;
  const registry = getSourceAuthorityRegistry();
  const conversation = registry?.conversation(conversationId);
  if (
    !conversation ||
    conversation.lifecycle === 'ended' ||
    conversation.projectId !== projectId ||
    registry?.project(projectId)?.state !== 'active'
  )
    return null;
  return { conversationId, projectId, rel: typeof rel === 'string' ? rel : '' };
}

function requestName(request: unknown): string | null {
  if (!request || typeof request !== 'object') return null;
  const name = (request as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function requestUrl(request: unknown): string | null {
  if (!request || typeof request !== 'object') return null;
  const url = (request as { url?: unknown }).url;
  return typeof url === 'string' ? url : null;
}

function posixJoin(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function runCommand(command: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}`));
    });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function resolveLocalCwd(conversationId: string, projectId: string): string | null {
  const project = getSourceAuthorityRegistry()?.project(projectId);
  if (project?.kind === 'ssh') return null;
  return resolveLocalCwdForBrowser(conversationId);
}

function sshControlDir(): string {
  return path.join(app.getPath('userData'), 'agent', 'pi-agent', 'ssh');
}

function createProjectSsh(projectId: string) {
  const project = getSourceAuthorityRegistry()?.project(projectId);
  if (project?.kind !== 'ssh' || project.state !== 'active') return null;
  const secret = project.sshConnectionId
    ? getSshConnectionStore().getSecret(project.sshConnectionId)
    : undefined;
  const host = secret
    ? resolveSshTarget(secret)
    : project.sshHost
      ? resolveSshTarget({ host: project.sshHost })
      : undefined;
  if (!host) return null;
  const controlDir = sshControlDir();
  const executor = createSshExecutor(host, controlDir, undefined, {
    auth: secret?.auth ?? 'key',
    ...(secret?.port ? { port: secret.port } : {}),
    ...(secret?.password ? { password: secret.password } : {}),
  });
  return { executor, cwd: project.canonicalPath };
}

async function resolveRemoteUnderCwd(
  ssh: NonNullable<ReturnType<typeof createProjectSsh>>,
  rel: string
): Promise<string | null> {
  if (
    rel.includes('\\') ||
    rel.includes('\0') ||
    path.win32.isAbsolute(rel) ||
    path.posix.isAbsolute(rel)
  )
    return null;
  const root = path.posix.resolve(ssh.cwd);
  const abs = path.posix.resolve(root, rel);
  const relative = path.posix.relative(root, abs);
  if (relative === '..' || relative.startsWith('../')) return null;
  const result = await ssh.executor.exec(
    [
      'bash',
      '-c',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash parameter expansion.
      'root=$(realpath -- "$1") || exit 1; target=$2; while [ ! -e "$target" ] && [ ! -L "$target" ]; do target=$(dirname -- "$target"); done; target=$(realpath -- "$target") || exit 1; case "$target" in "$root"|"${root%/}/"*) exit 0;; *) exit 1;; esac',
      'enso',
      root,
      abs,
    ],
    { timeoutMs: 15_000 }
  );
  return result.code === 0 ? abs : null;
}

function hookDestroyed(event: IpcMainInvokeEvent): void {
  const id = event.sender.id;
  if (hookedSenders.has(id)) return;
  hookedSenders.add(id);
  event.sender.once('destroyed', () => {
    hookedSenders.delete(id);
    const prefix = `${id}:`;
    watches.releaseAll((key) => key.startsWith(prefix));
  });
}

function watchKey(senderId: number, conversationId: string, rel: string): string {
  return `${senderId}:${conversationId}:${rel}`;
}

export function registerFilesWorkspaceHandlers(): void {
  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>
  ) => {
    ipcMain.handle(channel, async (event, request: unknown) => {
      try {
        return await handler(event, request);
      } catch {
        return { ok: false, error: 'unavailable' };
      }
    });
  };
  handle(
    IPC_CHANNELS.FILES_LIST_DIR,
    async (_event, request: unknown): Promise<FilesListResult> => {
      const parsed = parseRequest(request);
      if (!parsed) return { ok: false, error: 'unavailable' };
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = await resolveRemoteUnderCwd(ssh, parsed.rel);
        if (!abs) return { ok: false, error: 'invalid-path' };
        const listed = await ssh.executor.exec(['ls', '-1Ap'], { cwd: abs, timeoutMs: 15_000 });
        if (listed.code !== 0) return { ok: false, error: 'unavailable' };
        const entries = listed.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((name) => name && name !== './' && name !== '../')
          .flatMap((name) => {
            const dir = name.endsWith('/');
            const base = dir ? name.slice(0, -1) : name;
            if (!base || base.startsWith('.')) return [];
            if (dir && IGNORED_DIR_NAMES.has(base)) return [];
            return [{ name: base, kind: dir ? ('dir' as const) : ('file' as const) }];
          });
        return { ok: true, entries };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveLocalUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      return { ok: true, entries: listLocalDir(abs) };
    }
  );

  handle(
    IPC_CHANNELS.FILES_READ_REL,
    async (_event, request: unknown): Promise<FilesReadRelResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = await resolveRemoteUnderCwd(ssh, parsed.rel);
        if (!abs) return { ok: false, error: 'invalid-path' };
        const sized = await ssh.executor.exec(['wc', '-c', '--', abs], { timeoutMs: 10_000 });
        const bytes = Number.parseInt(sized.stdout.trim().split(/\s+/)[0] ?? '', 10);
        if (Number.isFinite(bytes) && bytes > EDITOR_MAX_BYTES)
          return { ok: false, error: 'too-large' };
        const result = await ssh.executor.exec(['cat', '--', abs], { timeoutMs: 20_000 });
        if (result.code !== 0) return { ok: false, error: 'unavailable' };
        if (result.stdout.includes('\0')) return { ok: false, error: 'binary' };
        return { ok: true, content: result.stdout };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveLocalUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      return readLocalFile(abs);
    }
  );

  handle(
    IPC_CHANNELS.FILES_READ_IMAGE,
    async (_event, request: unknown): Promise<FilesReadImageResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      const mime = previewImageMime(parsed.rel);
      if (!mime) return { ok: false, error: 'unsupported' };
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = await resolveRemoteUnderCwd(ssh, parsed.rel);
        if (!abs) return { ok: false, error: 'invalid-path' };
        const sized = await ssh.executor.exec(['wc', '-c', '--', abs], { timeoutMs: 10_000 });
        const bytes = Number.parseInt(sized.stdout.trim().split(/\s+/)[0] ?? '', 10);
        if (Number.isFinite(bytes) && bytes > PREVIEW_IMAGE_MAX_BYTES)
          return { ok: false, error: 'too-large' };
        // 跌平另一头 base64 实现差异（BSD 版不支持位置参数带 `--`）：统一走 stdin
        const result = await ssh.executor.exec(['bash', '-c', 'base64 < "$1"', 'enso', abs], {
          timeoutMs: 20_000,
        });
        if (result.code !== 0) return { ok: false, error: 'unavailable' };
        const b64 = result.stdout.replace(/\s+/g, '');
        // 与本地读图同样不信任扩展名：内容魔数必须匹配声明的 mime
        if (sniffImageMime(Buffer.from(b64, 'base64')) !== mime)
          return { ok: false, error: 'unsupported' };
        return { ok: true, dataUrl: `data:${mime};base64,${b64}` };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveLocalUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      return readLocalImage(abs, mime);
    }
  );

  handle(
    IPC_CHANNELS.FILES_FETCH_REMOTE_IMAGE,
    async (_event, request: unknown): Promise<FilesFetchRemoteImageResult> => {
      // 只需要会话/项目处于活动状态作为闸门（与其他 files:* 通道一致），rel 字段不适用于远程 URL、保持缺省
      const parsed = parseRequest(request);
      if (!parsed) return { ok: false, error: 'unavailable' };
      const url = requestUrl(request);
      if (!url) return { ok: false, error: 'unavailable' };
      return fetchRemoteImageDataUrl(url, { maxBytes: REMOTE_IMAGE_MAX_BYTES });
    }
  );

  handle(IPC_CHANNELS.FILES_WRITE, async (_event, request: unknown): Promise<FilesWriteResult> => {
    const parsed = parseRequest(request);
    const content =
      request && typeof request === 'object'
        ? (request as { content?: unknown }).content
        : undefined;
    if (!parsed?.rel || typeof content !== 'string') return { ok: false, error: 'unavailable' };
    const ssh = createProjectSsh(parsed.projectId);
    if (ssh) {
      const abs = await resolveRemoteUnderCwd(ssh, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      const result = await ssh.executor.exec(['tee', '--', abs], {
        stdin: content,
        timeoutMs: 20_000,
      });
      if (result.code !== 0) return { ok: false, error: 'unavailable' };
      return { ok: true };
    }
    const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
    if (!cwd) return { ok: false, error: 'unavailable' };
    const abs = resolveLocalUnderCwd(cwd, parsed.rel);
    if (!abs) return { ok: false, error: 'invalid-path' };
    if (!writeLocalFile(abs, content)) return { ok: false, error: 'unavailable' };
    return { ok: true };
  });

  handle(
    IPC_CHANNELS.FILES_WATCH_START,
    async (event, request: unknown): Promise<FilesWatchResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      hookDestroyed(event);
      const key = watchKey(event.sender.id, parsed.conversationId, parsed.rel);
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = await resolveRemoteUnderCwd(ssh, parsed.rel);
        if (!abs) return { ok: false, error: 'invalid-path' };
        watches.acquire(key, () => {
          let timer: ReturnType<typeof setInterval> | undefined;
          const tick = async () => {
            const result = await ssh.executor.exec(['cksum', '--', abs], { timeoutMs: 10_000 });
            if (result.code !== 0) return;
            const prev = sshPollHashes.get(key);
            if (prev === result.stdout) return;
            sshPollHashes.set(key, result.stdout);
            if (prev === undefined) return;
            if (event.sender.isDestroyed()) return;
            const payload: FilesWatchEvent = {
              conversationId: parsed.conversationId,
              rel: parsed.rel,
              type: 'change',
            };
            event.sender.send(IPC_CHANNELS.FILES_WATCH_EVENT, payload);
          };
          void tick();
          timer = setInterval(() => void tick(), 2000);
          return () => {
            if (timer) clearInterval(timer);
            sshPollHashes.delete(key);
          };
        });
        return { ok: true };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveLocalUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      watches.acquire(key, () =>
        watchLocalFile(abs, () => {
          if (event.sender.isDestroyed()) return;
          const payload: FilesWatchEvent = {
            conversationId: parsed.conversationId,
            rel: parsed.rel,
            type: 'change',
          };
          event.sender.send(IPC_CHANNELS.FILES_WATCH_EVENT, payload);
        })
      );
      return { ok: true };
    }
  );

  handle(
    IPC_CHANNELS.FILES_WATCH_STOP,
    async (event, request: unknown): Promise<FilesWatchResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      watches.release(watchKey(event.sender.id, parsed.conversationId, parsed.rel));
      return { ok: true };
    }
  );

  const mutate = async (request: unknown, kind: 'file' | 'dir'): Promise<FilesMutateResult> => {
    const parsed = parseRequest(request);
    const name = requestName(request);
    if (!parsed || !name) return { ok: false, error: 'unavailable' };
    if (!assertEntryName(name)) return { ok: false, error: 'invalid-name' };
    const childRel = posixJoin(parsed.rel, name);
    const ssh = createProjectSsh(parsed.projectId);
    if (ssh) {
      const abs = await resolveRemoteUnderCwd(ssh, childRel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      const cmd =
        kind === 'dir'
          ? (['mkdir', '--', abs] as string[])
          : ([
              'bash',
              '-c',
              `if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi; set -C; : > "$1"`,
              'enso',
              abs,
            ] as string[]);
      const result = await ssh.executor.exec(cmd, { timeoutMs: 15_000 });
      if (result.code !== 0) {
        const text = `${result.stderr} ${result.stdout}`;
        if (result.code === 17 || /exists|File exists/i.test(text))
          return { ok: false, error: 'exists' };
        return { ok: false, error: 'unavailable' };
      }
      return { ok: true, rel: childRel };
    }
    const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
    if (!cwd) return { ok: false, error: 'unavailable' };
    const abs = joinUnderCwd(cwd, parsed.rel, name);
    if (!abs) return { ok: false, error: 'invalid-path' };
    const error = kind === 'dir' ? createLocalDir(abs) : createLocalFile(abs);
    if (error) return { ok: false, error };
    return { ok: true, rel: childRel };
  };

  handle(IPC_CHANNELS.FILES_MKDIR, (_event, request: unknown) => mutate(request, 'dir'));
  handle(IPC_CHANNELS.FILES_CREATE, (_event, request: unknown) => mutate(request, 'file'));

  handle(
    IPC_CHANNELS.FILES_RENAME,
    async (_event, request: unknown): Promise<FilesMutateResult> => {
      const parsed = parseRequest(request);
      const name = requestName(request);
      if (!parsed?.rel || !name) return { ok: false, error: 'unavailable' };
      if (!assertEntryName(name)) return { ok: false, error: 'invalid-name' };
      if (path.posix.normalize(parsed.rel).replace(/\/$/, '') === '.')
        return { ok: false, error: 'invalid-path' };
      const parent = parsed.rel.includes('/')
        ? parsed.rel.slice(0, parsed.rel.lastIndexOf('/'))
        : '';
      const toRel = posixJoin(parent, name);
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const fromAbs = await resolveRemoteUnderCwd(ssh, parsed.rel);
        const toAbs = await resolveRemoteUnderCwd(ssh, toRel);
        if (!fromAbs || !toAbs) return { ok: false, error: 'invalid-path' };
        const result = await ssh.executor.exec(
          [
            'bash',
            '-c',
            'if [ -e "$2" ] || [ -L "$2" ]; then exit 17; fi; case "$(uname -s)" in Darwin) mv -nh -- "$1" "$2";; *) mv -nT -- "$1" "$2";; esac || exit 1; if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi',
            'enso',
            fromAbs,
            toAbs,
          ],
          {
            timeoutMs: 15_000,
          }
        );
        if (result.code === 17) return { ok: false, error: 'exists' };
        if (result.code !== 0) return { ok: false, error: 'unavailable' };
        return { ok: true, rel: toRel };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const fromAbs = resolveLocalUnderCwd(cwd, parsed.rel);
      const toAbs = resolveLocalUnderCwd(cwd, toRel);
      if (!fromAbs || !toAbs) return { ok: false, error: 'invalid-path' };
      const error = renameLocal(fromAbs, toAbs);
      if (error) return { ok: false, error };
      return { ok: true, rel: toRel };
    }
  );

  handle(
    IPC_CHANNELS.FILES_REMOVE,
    async (_event, request: unknown): Promise<FilesMutateResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      const ssh = createProjectSsh(parsed.projectId);
      if (ssh) {
        const abs = await resolveRemoteUnderCwd(ssh, parsed.rel);
        if (!abs || abs === path.posix.resolve(ssh.cwd))
          return { ok: false, error: 'invalid-path' };
        const result = await ssh.executor.exec(['rm', '-rf', '--', abs], { timeoutMs: 20_000 });
        if (result.code !== 0) return { ok: false, error: 'unavailable' };
        return { ok: true, rel: parsed.rel };
      }
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveLocalUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      const error = removeLocal(abs, cwd);
      if (error) return { ok: false, error };
      return { ok: true, rel: parsed.rel };
    }
  );

  handle(IPC_CHANNELS.FILES_ABS, async (_event, request: unknown): Promise<FilesAbsResult> => {
    const parsed = parseRequest(request);
    if (!parsed) return { ok: false, error: 'unavailable' };
    const ssh = createProjectSsh(parsed.projectId);
    if (ssh) {
      const abs = await resolveRemoteUnderCwd(ssh, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      return { ok: true, abs, local: false };
    }
    const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
    if (!cwd) return { ok: false, error: 'unavailable' };
    const abs = resolveLocalUnderCwd(cwd, parsed.rel);
    if (!abs) return { ok: false, error: 'invalid-path' };
    return { ok: true, abs, fileUrl: pathToFileURL(abs).href, local: true };
  });

  handle(
    IPC_CHANNELS.FILES_COPY_PATH,
    async (_event, request: unknown): Promise<FilesMutateResult> => {
      const parsed = parseRequest(request);
      const mode =
        request && typeof request === 'object' ? (request as { mode?: unknown }).mode : undefined;
      if (!parsed) return { ok: false, error: 'unavailable' };
      const ssh = createProjectSsh(parsed.projectId);
      const cwd = ssh?.cwd ?? resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = ssh
        ? await resolveRemoteUnderCwd(ssh, parsed.rel)
        : resolveLocalUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      try {
        clipboard.writeText(mode === 'relative' ? parsed.rel : abs);
        return { ok: true };
      } catch {
        return { ok: false, error: 'unavailable' };
      }
    }
  );

  handle(
    IPC_CHANNELS.FILES_COPY_FILE,
    async (_event, request: unknown): Promise<FilesMutateResult> => {
      const parsed = parseRequest(request);
      if (!parsed?.rel) return { ok: false, error: 'unavailable' };
      if (createProjectSsh(parsed.projectId)) return { ok: false, error: 'unsupported' };
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveLocalUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      try {
        if (!statSync(abs).isFile()) return { ok: false, error: 'unsupported' };
      } catch {
        return { ok: false, error: 'unavailable' };
      }
      const result = await writeFileToClipboard(abs, {
        platform: process.platform,
        desktop: process.env.XDG_CURRENT_DESKTOP,
        writeBuffer: (format, buffer) => clipboard.writeBuffer(format, buffer),
        runCommand,
      });
      return result.ok ? { ok: true } : { ok: false, error: result.reason ?? 'unavailable' };
    }
  );

  handle(
    IPC_CHANNELS.FILES_REVEAL,
    async (_event, request: unknown): Promise<FilesMutateResult> => {
      const parsed = parseRequest(request);
      if (!parsed) return { ok: false, error: 'unavailable' };
      if (createProjectSsh(parsed.projectId)) return { ok: false, error: 'unsupported' };
      const cwd = resolveLocalCwd(parsed.conversationId, parsed.projectId);
      if (!cwd) return { ok: false, error: 'unavailable' };
      const abs = resolveLocalUnderCwd(cwd, parsed.rel);
      if (!abs) return { ok: false, error: 'invalid-path' };
      shell.showItemInFolder(abs);
      return { ok: true };
    }
  );
}
