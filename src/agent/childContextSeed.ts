import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SubagentSeedContext } from '@shared/types/agent';
import { type ContextMessage, imagePlaceholder, sanitizeContextMessages } from './imageContext';
import type { ReadLedger } from './priorRead';
import {
  classifyProtectedCommand,
  classifyProtectedTool,
  expandPiToolPath,
  isSecretFilePath,
  isUnderSecretDirectory,
} from './protectedActions';
import { extractWriteTargetPaths } from './writeScope';

export const MAX_PRIOR_READS_CHARS = 30_000;
export const MAX_FILE_SLICE_CHARS = 8_000;
export const MAX_FORK_COMPACT_CHARS = 24_000;
export const MAX_FORK_TRAJECTORY_CHARS = 14_000;
export const MAX_FORK_FILES_CHARS = 10_000;
export const MAX_SEED_USER_TURNS = 3;
export const MAX_SEED_USER_TURN_CHARS = 1_500;
export const MAX_SEED_USER_SECTION_CHARS = 4_500;
export const KEEP_SEED_USER_IMAGE_TURNS = 2;
export const MAX_SEED_IMAGES = 3;
export const MAX_SEED_IMAGE_BASE64_CHARS = 512 * 1024;

export interface SeedImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ChildContextSeed {
  /** 结构化 XML/Markdown 文本块，仅在子会话首轮 user prompt 前置注入一次 */
  text: string;
  /** 可选：最近用户贴图（仅当目标子模型支持 image 输入时透传，遵守体积与张数上限） */
  images?: SeedImage[];
  /** 观测元数据（用于日志/测试断言，不进模型系统提示词） */
  stats: {
    mode: SubagentSeedContext;
    filesIncluded: number;
    staleFilesSkipped: number;
    userTurnsIncluded: number;
    imagesIncluded: number;
    chars: number;
  };
}

export interface BuildChildContextSeedOptions {
  /** fork 档不走文本种子，由 supervisor 原样注入父请求前缀 */
  mode: Exclude<SubagentSeedContext, 'fork'>;
  cwd: string;
  /** 目标子模型是否支持图像输入（不支持时降级为文本占位，防上游 400） */
  acceptsImages: boolean;
  /** 可选：本次 spawn 的任务 prompt，用于避免把相同用户原话重复注入 */
  spawnPrompt?: string;
  /** 远程会话不做本机磁盘 realpath/stat，只做词法边界与敏感路径过滤 */
  remote?: boolean;
  /** 单图 base64 字符上限，默认 MAX_SEED_IMAGE_BASE64_CHARS */
  maxImageBase64Chars?: number;
}

interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  msgIndex: number;
}

interface RawFileSlice {
  msgIndex: number;
  source: 'read' | 'grep';
  startLine: number;
  endLine: number;
  text: string;
}

interface FileSliceGroup {
  key: string;
  relPath: string;
  latestMsgIndex: number;
  slices: RawFileSlice[];
}

const MUTATION_TOOLS = new Set(['edit', 'write', 'apply_patch']);
const SHOWING_LINES_FOOTER = /\n*\[\s*Showing lines (\d+)-(\d+) of (\d+)[^\]]*\]\s*$/i;
const SYNTHETIC_WRAPPER_RE =
  /<(?:role|parent_context_seed|system-reminder|background-task-update)(?:\s[^>]*)?>[\s\S]*?<\/(?:role|parent_context_seed|system-reminder|background-task-update)>/gi;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const STALE_FILE_NOTICE = '[modified on disk since parent read; re-read before editing]';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function emptySeed(mode: SubagentSeedContext): ChildContextSeed {
  return {
    text: '',
    stats: {
      mode,
      filesIncluded: 0,
      staleFilesSkipped: 0,
      userTurnsIncluded: 0,
      imagesIncluded: 0,
      chars: 0,
    },
  };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

function rawPathOfArgs(args: Record<string, unknown>): string | undefined {
  const candidate = args.path ?? args.file_path ?? args.filePath ?? args.file;
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  if (!trimmed || /^[a-z]+:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    parts.push(block.text);
  }
  return parts.join('\n');
}

function stripSyntheticWrappers(text: string): string {
  return text.replace(SYNTHETIC_WRAPPER_RE, '').trim();
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxChars: number, suffix = '\n... [truncated]'): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= suffix.length) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`;
}

function isInsideRoot(root: string, target: string, posixOnly: boolean): boolean {
  const P = posixOnly ? path.posix : path;
  const rel = P.relative(root, target);
  if (!rel || rel === '..' || P.isAbsolute(rel)) return false;
  return !rel.startsWith(`..${P.sep}`) && !rel.startsWith('../');
}

function toDisplayRelPath(root: string, target: string, posixOnly: boolean): string {
  const P = posixOnly ? path.posix : path;
  return P.relative(root, target).split(P.sep).join('/');
}

async function resolveWorkspaceTarget(
  rawPath: string,
  cwd: string,
  cwdCanonical: string,
  remote: boolean
): Promise<
  | { status: 'ok'; key: string; relPath: string }
  | { status: 'missing'; key: string; relPath: string }
  | { status: 'skip' }
> {
  const expanded = expandPiToolPath(rawPath);
  if (!expanded || isSecretFilePath(expanded) || isUnderSecretDirectory(expanded)) {
    return { status: 'skip' };
  }
  if (remote) {
    const posixOnly = cwd.startsWith('/');
    const P = posixOnly ? path.posix : path;
    const normalized = posixOnly ? expanded.replace(/\\/g, '/') : expanded;
    const resolved = P.resolve(cwdCanonical, normalized);
    if (isSecretFilePath(resolved) || isUnderSecretDirectory(resolved)) {
      return { status: 'skip' };
    }
    if (!isInsideRoot(cwdCanonical, resolved, posixOnly)) {
      return { status: 'skip' };
    }
    return {
      status: 'ok',
      key: resolved,
      relPath: toDisplayRelPath(cwdCanonical, resolved, posixOnly),
    };
  }
  const resolved = path.resolve(cwd, expanded);
  if (isSecretFilePath(resolved) || isUnderSecretDirectory(resolved)) {
    return { status: 'skip' };
  }
  try {
    const real = await realpath(resolved);
    if (isSecretFilePath(real) || isUnderSecretDirectory(real)) {
      return { status: 'skip' };
    }
    if (!isInsideRoot(cwdCanonical, real, false)) {
      return { status: 'skip' };
    }
    return {
      status: 'ok',
      key: real,
      relPath: toDisplayRelPath(cwdCanonical, real, false),
    };
  } catch {
    // 文件已被删除或不可解析：仅当字面路径仍在工作区内时标记 missing，防止越界探测
    const fallbackRoot = path.resolve(cwd);
    if (
      !isInsideRoot(fallbackRoot, resolved, false) &&
      !isInsideRoot(cwdCanonical, resolved, false)
    ) {
      return { status: 'skip' };
    }
    const baseRoot = isInsideRoot(cwdCanonical, resolved, false) ? cwdCanonical : fallbackRoot;
    return {
      status: 'missing',
      key: resolved,
      relPath: toDisplayRelPath(baseRoot, resolved, false),
    };
  }
}

function parseReadSlice(
  rawText: string,
  args: Record<string, unknown>
): { startLine: number; endLine: number; text: string } | null {
  const footerMatch = SHOWING_LINES_FOOTER.exec(rawText);
  const body = footerMatch ? rawText.slice(0, footerMatch.index).trimEnd() : rawText.trimEnd();
  if (!body.trim()) return null;
  const lines = body.split('\n');
  if (footerMatch) {
    const startLine = Number(footerMatch[1]);
    const endLine = Number(footerMatch[2]);
    if (Number.isInteger(startLine) && Number.isInteger(endLine) && endLine >= startLine) {
      return { startLine, endLine, text: body };
    }
  }
  const startLine = positiveInt(args.offset) ?? 1;
  const endLine = startLine + Math.max(lines.length, 1) - 1;
  return { startLine, endLine, text: body };
}

/** 合并同文件相邻或重叠切片，保留最新且最完整的内容，消除重复行 */
function mergeFileSlices(slices: readonly RawFileSlice[]): {
  rangesLabel: string;
  text: string;
} {
  const hasRead = slices.some((s) => s.source === 'read');
  const selected = hasRead ? slices.filter((s) => s.source === 'read') : [...slices];
  if (!hasRead) {
    // grep 片段不做行号拼接，取最新一次结果
    const latest = selected.reduce((a, b) => (b.msgIndex >= a.msgIndex ? b : a));
    return { rangesLabel: 'grep matches', text: latest.text };
  }
  const sorted = [...selected].sort((a, b) =>
    a.startLine !== b.startLine ? a.startLine - b.startLine : b.msgIndex - a.msgIndex
  );
  const merged: Array<{
    startLine: number;
    endLine: number;
    msgIndex: number;
    lines: string[];
  }> = [];
  for (const slice of sorted) {
    const lines = slice.text.split('\n');
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({
        startLine: slice.startLine,
        endLine: slice.endLine,
        msgIndex: slice.msgIndex,
        lines,
      });
      continue;
    }
    // 完全被已有区间覆盖：同区间且更新时替换，否则跳过旧切片
    if (slice.startLine >= prev.startLine && slice.endLine <= prev.endLine) {
      if (
        slice.startLine === prev.startLine &&
        slice.endLine === prev.endLine &&
        slice.msgIndex > prev.msgIndex
      ) {
        prev.lines = lines;
        prev.msgIndex = slice.msgIndex;
      }
      continue;
    }
    // 相邻或重叠区间：按行号精确去重拼接
    if (slice.startLine <= prev.endLine + 1) {
      const overlap = prev.endLine - slice.startLine + 1;
      if (overlap === 0) {
        prev.lines = [...prev.lines, ...lines];
      } else if (slice.msgIndex >= prev.msgIndex) {
        const keepPrev = Math.max(0, prev.lines.length - overlap);
        prev.lines = [...prev.lines.slice(0, keepPrev), ...lines];
      } else {
        prev.lines = [...prev.lines, ...lines.slice(Math.min(overlap, lines.length))];
      }
      prev.endLine = Math.max(prev.endLine, slice.endLine);
      prev.msgIndex = Math.max(prev.msgIndex, slice.msgIndex);
      continue;
    }
    merged.push({
      startLine: slice.startLine,
      endLine: slice.endLine,
      msgIndex: slice.msgIndex,
      lines,
    });
  }
  const rangesLabel = merged.map((seg) => `L${seg.startLine}-L${seg.endLine}`).join(', ');
  const text = merged.map((seg) => seg.lines.join('\n')).join('\n... (lines omitted) ...\n');
  return { rangesLabel, text };
}

interface ExtractedFiles {
  fresh: Array<{ relPath: string; rangesLabel: string; text: string; latestMsgIndex: number }>;
  staleRelPaths: string[];
}

async function extractPriorReadFiles(
  messages: readonly ContextMessage[],
  parentReadLedger: ReadLedger | undefined,
  cwd: string,
  cwdCanonical: string,
  remote: boolean
): Promise<ExtractedFiles> {
  const callsById = new Map<string, ToolCallRecord>();
  const mutationIndexByKey = new Map<string, number>();
  const groups = new Map<string, FileSliceGroup>();
  const missingStale = new Map<string, { relPath: string; latestMsgIndex: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'assistant') {
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') continue;
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!isRecord(block) || block.type !== 'toolCall') continue;
        if (typeof block.id !== 'string' || typeof block.name !== 'string') continue;
        callsById.set(block.id, {
          id: block.id,
          name: block.name,
          args: isRecord(block.arguments) ? block.arguments : {},
          msgIndex: i,
        });
      }
      continue;
    }
    if (msg.role !== 'toolResult' || msg.isError === true) continue;
    const call = typeof msg.toolCallId === 'string' ? callsById.get(msg.toolCallId) : undefined;
    const toolName = (typeof msg.toolName === 'string' ? msg.toolName : call?.name) ?? '';
    const args = call?.args ?? {};

    // 追踪父会话对文件的成功改写：改写之前读出的旧切片必须判为陈旧
    if (MUTATION_TOOLS.has(toolName)) {
      const targets = extractWriteTargetPaths(toolName, args);
      for (const rawTarget of targets) {
        const resolved = await resolveWorkspaceTarget(rawTarget, cwd, cwdCanonical, remote);
        if (resolved.status !== 'skip') {
          mutationIndexByKey.set(resolved.key, i);
        }
      }
      continue;
    }

    if (toolName !== 'read' && toolName !== 'grep') continue;
    const rawPath = rawPathOfArgs(args);
    if (!rawPath) continue;

    const target = await resolveWorkspaceTarget(rawPath, cwd, cwdCanonical, remote);
    if (target.status === 'skip') continue;
    if (target.status === 'missing') {
      if (toolName === 'read') {
        missingStale.set(target.key, { relPath: target.relPath, latestMsgIndex: i });
      }
      continue;
    }

    const rawText = extractTextFromContent(msg.content);
    if (!rawText.trim()) continue;

    if (toolName === 'grep') {
      // grep 只在指向具体普通文件时才纳入候选，目录级搜索结果不冒充文件切片
      if (!remote) {
        const st = await stat(target.key).catch(() => null);
        if (!st?.isFile()) continue;
      }
      const group = groups.get(target.key) ?? {
        key: target.key,
        relPath: target.relPath,
        latestMsgIndex: i,
        slices: [],
      };
      group.latestMsgIndex = Math.max(group.latestMsgIndex, i);
      group.slices.push({
        msgIndex: i,
        source: 'grep',
        startLine: 1,
        endLine: 1,
        text: rawText.trimEnd(),
      });
      groups.set(target.key, group);
      continue;
    }

    const parsed = parseReadSlice(rawText, args);
    if (!parsed) continue;
    const group = groups.get(target.key) ?? {
      key: target.key,
      relPath: target.relPath,
      latestMsgIndex: i,
      slices: [],
    };
    group.latestMsgIndex = Math.max(group.latestMsgIndex, i);
    group.slices.push({
      msgIndex: i,
      source: 'read',
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      text: parsed.text,
    });
    groups.set(target.key, group);
  }

  // 按最近读取优先排序
  const ordered = [...groups.values()].sort((a, b) => b.latestMsgIndex - a.latestMsgIndex);
  const fresh: ExtractedFiles['fresh'] = [];
  const staleEntries: Array<{ relPath: string; latestMsgIndex: number }> = [
    ...missingStale.values(),
  ];

  for (const group of ordered) {
    const mutatedAt = mutationIndexByKey.get(group.key) ?? -1;
    const postMutationSlices = group.slices.filter((slice) => slice.msgIndex > mutatedAt);
    if (postMutationSlices.length === 0) {
      staleEntries.push({ relPath: group.relPath, latestMsgIndex: group.latestMsgIndex });
      continue;
    }
    if (!remote) {
      const st = await stat(group.key).catch(() => null);
      if (!st?.isFile()) {
        staleEntries.push({ relPath: group.relPath, latestMsgIndex: group.latestMsgIndex });
        continue;
      }
      const ledgerMeta = parentReadLedger ? await parentReadLedger.getMeta(group.key) : undefined;
      if (ledgerMeta && (ledgerMeta.mtimeMs !== st.mtimeMs || ledgerMeta.size !== st.size)) {
        staleEntries.push({ relPath: group.relPath, latestMsgIndex: group.latestMsgIndex });
        continue;
      }
    }
    const merged = mergeFileSlices(postMutationSlices);
    fresh.push({
      relPath: group.relPath,
      rangesLabel: merged.rangesLabel,
      text: merged.text,
      latestMsgIndex: group.latestMsgIndex,
    });
  }

  // 去重 stale 路径并按最近读取优先排列
  staleEntries.sort((a, b) => b.latestMsgIndex - a.latestMsgIndex);
  const staleRelPaths: string[] = [];
  const staleSeen = new Set<string>();
  for (const entry of staleEntries) {
    if (staleSeen.has(entry.relPath)) continue;
    staleSeen.add(entry.relPath);
    staleRelPaths.push(entry.relPath);
  }

  return { fresh, staleRelPaths };
}

function extractRecentUserTurns(
  messages: readonly ContextMessage[],
  spawnPrompt?: string
): string[] {
  const promptNorm = spawnPrompt ? normalizeForMatch(spawnPrompt) : '';
  const collected: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && collected.length < MAX_SEED_USER_TURNS; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    const raw = stripSyntheticWrappers(extractTextFromContent(msg.content));
    if (!raw) continue;
    const norm = normalizeForMatch(raw);
    if (!norm || seen.has(norm)) continue;
    if (promptNorm && (promptNorm === norm || promptNorm.includes(norm))) continue;
    seen.add(norm);
    collected.push(truncateText(raw, MAX_SEED_USER_TURN_CHARS));
  }
  return collected.reverse();
}

function extractRecentUserImages(
  messages: readonly ContextMessage[],
  acceptsImages: boolean,
  maxImageBase64Chars: number
): { images: SeedImage[]; placeholders: string[] } {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') userIndices.push(i);
  }
  const recentIndices = userIndices.slice(-KEEP_SEED_USER_IMAGE_TURNS);
  const candidates: SeedImage[] = [];
  const placeholders: string[] = [];

  for (const idx of recentIndices) {
    const content = messages[idx]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'image') continue;
      const data = typeof block.data === 'string' ? block.data : '';
      const mimeType = typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : '';
      if (!data || !mimeType) continue;
      if (!acceptsImages) {
        placeholders.push(
          imagePlaceholder(
            { type: 'image', mimeType },
            'attached by user in parent conversation (target model does not accept image input)'
          ).text
        );
        continue;
      }
      if (data.length > maxImageBase64Chars) {
        placeholders.push(
          imagePlaceholder(
            { type: 'image', mimeType },
            'attached by user in parent conversation (exceeded seed size budget)'
          ).text
        );
        continue;
      }
      candidates.push({ type: 'image', data, mimeType });
    }
  }

  // 最多保留最近 MAX_SEED_IMAGES 张图，超出的降级为占位说明
  if (candidates.length <= MAX_SEED_IMAGES) {
    return { images: candidates, placeholders };
  }
  const dropped = candidates.slice(0, candidates.length - MAX_SEED_IMAGES);
  for (const img of dropped) {
    placeholders.push(
      imagePlaceholder(
        { type: 'image', mimeType: img.mimeType },
        'attached by user in parent conversation (exceeded seed image count limit)'
      ).text
    );
  }
  return { images: candidates.slice(-MAX_SEED_IMAGES), placeholders };
}

function summarizeToolCall(call: { name: string; args: Record<string, unknown> }): string {
  const rawPath = rawPathOfArgs(call.args);
  if (rawPath) {
    const expanded = expandPiToolPath(rawPath);
    if (isSecretFilePath(expanded) || isUnderSecretDirectory(expanded)) {
      return `${call.name}([redacted secret path])`;
    }
    const offset = positiveInt(call.args.offset);
    const limit = positiveInt(call.args.limit);
    const range =
      offset !== undefined || limit !== undefined
        ? ` (offset=${offset ?? 1}${limit !== undefined ? `, limit=${limit}` : ''})`
        : '';
    return `${call.name}(${rawPath}${range})`;
  }
  if (typeof call.args.command === 'string' && call.args.command.trim()) {
    const cmd = call.args.command.replace(/\s+/g, ' ').trim();
    return `${call.name}(${truncateText(cmd, 120, '...')})`;
  }
  if (typeof call.args.pattern === 'string' && call.args.pattern.trim()) {
    return `${call.name}(pattern=${truncateText(call.args.pattern.trim(), 80, '...')})`;
  }
  return `${call.name}()`;
}

function isSensitiveCall(call: ToolCallRecord | undefined): boolean {
  if (!call) return false;
  // 与审批底线同源：子代理自己去拿要真人确认的结果（命令点名密钥、grep glob 点名密钥），不经种子转交
  if (classifyProtectedTool(call.name, 'read', call.args) === 'secret') return true;
  if (
    typeof call.args.command === 'string' &&
    classifyProtectedCommand(call.args.command) === 'secret'
  ) {
    return true;
  }
  const rawPath = rawPathOfArgs(call.args);
  if (rawPath) {
    const expanded = expandPiToolPath(rawPath);
    if (isSecretFilePath(expanded) || isUnderSecretDirectory(expanded)) return true;
  }
  if (MUTATION_TOOLS.has(call.name)) {
    for (const target of extractWriteTargetPaths(call.name, call.args)) {
      const expanded = expandPiToolPath(target);
      if (isSecretFilePath(expanded) || isUnderSecretDirectory(expanded)) return true;
    }
  }
  return false;
}

/**
 * 将父会话清洗后的消息折叠为跨模型安全的纯文本轨迹：
 * 彻底剥离所有厂商专属字段（thinking / thinkingSignature / thoughtSignature / redacted_thinking 等），
 * 丢弃孤儿 toolResult 与冗长原始 stdout，只保留用户决策、助手结论和关键工具结果摘要。
 */
function buildCompactedTrajectory(
  messages: readonly ContextMessage[],
  budgetChars: number
): { text: string; userTurnsIncluded: number } {
  const sanitized = sanitizeContextMessages([...messages]);
  const callsById = new Map<string, ToolCallRecord>();
  const entries: Array<{ text: string; isUser: boolean }> = [];

  for (let i = 0; i < sanitized.length; i++) {
    const msg = sanitized[i];
    if (!msg) continue;

    if (msg.role === 'user') {
      const text = stripSyntheticWrappers(extractTextFromContent(msg.content));
      if (!text) continue;
      entries.push({
        isUser: true,
        text: `User: ${truncateText(text, MAX_SEED_USER_TURN_CHARS)}`,
      });
      continue;
    }

    if (msg.role === 'compactionSummary' || msg.role === 'branchSummary') {
      const summary = extractTextFromContent(msg.content).trim();
      if (!summary) continue;
      entries.push({
        isUser: false,
        text: `Summary: ${truncateText(summary, 2_000)}`,
      });
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') continue;
      const textParts: string[] = [];
      const callSummaries: string[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) textParts.push(msg.content.trim());
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!isRecord(block)) continue;
          // 严格白名单：只接受 text 和 toolCall，所有 thinking / signature / 厂商私有块一律剥离
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            textParts.push(block.text.trim());
          } else if (
            block.type === 'toolCall' &&
            typeof block.id === 'string' &&
            typeof block.name === 'string'
          ) {
            const record: ToolCallRecord = {
              id: block.id,
              name: block.name,
              args: isRecord(block.arguments) ? block.arguments : {},
              msgIndex: i,
            };
            callsById.set(block.id, record);
            callSummaries.push(summarizeToolCall(record));
          }
        }
      }
      const combined = [
        textParts.length > 0 ? truncateText(textParts.join('\n'), 1_200) : '',
        callSummaries.length > 0 ? `Tools: ${callSummaries.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      if (combined) {
        entries.push({ isUser: false, text: `Assistant: ${combined}` });
      }
      continue;
    }

    if (msg.role === 'toolResult') {
      const call = typeof msg.toolCallId === 'string' ? callsById.get(msg.toolCallId) : undefined;
      if (isSensitiveCall(call)) continue;
      const toolName = (typeof msg.toolName === 'string' ? msg.toolName : call?.name) ?? 'tool';
      const cleaned = extractTextFromContent(msg.content)
        .replace(ANSI_ESCAPE_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (msg.isError === true) {
        const snippet = truncateText(cleaned || 'error', 240, '...');
        entries.push({ isUser: false, text: `ToolError(${toolName}): ${snippet}` });
      } else if (toolName === 'read') {
        const target = call ? rawPathOfArgs(call.args) : undefined;
        entries.push({
          isUser: false,
          text: `Tool(${toolName}): ok${target ? ` (${target})` : ''}`,
        });
      } else if (cleaned) {
        entries.push({
          isUser: false,
          text: `Tool(${toolName}): ${truncateText(cleaned, 320, '...')}`,
        });
      }
    }
  }

  // 从最新往旧填充预算，保证近期决策、约束和排错结论优先保留
  const kept: Array<{ text: string; isUser: boolean }> = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const separatorCost = kept.length > 0 ? 2 : 0;
    const needed = entry.text.length + separatorCost;
    if (used + needed <= budgetChars) {
      kept.push(entry);
      used += needed;
    } else if (kept.length === 0 && budgetChars > 40) {
      kept.push({ isUser: entry.isUser, text: truncateText(entry.text, budgetChars) });
      used = kept[0].text.length;
      break;
    } else {
      break;
    }
  }
  kept.reverse();
  const userTurnsIncluded = kept.filter((item) => item.isUser).length;
  return {
    text: kept.map((item) => item.text).join('\n\n'),
    userTurnsIncluded,
  };
}

function renderFileSection(
  files: ExtractedFiles,
  budgetChars: number,
  perFileMaxChars: number
): { text: string; filesIncluded: number; staleFilesSkipped: number } {
  const parts: string[] = [];
  let remaining = budgetChars;
  let filesIncluded = 0;

  if (files.staleRelPaths.length > 0 && remaining > 80) {
    const staleLines = files.staleRelPaths.map((rel) => `- ${rel} ${STALE_FILE_NOTICE}`);
    const staleBlock = truncateText(
      `### Stale Parent Reads\n${staleLines.join('\n')}`,
      Math.min(remaining, 2_000)
    );
    parts.push(staleBlock);
    remaining -= staleBlock.length + 2;
  }

  if (files.fresh.length > 0 && remaining > 120) {
    const header = '### Parent Read File Slices';
    const fileBlocks: string[] = [];
    let sectionRemaining = remaining - header.length - 1;

    for (const file of files.fresh) {
      const title = `#### ${file.relPath} (${file.rangesLabel})\n`;
      const fenceOpen = '```\n';
      const fenceClose = '\n```';
      const overhead =
        title.length + fenceOpen.length + fenceClose.length + (fileBlocks.length > 0 ? 2 : 0);
      const availForBody = Math.min(perFileMaxChars, sectionRemaining - overhead);
      if (availForBody < 64) break;
      const body = truncateText(file.text, availForBody);
      const block = `${title}${fenceOpen}${body}${fenceClose}`;
      fileBlocks.push(block);
      sectionRemaining -= block.length + (fileBlocks.length > 1 ? 2 : 0);
      filesIncluded++;
    }

    if (fileBlocks.length > 0) {
      parts.push(`${header}\n${fileBlocks.join('\n\n')}`);
    }
  }

  return {
    text: parts.join('\n\n'),
    filesIncluded,
    staleFilesSkipped: files.staleRelPaths.length,
  };
}

function wrapSeed(mode: SubagentSeedContext, body: string, maxChars: number): string {
  const open = `<parent_context_seed mode="${mode}">\n`;
  const close = '\n</parent_context_seed>';
  const innerBudget = Math.max(0, maxChars - open.length - close.length);
  const clamped = truncateText(body.trim(), innerBudget);
  return `${open}${clamped}${close}`;
}

/**
 * 为新派发的子代理构建跨模型安全的一次性首轮上下文种子。
 * 所有输出均为标准文本（外加可选合法图像块），不包含任何厂商私有字段。
 */
export async function buildChildContextSeed(
  parentMessages: readonly ContextMessage[],
  parentReadLedger: ReadLedger | undefined,
  opts: BuildChildContextSeedOptions
): Promise<ChildContextSeed> {
  if (opts.mode === 'none') {
    return emptySeed('none');
  }

  const remote = opts.remote === true;
  const cwdCanonical = remote
    ? opts.cwd.startsWith('/')
      ? path.posix.resolve(opts.cwd)
      : path.resolve(opts.cwd)
    : await realpath(opts.cwd).catch(() => path.resolve(opts.cwd));

  const files = await extractPriorReadFiles(
    parentMessages,
    parentReadLedger,
    opts.cwd,
    cwdCanonical,
    remote
  );
  const { images, placeholders } = extractRecentUserImages(
    parentMessages,
    opts.acceptsImages,
    opts.maxImageBase64Chars ?? MAX_SEED_IMAGE_BASE64_CHARS
  );

  const wrapperReserve =
    `<parent_context_seed mode="${opts.mode}">\n\n</parent_context_seed>`.length + 16;

  if (opts.mode === 'prior_reads') {
    const userTurns = extractRecentUserTurns(parentMessages, opts.spawnPrompt);
    const sections: string[] = [];
    let used = 0;
    const totalInnerBudget = MAX_PRIOR_READS_CHARS - wrapperReserve;

    if (userTurns.length > 0) {
      const userBlock = truncateText(
        `### Recent User Constraints\n${userTurns.map((t, idx) => `${idx + 1}. ${t}`).join('\n')}`,
        Math.min(MAX_SEED_USER_SECTION_CHARS, totalInnerBudget)
      );
      sections.push(userBlock);
      used += userBlock.length + 2;
    }

    if (placeholders.length > 0 && used < totalInnerBudget - 80) {
      const noteBlock = truncateText(
        `### Parent User Attachments\n${placeholders.map((line) => `- ${line}`).join('\n')}`,
        Math.min(1_500, totalInnerBudget - used)
      );
      sections.push(noteBlock);
      used += noteBlock.length + 2;
    }

    const fileBudget = Math.max(0, totalInnerBudget - used);
    const renderedFiles = renderFileSection(files, fileBudget, MAX_FILE_SLICE_CHARS);
    if (renderedFiles.text) {
      sections.push(renderedFiles.text);
    }

    if (sections.length === 0 && images.length === 0) {
      return emptySeed('prior_reads');
    }

    const body =
      sections.length > 0
        ? sections.join('\n\n')
        : '### Parent User Attachments\nRecent user image attachment(s) from the parent conversation are included below.';
    const text = wrapSeed('prior_reads', body, MAX_PRIOR_READS_CHARS);
    return {
      text,
      ...(images.length > 0 ? { images } : {}),
      stats: {
        mode: 'prior_reads',
        filesIncluded: renderedFiles.filesIncluded,
        staleFilesSkipped: renderedFiles.staleFilesSkipped,
        userTurnsIncluded: userTurns.length,
        imagesIncluded: images.length,
        chars: text.length,
      },
    };
  }

  // mode === 'fork_compact'
  const totalInnerBudget = MAX_FORK_COMPACT_CHARS - wrapperReserve;
  const trajectoryBudget = Math.min(MAX_FORK_TRAJECTORY_CHARS, totalInnerBudget);
  const trajectory = buildCompactedTrajectory(parentMessages, trajectoryBudget);

  const sections: string[] = [];
  let used = 0;

  if (trajectory.text) {
    const trajHeader = '### Compacted Parent Conversation\n';
    const trajBody = truncateText(
      trajectory.text,
      Math.max(0, trajectoryBudget - trajHeader.length)
    );
    const trajBlock = `${trajHeader}${trajBody}`;
    sections.push(trajBlock);
    used += trajBlock.length + 2;
  }

  if (placeholders.length > 0 && used < totalInnerBudget - 80) {
    const noteBlock = truncateText(
      `### Parent User Attachments\n${placeholders.map((line) => `- ${line}`).join('\n')}`,
      Math.min(1_200, totalInnerBudget - used)
    );
    sections.push(noteBlock);
    used += noteBlock.length + 2;
  }

  const filesBudget = Math.min(MAX_FORK_FILES_CHARS, Math.max(0, totalInnerBudget - used));
  const renderedFiles = renderFileSection(files, filesBudget, MAX_FILE_SLICE_CHARS);
  if (renderedFiles.text) {
    sections.push(renderedFiles.text);
  }

  if (sections.length === 0 && images.length === 0) {
    return emptySeed('fork_compact');
  }

  const body =
    sections.length > 0
      ? sections.join('\n\n')
      : '### Parent User Attachments\nRecent user image attachment(s) from the parent conversation are included below.';
  const text = wrapSeed('fork_compact', body, MAX_FORK_COMPACT_CHARS);
  return {
    text,
    ...(images.length > 0 ? { images } : {}),
    stats: {
      mode: 'fork_compact',
      filesIncluded: renderedFiles.filesIncluded,
      staleFilesSkipped: renderedFiles.staleFilesSkipped,
      userTurnsIncluded: trajectory.userTurnsIncluded,
      imagesIncluded: images.length,
      chars: text.length,
    },
  };
}
