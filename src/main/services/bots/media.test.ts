import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotChat } from '@shared/types/bot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotChatStore } from './chatStore';
import {
  mediaFile,
  resolveWorkspaceImage,
  ScreenshotCache,
  type SendImageDeps,
  sendImage,
  sniffImage,
  storeMedia,
} from './media';

const BOT_A = '11111111-1111-4111-8111-111111111111';
const BOT_B = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const png = (body: string | number) =>
  Buffer.concat([PNG, typeof body === 'number' ? Buffer.alloc(body, 1) : Buffer.from(body)]);

let root: string;
let workspace: string;
let media: string;
const noCompress = () => null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-media-'));
  workspace = join(root, 'ws');
  media = join(root, 'chat', 'media');
  mkdirSync(workspace, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('sniffImage', () => {
  it('recognizes formats by magic bytes, not by extension', () => {
    expect(sniffImage(png('x'))).toBe('png');
    expect(sniffImage(Buffer.concat([JPG, Buffer.from('x')]))).toBe('jpg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('plain text'))).toBeNull();
  });
});

describe('resolveWorkspaceImage', () => {
  it('rejects traversal, absolute, home and outside-pointing symlinks', () => {
    writeFileSync(join(workspace, 'ok.png'), png('ok'));
    writeFileSync(join(root, 'secret.png'), png('secret'));
    symlinkSync(join(root, 'secret.png'), join(workspace, 'link.png'));
    mkdirSync(join(workspace, 'shots'));
    symlinkSync(join(workspace, 'ok.png'), join(workspace, 'shots', 'inside.png'));
    expect(resolveWorkspaceImage(workspace, 'ok.png')).toMatch(/ok\.png$/);
    expect(resolveWorkspaceImage(workspace, './shots/inside.png')).toMatch(/ok\.png$/);
    for (const bad of [
      '../secret.png',
      'shots/../../secret.png',
      join(root, 'secret.png'),
      join(workspace, 'ok.png'),
      '~/secret.png',
      'link.png',
      'missing.png',
      'shots',
      '',
    ])
      expect(resolveWorkspaceImage(workspace, bad), bad).toBeNull();
  });
});

describe('storeMedia', () => {
  it('copies by content hash and dedupes identical images', () => {
    const first = storeMedia(media, png('same'), { compress: noCompress });
    const second = storeMedia(media, png('same'), { compress: noCompress });
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    expect(readdirSync(media)).toHaveLength(1);
    expect(first.ok && first.mediaId).toMatch(/^[a-f0-9]{64}\.png$/);
  });

  it('rejects non-images', () => {
    expect(storeMedia(media, Buffer.from('hello'), { compress: noCompress })).toEqual({
      ok: false,
      error: 'not-image',
    });
  });

  it('compresses oversized images and fails when compression cannot fit', () => {
    const big = png(64);
    expect(storeMedia(media, big, { compress: noCompress, fileMax: 32 })).toEqual({
      ok: false,
      error: 'too-large',
    });
    expect(
      storeMedia(media, big, {
        compress: () => Buffer.concat([JPG, Buffer.alloc(40)]),
        fileMax: 32,
      })
    ).toEqual({ ok: false, error: 'too-large' });
    const shrunk = storeMedia(media, big, {
      compress: () => Buffer.concat([JPG, Buffer.alloc(8)]),
      fileMax: 32,
    });
    expect(shrunk.ok && shrunk.mediaId).toMatch(/\.jpg$/);
  });

  it('refuses new images when the chat quota is full but still dedupes existing ones', () => {
    const kept = storeMedia(media, png(40), { compress: noCompress, quota: 64 });
    expect(kept.ok).toBe(true);
    expect(storeMedia(media, png(30), { compress: noCompress, quota: 64 })).toEqual({
      ok: false,
      error: 'quota',
    });
    expect(storeMedia(media, png(40), { compress: noCompress, quota: 64 })).toEqual(kept);
    expect(readdirSync(media)).toHaveLength(1);
  });
});

describe('mediaFile', () => {
  it('resolves only valid ids of regular files inside the media dir', () => {
    const stored = storeMedia(media, png('x'), { compress: noCompress });
    if (!stored.ok) throw new Error('store failed');
    expect(mediaFile(media, stored.mediaId)).toBe(join(media, stored.mediaId));
    writeFileSync(join(root, 'outside'), 'x');
    const linked = `${'e'.repeat(64)}.png`;
    symlinkSync(join(root, 'outside'), join(media, linked));
    for (const bad of [
      '../outside',
      '../../etc/passwd',
      linked,
      `${'f'.repeat(64)}.png`,
      `${stored.mediaId}/`,
      '',
    ])
      expect(mediaFile(media, bad), bad).toBeNull();
  });
});

describe('ScreenshotCache', () => {
  it('keeps the newest three per session, newest first', () => {
    const cache = new ScreenshotCache();
    for (const n of [1, 2, 3, 4]) cache.push('s1', { data: png(n), source: 'web' });
    expect(cache.pick('s1', 1)?.data).toEqual(png(4));
    expect(cache.pick('s1', 3)?.data).toEqual(png(2));
    expect(cache.pick('s1', 4)).toBeUndefined();
    expect(cache.pick('s2', 1)).toBeUndefined();
  });

  it('evicts the least recently used session', () => {
    const cache = new ScreenshotCache(2);
    cache.push('a', { data: png(1), source: 'web' });
    cache.push('b', { data: png(2), source: 'web' });
    cache.push('c', { data: png(3), source: 'desktop' });
    expect(cache.pick('a', 1)).toBeUndefined();
    expect(cache.pick('c', 1)?.source).toBe('desktop');
  });
});

describe('sendImage', () => {
  const chat = (kind: BotChat['kind'] = 'group'): BotChat =>
    ({
      id: CHAT,
      kind,
      members: kind === 'group' ? [BOT_A, BOT_B] : [BOT_A],
      sessions: { [BOT_A]: { conversationId: 'conv-a' }, [BOT_B]: { conversationId: 'conv-b' } },
    }) as unknown as BotChat;
  const deps = (overrides: Partial<SendImageDeps> = {}): SendImageDeps => ({
    chat: (id) => (id === CHAT ? chat() : undefined),
    mediaDir: () => media,
    workspaceRoot: () => workspace,
    screenshots: new ScreenshotCache(),
    compress: noCompress,
    ...overrides,
  });
  const binding = { botId: BOT_A, chatId: CHAT };

  it('sends a workspace image with caption', () => {
    writeFileSync(join(workspace, 'empty.png'), png('empty'));
    const result = sendImage(deps(), 'conv-a', binding, { path: 'empty.png', caption: '空状态' });
    expect(result).toMatchObject({
      ok: true,
      source: 'file',
      name: 'empty.png',
      caption: '空状态',
    });
    expect(result.ok && existsSync(join(media, result.mediaId))).toBe(true);
  });

  it('sends the nth cached screenshot with its source label', () => {
    const screenshots = new ScreenshotCache();
    screenshots.push('conv-a', { data: png('older'), source: 'desktop' });
    screenshots.push('conv-a', { data: png('newer'), source: 'web' });
    expect(sendImage(deps({ screenshots }), 'conv-a', binding, { screenshot: 1 })).toMatchObject({
      ok: true,
      source: 'web',
    });
    expect(sendImage(deps({ screenshots }), 'conv-a', binding, { screenshot: 2 })).toMatchObject({
      ok: true,
      source: 'desktop',
    });
  });

  it('errors when no screenshot is cached', () => {
    const result = sendImage(deps(), 'conv-a', binding, { screenshot: 1 });
    expect(result.ok).toBe(false);
    expect(existsSync(media)).toBe(false);
  });

  it('rejects sessions that are not the current member session of the chat', () => {
    writeFileSync(join(workspace, 'a.png'), png('a'));
    const params = { path: 'a.png' };
    for (const [conversationId, bind] of [
      ['conv-b', binding],
      ['conv-x', binding],
      ['conv-a', { botId: BOT_A, chatId: null }],
      ['conv-a', { botId: BOT_A, chatId: 'other-chat' }],
      ['conv-a', { ...binding, delegationId: 'd1' }],
      ['conv-b', { botId: BOT_B, chatId: CHAT, delegationId: 'd1' }],
    ] as const) {
      expect(sendImage(deps(), conversationId, bind, params).ok, conversationId).toBe(false);
    }
    const removed = deps({
      chat: () => ({ ...chat(), members: [BOT_B] }) as BotChat,
    });
    expect(sendImage(removed, 'conv-a', binding, params).ok).toBe(false);
    expect(existsSync(media)).toBe(false);
  });

  it('validates arguments and workspace availability', () => {
    writeFileSync(join(workspace, 'a.png'), png('a'));
    for (const params of [
      {},
      { path: 'a.png', screenshot: 1 },
      { path: 1 },
      { screenshot: 0 },
      { screenshot: 4 },
      { screenshot: '1' },
      { path: 'a.png', caption: 3 },
      { path: '../a.png' },
      { path: '~/a.png' },
    ])
      expect(sendImage(deps(), 'conv-a', binding, params).ok, JSON.stringify(params)).toBe(false);
    expect(
      sendImage(deps({ workspaceRoot: () => null }), 'conv-a', binding, { path: 'a.png' }).ok
    ).toBe(false);
  });

  it('sends an approved absolute path outside the workspace, named by its full path', () => {
    const outside = join(realpathSync(root), 'tmp', 'shot.png');
    mkdirSync(join(root, 'tmp'));
    writeFileSync(outside, png('outside'));
    const result = sendImage(deps(), 'conv-a', binding, { path: outside });
    expect(result).toMatchObject({ ok: true, source: 'file', name: outside });
    expect(
      sendImage(deps({ workspaceRoot: () => null }), 'conv-a', binding, { path: outside }).ok
    ).toBe(false);
    for (const path of [join(root, 'tmp'), join(root, 'missing.png')])
      expect(sendImage(deps(), 'conv-a', binding, { path }).ok, path).toBe(false);
    writeFileSync(join(root, 'notes.txt'), 'plain');
    expect(sendImage(deps(), 'conv-a', binding, { path: join(root, 'notes.txt') }).ok).toBe(false);
  });

  it('reports too-large and quota as displayable failures', () => {
    writeFileSync(join(workspace, 'big.png'), png(64));
    expect(
      sendImage(deps({ limits: { fileMax: 32 } }), 'conv-a', binding, { path: 'big.png' })
    ).toMatchObject({ ok: false, error: 'too-large', source: 'file', name: 'big.png' });
    expect(
      sendImage(deps({ limits: { quota: 16 } }), 'conv-a', binding, { path: 'big.png' })
    ).toMatchObject({ ok: false, error: 'quota', source: 'file' });
  });
});

describe('chat removal', () => {
  it('deletes the media directory with the chat', () => {
    const store = new BotChatStore(join(root, 'chats'));
    const created = store.create({
      kind: 'group',
      title: 'g',
      members: [BOT_A, BOT_B],
      bossBotId: BOT_A,
      workspace: { kind: 'project', projectId: 'p' },
    });
    if (!created) throw new Error('create failed');
    const dir = store.mediaDir(created.id);
    expect(storeMedia(dir, png('x'), { compress: noCompress }).ok).toBe(true);
    expect(existsSync(dir)).toBe(true);
    store.remove(created.id);
    expect(existsSync(dir)).toBe(false);
  });
});
