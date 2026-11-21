/**
 * 秘书的 contact_send_file：把一张图片或一个文件发到用户手机（联系方式渠道）。
 *
 * 路径边界与 image_view 同一套：先 realpath，再要求落在会话 worktree 根、系统临时目录、
 * 应用存放用户图片的目录里，单个不超过 10MB。字节在这里读一次交给核心，渠道不再按路径读盘。
 * 渠道怎么发（Telegram 内置、插件渠道）由联系方式核心决定，这里不认识任何渠道。
 */
import path from 'node:path';
import { readImageFacts } from '@shared/secretary/imageBytes';
import {
  IMAGE_VIEW_MAX_BYTES,
  type ImageViewDeps,
  validateScopedFile,
} from '@shared/secretary/imageView';
import { SECRETARY_CONTACT_CAPTION_MAX } from '@shared/secretary/tools';
import type { SecretaryAuditEntry } from '@shared/types/secretary';
import { appendAudit } from './audit';
import type { ContactMediaInput, ContactMediaResult } from './contact/service';
import { realImageViewDeps } from './imageView';
import type { SecretaryOpHandler, SecretaryOpResult } from './tools';

export type ContactMediaSender = (
  conversationId: string | null,
  media: ContactMediaInput
) => Promise<ContactMediaResult>;

/** 联系方式服务起来后由它登记；没登记表示当前环境没有联系方式 */
let sender: ContactMediaSender | null = null;

export function setContactMediaSender(next: ContactMediaSender | null): void {
  sender = next;
}

const FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.log': 'text/plain',
};

export interface ContactSendHandlerPorts {
  deps: ImageViewDeps;
  sender(): ContactMediaSender | null;
  audit(entry: SecretaryAuditEntry): void;
  now(): number;
}

export function createContactSendFileHandler(ports: ContactSendHandlerPorts): SecretaryOpHandler {
  return async (params, ctx): Promise<SecretaryOpResult> => {
    const requested = typeof params.path === 'string' ? params.path : '';
    const as = params.as === 'image' || params.as === 'file' ? params.as : undefined;
    if (params.as !== undefined && as === undefined)
      return { ok: false, error: 'as must be "image" or "file"' };
    if (params.caption !== undefined && typeof params.caption !== 'string')
      return { ok: false, error: 'caption must be a string' };
    const caption = typeof params.caption === 'string' ? params.caption.trim() : '';
    if (caption.length > SECRETARY_CONTACT_CAPTION_MAX)
      return {
        ok: false,
        error: `caption is too long, the limit is ${SECRETARY_CONTACT_CAPTION_MAX} characters`,
      };

    const audit = (ok: boolean, target: string, detail: string) =>
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'contact_send_file',
        targetId: target.slice(0, 1024),
        ok,
        detail: detail.slice(0, 200),
      });
    const refuse = (target: string, error: string): SecretaryOpResult => {
      audit(false, target, error);
      return { ok: false, error };
    };

    const valid = await validateScopedFile(ports.deps, requested, as ?? 'file');
    if (!valid.ok) return refuse(requested, valid.error);
    const bytes = await ports.deps.read(valid.path);
    if (!bytes) return refuse(valid.path, `cannot read file: ${valid.path}`);
    // 校验后文件又被写大：以实际读到的为准
    if (bytes.length > IMAGE_VIEW_MAX_BYTES)
      return refuse(valid.path, 'file is too large, the limit is 10.0 MB');
    const facts = readImageFacts(bytes);
    if (as === 'image' && !facts)
      return refuse(
        valid.path,
        `not a supported image: ${valid.path}. Only png, jpg, jpeg, webp and gif are accepted, judged by the file header; send it with as "file" instead.`
      );
    // gif 当图片发会丢动画：没指定时按文件发
    const kind = as ?? (facts && facts.format !== 'gif' ? 'image' : 'file');
    const send = ports.sender();
    if (!send) return refuse(valid.path, 'contact channels are not available in this environment');
    const fileName = path.basename(valid.path);
    const mimeType = facts?.mimeType ?? FILE_MIME[path.extname(fileName).toLowerCase()];
    const result = await send(ctx.secretaryConversationId, {
      kind,
      path: valid.path,
      buffer: Buffer.from(bytes),
      fileName,
      ...(mimeType ? { mimeType } : {}),
      ...(caption ? { caption } : {}),
    });
    if (!result.ok)
      return refuse(
        valid.path,
        'no connected contact channel: the user has not connected Telegram or another channel, or every channel is switched off'
      );
    const outcomes = result.outcomes.map((item) => ({
      channel: item.channelId,
      status: item.status,
      ...(item.error ? { error: item.error } : {}),
    }));
    const summary = outcomes.map((item) => `${item.channel}:${item.status}`).join(', ');
    const delivered = outcomes.some((item) => item.status !== 'failed');
    audit(delivered, valid.path, `${kind} ${bytes.length} bytes; ${summary}`);
    if (!delivered)
      return {
        ok: false,
        error: `failed to send the ${kind} on every channel (${summary}); the user got a short note with the path`,
      };
    return { ok: true, result: { path: valid.path, kind, size: bytes.length, outcomes } };
  };
}

export function contactSendFileHandlerFor(dir: string): SecretaryOpHandler {
  return createContactSendFileHandler({
    deps: realImageViewDeps,
    sender: () => sender,
    audit: (entry) => appendAudit(dir, entry),
    now: () => Date.now(),
  });
}
