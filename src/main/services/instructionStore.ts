import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { readSettings } from '../ipc/settings';

/** 本地副本目录：userData/instructions/<id>.md */
function storeDir(): string {
  return path.join(app.getPath('userData'), 'instructions');
}

/** id 由主进程校验，只接受 uuid 形态，避免路径穿越 */
export const isValidId = (id: string): boolean => /^[a-f0-9-]{36}$/i.test(id);

function localFile(id: string): string {
  return path.join(storeDir(), `${id}.md`);
}

export interface ReadResult {
  ok: boolean;
  content: string;
  error?: string;
}

/** 读取内容：已复制的读本地副本，否则读源文件 */
export function readInstruction(id: string, local: boolean, sourcePath?: string): ReadResult {
  const file = local ? (isValidId(id) ? localFile(id) : '') : (sourcePath ?? '');
  if (!file) return { ok: false, content: '', error: 'No source' };

  try {
    return { ok: true, content: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return {
      ok: false,
      content: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 写入本地副本（首次写入即完成 copy-on-write），返回字节数 */
export function writeInstruction(id: string, content: string): { ok: boolean; bytes: number } {
  if (!isValidId(id)) return { ok: false, bytes: 0 };
  try {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(localFile(id), content, 'utf8');
    return { ok: true, bytes: Buffer.byteLength(content, 'utf8') };
  } catch {
    return { ok: false, bytes: 0 };
  }
}

/** 该路径是否为已登记条目的源文件——只有登记过的路径才允许写回 */
function isRegisteredSource(id: string, sourcePath: string): boolean {
  const settings = readSettings();
  const state = (settings?.['enso-settings'] as { state?: { instructions?: unknown } } | undefined)
    ?.state;
  const instructions = Array.isArray(state?.instructions) ? state.instructions : [];
  const target = path.resolve(sourcePath);

  return instructions.some((item) => {
    const entry = item as { id?: string; sourcePath?: string };
    return entry.id === id && entry.sourcePath && path.resolve(entry.sourcePath) === target;
  });
}

/** 直接写回源应用的原文件（会改动对方配置，仅在用户显式选择时调用） */
export function writeInstructionSource(
  id: string,
  sourcePath: string,
  content: string
): { ok: boolean; bytes: number; error?: string } {
  if (!isValidId(id) || !isRegisteredSource(id, sourcePath)) {
    return { ok: false, bytes: 0, error: 'Not a registered source file' };
  }
  try {
    fs.writeFileSync(sourcePath, content, 'utf8');
    return { ok: true, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (error) {
    return {
      ok: false,
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 删除本地副本（源文件不动） */
export function deleteInstruction(id: string): void {
  if (!isValidId(id)) return;
  try {
    fs.rmSync(localFile(id), { force: true });
  } catch {
    // 忽略
  }
}

type InstructionPick = {
  id: string;
  local: boolean;
  sourcePath?: string;
  enabled?: boolean;
};

function pickInstruction(explicit?: { instructionId?: string }): InstructionPick | undefined {
  const settings = readSettings();
  const state = (settings?.['enso-settings'] as { state?: { instructions?: unknown } } | undefined)
    ?.state;
  const instructions = Array.isArray(state?.instructions)
    ? (state.instructions as InstructionPick[])
    : [];
  return explicit
    ? explicit.instructionId
      ? instructions.find((item) => item.id === explicit.instructionId)
      : undefined
    : instructions.find((item) => item.enabled === true);
}

/**
 * 解析本会话要注入的指令（不落盘）。
 * 不传 explicit → 取启用条目；传 explicit → 自定义预设指定的 instructionId（无视 enabled）。
 */
export function resolveGlobalInstruction(explicit?: {
  instructionId?: string;
}): { path: string; content: string } | undefined {
  const target = pickInstruction(explicit);
  if (!target) return undefined;
  const result = readInstruction(target.id, target.local, target.sourcePath);
  if (!result.ok || !result.content.trim()) return undefined;
  const filePath = target.local
    ? localFile(target.id)
    : (target.sourcePath ?? localFile(target.id));
  return { path: filePath, content: result.content };
}
