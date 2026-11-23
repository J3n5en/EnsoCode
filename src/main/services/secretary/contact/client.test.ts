import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramApi } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 55, chat: { id: 1 } } })
      );
    })
  );
  return calls;
}

describe('Telegram 上传', () => {
  it('sendPhoto：multipart 带 chat_id、message_thread_id、caption 与 photo 文件', async () => {
    const calls = stubFetch();
    const api = createTelegramApi('T', 'https://tg.test');
    const id = await api.sendPhoto({
      chatId: 777,
      threadId: 42,
      data: Buffer.from([1, 2, 3]),
      fileName: 'shot.png',
      mimeType: 'image/png',
      caption: '截图',
    });
    expect(id).toBe(55);
    expect(calls[0]?.url).toBe('https://tg.test/botT/sendPhoto');
    const form = calls[0]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // multipart 边界由 fetch 写：不能手动设 Content-Type
    expect(calls[0]?.init.headers).toBeUndefined();
    expect(form.get('chat_id')).toBe('777');
    expect(form.get('message_thread_id')).toBe('42');
    expect(form.get('caption')).toBe('截图');
    const photo = form.get('photo') as File;
    expect(photo.name).toBe('shot.png');
    expect(photo.type).toBe('image/png');
    expect([...new Uint8Array(await photo.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('sendDocument：document 字段；没有话题与 caption 时不带这两项', async () => {
    const calls = stubFetch();
    const api = createTelegramApi('T', 'https://tg.test');
    await api.sendDocument({ chatId: 777, data: Buffer.from('pdf'), fileName: 'report.pdf' });
    expect(calls[0]?.url).toBe('https://tg.test/botT/sendDocument');
    const form = calls[0]?.init.body as FormData;
    expect(form.get('chat_id')).toBe('777');
    expect(form.has('message_thread_id')).toBe(false);
    expect(form.has('caption')).toBe(false);
    expect((form.get('document') as File).name).toBe('report.pdf');
  });

  it('sendMessage 带 reply_to_message_id，缺省则不带', async () => {
    const calls = stubFetch();
    const api = createTelegramApi('T', 'https://tg.test');
    await api.sendMessage({ chatId: 777, text: '里程碑', replyToMessageId: 42 });
    await api.sendMessage({ chatId: 777, text: '普通' });
    const first = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    const second = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(first.reply_to_message_id).toBe(42);
    expect(first.allow_sending_without_reply).toBe(true);
    expect(second.reply_to_message_id).toBeUndefined();
    expect(second.allow_sending_without_reply).toBeUndefined();
  });
});
