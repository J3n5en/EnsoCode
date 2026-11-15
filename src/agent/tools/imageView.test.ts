import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createImageViewTool, imageViewRoots } from './imageView';

const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 3, 8, 6, 0, 0,
  0,
]);

let root = '';
let cwd = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'enso-image-view-'));
  cwd = join(root, 'worktree');
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  // 临时目录在系统白名单内，测试结束直接删
  rmSync(root, { recursive: true, force: true });
});

function tool(options: { userImageDirs?: string[] } = {}) {
  return createImageViewTool({ cwd, ...options });
}

async function run(options: { userImageDirs?: string[] }, path: string) {
  const definition = tool(options);
  return (await definition.execute(
    'call-1',
    { path } as never,
    undefined,
    undefined,
    {} as never
  )) as {
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    isError?: boolean;
  };
}

describe('imageViewRoots', () => {
  it('白名单是会话自己的工作目录、系统临时目录与应用存放用户图片的目录', () => {
    const roots = imageViewRoots({
      cwd: '/srv/worktree/p1/abc',
      userImageDirs: ['/srv/bot-chats'],
    });
    expect(roots).toContain('/srv/worktree/p1/abc');
    expect(roots).toContain('/srv/bot-chats');
    // 根目录本身也解析真实路径：macOS 上 /tmp 是 /private/tmp 的符号链接
    expect(roots).toContain(realpathSync('/tmp'));
    // 别的会话 worktree 与用户主目录都不在
    expect(roots).not.toContain('/srv/worktree/p2/def');
    expect(roots.some((entry) => entry.startsWith('/Users/'))).toBe(false);
  });
});

describe('编码会话的 image_view', () => {
  it('工作目录里的 png 能看，返回元数据与图片字节', async () => {
    const file = join(cwd, 'shot.png');
    writeFileSync(file, PNG);
    const result = await run({}, file);
    expect(result.isError).toBeUndefined();
    const meta = JSON.parse(result.content[0]?.text ?? '{}');
    expect(meta).toMatchObject({ path: realpathSync(file), size: PNG.length, width: 4, height: 3 });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(result.content[1]?.data ?? '', 'base64')).toEqual(Buffer.from(PNG));
  });

  it('应用存放用户图片的目录里的图也能看', async () => {
    const chatMedia = join(root, 'bot-chats', 'chat-1', 'media');
    mkdirSync(chatMedia, { recursive: true });
    const file = join(chatMedia, 'upload.png');
    writeFileSync(file, PNG);
    const result = await run({ userImageDirs: [join(root, 'bot-chats')] }, file);
    expect(result.isError).toBeUndefined();
  });

  it('白名单外的路径拒绝', async () => {
    const result = await run({}, '/etc/hosts');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('out of scope');
  });

  it('符号链接指向白名单外时按真实路径拒绝', async () => {
    const link = join(cwd, 'link.png');
    symlinkSync('/etc/hosts', link);
    const result = await run({}, link);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('out of scope');
  });

  it('扩展名是 png 但内容不是图片时按文件头拒绝', async () => {
    const file = join(cwd, 'fake.png');
    writeFileSync(file, 'not an image');
    const result = await run({}, file);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not a supported image');
  });

  it('超过 10MB 拒绝', async () => {
    const file = join(cwd, 'big.png');
    writeFileSync(file, PNG);
    const handle = openSync(file, 'r+');
    try {
      ftruncateSync(handle, 10 * 1024 * 1024 + 1);
    } finally {
      closeSync(handle);
    }
    const result = await run({}, file);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('too large');
  });

  it('文件不存在时说明路径', async () => {
    const result = await run({}, join(cwd, 'missing.png'));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('missing.png');
  });
});
