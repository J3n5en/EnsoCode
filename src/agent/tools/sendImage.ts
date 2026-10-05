import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  SEND_IMAGE_CAPTION_MAX,
  SEND_IMAGE_PER_REPLY,
  sendImageItems,
} from '@shared/bots/sendImage';
import { type ApprovalGate, throwUnlessAllowed } from '../approval';
import type { DelegationOp } from './delegation';
import type { MemoryInvoker } from './memory';

const PATH_ALIASES = [
  'file',
  'file_path',
  'filePath',
  'image',
  'image_path',
  'imagePath',
  'filename',
];
const CAPTION_ALIASES = ['text', 'description', 'message', 'alt', 'title'];
const LATEST = new Set(['latest', 'last', 'recent', 'newest']);

function screenshotIndex(value: unknown): unknown {
  if (value === true) return 1;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : value;
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase();
  if (LATEST.has(text)) return 1;
  return /^\d+$/.test(text) ? Number(text) : value;
}

/** schema 校验前归一化：别名键、截图简写 → 序号、工作区内 → 相对路径、工作区外 / ~ → 绝对路径、空值删除 */
export function normalizeSendImageParams(raw: unknown, cwd: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const params = { ...raw } as Record<string, unknown>;
  for (const [aliases, key] of [
    [PATH_ALIASES, 'path'],
    [CAPTION_ALIASES, 'caption'],
  ] as const) {
    for (const alias of aliases) {
      if (!(alias in params)) continue;
      if (params[key] === undefined || params[key] === null) params[key] = params[alias];
      delete params[alias];
    }
  }
  if (params.screenshot === false || params.screenshot === null) delete params.screenshot;
  else if (params.screenshot !== undefined) params.screenshot = screenshotIndex(params.screenshot);
  if (typeof params.path === 'string') {
    let file = params.path.trim();
    if (file === '~' || file.startsWith('~/')) file = path.join(homedir(), file.slice(1));
    if (file) {
      const abs = path.resolve(cwd, file);
      params.path = isInside(cwd, abs) ? path.relative(cwd, abs) : abs;
    } else params.path = file;
  }
  if (typeof params.caption === 'string') params.caption = params.caption.trim();
  for (const key of ['path', 'caption'])
    if (params[key] === null || params[key] === undefined || params[key] === '') delete params[key];
  return params;
}

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** 工作区内路径原样；解析符号链接后落在工作区外的返回真实绝对路径 */
function outsidePath(cwd: string, file: string): string | null {
  if (path.isAbsolute(file)) return file;
  const target = real(path.resolve(cwd, file));
  return isInside(real(cwd), target) ? null : target;
}

export type ConfirmOutsideImage = (
  file: string,
  signal: AbortSignal | undefined,
  toolCallId: string
) => Promise<void>;

/** 工作区外的图片按成员审批档位确认；拒绝 / 取消抛错 */
export function confirmOutsideImage(gate: ApprovalGate): ConfirmOutsideImage {
  return async (file, signal, toolCallId) => {
    if (!gate.needsApproval('command', 'send_image')) return;
    throwUnlessAllowed(
      await gate.ask(
        'send_image',
        'command',
        `Send image from outside the workspace: ${file}`,
        signal,
        toolCallId
      )
    );
  };
}

interface BranchEntry {
  type?: string;
  message?: { role: string; toolName?: string; content: unknown };
}

/** 本条回复（最后一条 user 消息之后）已发出的图片数 */
function sentThisReply(branch: readonly BranchEntry[]): number {
  const messages: NonNullable<BranchEntry['message']>[] = [];
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = branch[i].type === 'message' ? branch[i].message : undefined;
    if (!message) continue;
    if (message.role === 'user') break;
    messages.unshift(message);
  }
  return sendImageItems(messages).length;
}

const errorResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: undefined,
  isError: true,
});

export function createSendImageTool(
  invoker: MemoryInvoker<DelegationOp>,
  cwd: string,
  confirmOutside: ConfirmOutsideImage
): ToolDefinition {
  const normalize = (raw: unknown) => normalizeSendImageParams(raw, cwd);
  let inflight = 0;
  return {
    name: 'send_image',
    label: 'send_image',
    description: `Post an image into this chat under your reply, so the user sees it inline (they cannot see your tool screenshots otherwise). Pass exactly one of: path = an image file (PNG/JPEG/GIF/WebP; workspace-relative, or an absolute path such as /tmp/x.png — files outside the workspace may need the user's approval), or screenshot = 1|2|3 to send one of your 3 most recent browser_screenshot/computer screenshots (1 = most recent). Optional caption. At most ${SEND_IMAGE_PER_REPLY} images per reply; only send what the user asked for or clearly needs. Desktop (computer) screenshots may show other windows: check before sending. Call it directly, not from a codemode script. Do not paste the returned mediaId into your reply text.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description: 'Workspace-relative or absolute image path',
        },
        screenshot: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: '1 = most recent screenshot',
        },
        caption: { type: 'string', maxLength: SEND_IMAGE_CAPTION_MAX },
      },
      required: [],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    prepareArguments: normalize as ToolDefinition['prepareArguments'],
    async execute(toolCallId, raw, signal, _onUpdate, ctx) {
      const params = normalize(raw) as Record<string, unknown>;
      if ((params.path === undefined) === (params.screenshot === undefined))
        return errorResult('Pass exactly one of path or screenshot.');
      const branch = (ctx?.sessionManager?.getBranch?.() ?? []) as BranchEntry[];
      if (sentThisReply(branch) + inflight >= SEND_IMAGE_PER_REPLY)
        return errorResult(
          `At most ${SEND_IMAGE_PER_REPLY} images per reply; this one was not sent.`
        );
      inflight++;
      try {
        if (typeof params.path === 'string') {
          const outside = outsidePath(cwd, params.path);
          if (outside) {
            await confirmOutside(outside, signal, toolCallId);
            params.path = outside;
          }
        }
        const result = await invoker.invoke('send_image', params, signal);
        const ok = Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: undefined,
          ...(ok ? {} : { isError: true }),
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      } finally {
        inflight--;
      }
    },
  };
}
