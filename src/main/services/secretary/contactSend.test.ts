import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretaryAuditEntry } from '@shared/types/secretary';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContactMediaInput } from './contact/service';
import { type ContactMediaSender, createContactSendFileHandler } from './contactSend';
import { IMAGE_VIEW_MAX_BYTES, realImageViewDeps } from './imageView';

const PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 3, 8, 6, 0, 0,
  0,
]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { sender?: ContactMediaSender | null } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'contact-send-')));
  dirs.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const sent: { conversationId: string | null; media: ContactMediaInput }[] = [];
  const audits: SecretaryAuditEntry[] = [];
  const sender: ContactMediaSender =
    options.sender ??
    (async (conversationId, media) => {
      sent.push({ conversationId, media });
      return { ok: true, outcomes: [{ channelId: 'telegram', status: 'sent' }] };
    });
  const handler = createContactSendFileHandler({
    deps: { ...realImageViewDeps, roots: () => [root] },
    sender: () => (options.sender === null ? null : sender),
    audit: (entry) => audits.push(entry),
    now: () => 1,
  });
  const call = (params: Record<string, unknown>) =>
    handler(params, { secretaryConversationId: 'sec-1' });
  return { root, outside, sent, audits, call };
}

describe('contact_send_file', () => {
  it('白名单内的 png 默认按图片发，字节与文件名交给联系方式核心', async () => {
    const h = setup();
    const target = join(h.root, 'shot.png');
    writeFileSync(target, PNG);
    const result = await h.call({ path: target, caption: '截图' });
    expect(result).toMatchObject({ ok: true, result: { path: target, kind: 'image' } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.conversationId).toBe('sec-1');
    expect(h.sent[0]?.media).toMatchObject({
      kind: 'image',
      path: target,
      fileName: 'shot.png',
      mimeType: 'image/png',
      caption: '截图',
    });
    expect(Buffer.compare(h.sent[0]!.media.buffer, PNG)).toBe(0);
    expect(h.audits.at(-1)).toMatchObject({ op: 'contact_send_file', ok: true, targetId: target });
  });

  it('非图片按文件发；as image 但不是图片被拒', async () => {
    const h = setup();
    const target = join(h.root, 'report.pdf');
    writeFileSync(target, '%PDF-1.4 hello');
    const result = await h.call({ path: target });
    expect(result).toMatchObject({ ok: true, result: { kind: 'file' } });
    expect(h.sent[0]?.media).toMatchObject({ kind: 'file', mimeType: 'application/pdf' });
    const refused = await h.call({ path: target, as: 'image' });
    expect(refused.ok).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it('白名单外的路径被拒，不读不发', async () => {
    const h = setup();
    const target = join(h.outside, 'secret.txt');
    writeFileSync(target, 'secret');
    const result = await h.call({ path: target });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('out of scope');
    expect(h.sent).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({ op: 'contact_send_file', ok: false });
  });

  it('白名单里的符号链接指向外面：先 realpath 再校验，被拒', async () => {
    const h = setup();
    const real = join(h.outside, 'id_rsa');
    writeFileSync(real, 'key');
    const link = join(h.root, 'innocent.txt');
    symlinkSync(real, link);
    const result = await h.call({ path: link });
    expect(!result.ok && result.error).toContain('out of scope');
    expect(h.sent).toEqual([]);
  });

  it('相对路径与 .. 穿越被拒', async () => {
    const h = setup();
    writeFileSync(join(h.outside, 'x.txt'), 'x');
    expect((await h.call({ path: 'x.txt' })).ok).toBe(false);
    const result = await h.call({ path: join(h.root, '..', 'outside', 'x.txt') });
    expect(!result.ok && result.error).toContain('out of scope');
    expect(h.sent).toEqual([]);
  });

  it('超过 10MB 被拒', async () => {
    const h = setup();
    const target = join(h.root, 'big.bin');
    writeFileSync(target, Buffer.alloc(IMAGE_VIEW_MAX_BYTES + 1));
    const result = await h.call({ path: target });
    expect(!result.ok && result.error).toContain('too large');
    expect(h.sent).toEqual([]);
  });

  it('没有已连接的渠道或环境没有联系方式：明确报错', async () => {
    const target = (root: string) => {
      const file = join(root, 'a.txt');
      writeFileSync(file, 'a');
      return file;
    };
    const none = setup({ sender: async () => ({ ok: false, error: 'not-bound' }) });
    const result = await none.call({ path: target(none.root) });
    expect(!result.ok && result.error).toContain('no connected contact channel');
    const absent = setup({ sender: null });
    const missing = await absent.call({ path: target(absent.root) });
    expect(!missing.ok && missing.error).toContain('not available');
  });

  it('每个渠道都失败：工具报错，告诉秘书用户已收到说明', async () => {
    const h = setup({
      sender: async () => ({
        ok: true,
        outcomes: [{ channelId: 'telegram', status: 'failed', error: 'network' }],
      }),
    });
    const target = join(h.root, 'a.txt');
    writeFileSync(target, 'a');
    const result = await h.call({ path: target });
    expect(!result.ok && result.error).toContain('telegram:failed');
  });
});
