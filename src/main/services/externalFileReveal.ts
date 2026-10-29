import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectedMessage } from '@shared/types/agent';

const PATH_MAX = 4096;
const WRITE_TOOLS = new Set(['write', 'edit']);

/**
 * 工作区外链接的定位目标：只收绝对路径，按真实目标判断，必须是普通文件（目录、不存在一律拒绝）。
 *
 * Reveal target for out-of-workspace links: absolute paths only, judged by the real target, regular files only.
 */
export function resolveExternalRevealTarget(
  input: unknown
): { ok: true; real: string } | { ok: false; error: 'invalid-path' } {
  if (
    typeof input !== 'string' ||
    input.length > PATH_MAX ||
    input.includes('\0') ||
    !path.isAbsolute(input)
  ) {
    return { ok: false, error: 'invalid-path' };
  }
  try {
    const real = realpathSync(input);
    return statSync(real).isFile() ? { ok: true, real } : { ok: false, error: 'invalid-path' };
  } catch {
    return { ok: false, error: 'invalid-path' };
  }
}

function realOf(cwd: string, raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, '');
  if (!trimmed) return null;
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
  try {
    return realpathSync(path.resolve(cwd, expanded));
  } catch {
    return null;
  }
}

/**
 * 本会话写入类工具（write / edit / apply_patch）成功写过、现仍存在的文件真实路径。
 *
 * Real paths of files that this session's write tools successfully wrote and that still exist.
 */
export function sessionWrittenFiles(
  messages: readonly ProjectedMessage[],
  cwd: string
): Set<string> {
  const succeeded = new Set<string>();
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId && !message.isError)
      succeeded.add(message.toolCallId);
  }
  const written = new Set<string>();
  const add = (raw: unknown) => {
    const real = typeof raw === 'string' ? realOf(cwd, raw) : null;
    if (real) written.add(real);
  };
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolName === 'apply_patch') {
      for (const change of message.fileChanges ?? [])
        if (change.type !== 'delete') add(change.path);
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall' || !WRITE_TOOLS.has(part.name) || !succeeded.has(part.id))
        continue;
      const args = part.arguments as Record<string, unknown> | null | undefined;
      add(args?.path ?? args?.file_path);
    }
  }
  return written;
}
