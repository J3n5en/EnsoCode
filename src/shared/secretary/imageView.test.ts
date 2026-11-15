import { describe, expect, it } from 'vitest';
import {
  appUserImageDirs,
  defaultImageRoots,
  IMAGE_VIEW_MAX_BYTES,
  type ImageViewDeps,
  inImageViewScope,
  probeImageView,
  readImageView,
} from './imageView';

const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 3, 8, 6, 0, 0,
  0,
]);

const USER_DATA = '/Users/me/Library/Application Support/enso-code';
const CHAT_IMAGE = `${USER_DATA}/bot-chats/chat-1/media/abc.png`;

function deps(options: {
  files?: Record<string, Uint8Array>;
  links?: Record<string, string>;
  sizes?: Record<string, number>;
  roots?: string[];
}): ImageViewDeps {
  const files = options.files ?? {};
  const links = options.links ?? {};
  const sizes = options.sizes ?? {};
  return {
    async realpath(target) {
      const resolved = links[target] ?? target;
      return resolved in files ? resolved : null;
    },
    async size(target) {
      if (target in sizes) return sizes[target];
      return target in files ? (files[target]?.length ?? 0) : null;
    },
    async read(target) {
      return files[target] ?? null;
    },
    roots: () => options.roots ?? defaultImageRoots('/Users/me'),
  };
}

describe('appUserImageDirs', () => {
  it('应用存放用户图片的目录是 userData/bot-chats', () => {
    expect(appUserImageDirs(USER_DATA)).toEqual([`${USER_DATA}/bot-chats`]);
  });

  it('带上它以后，用户发在聊天里的图片在白名单内', () => {
    const roots = [...defaultImageRoots('/Users/me'), ...appUserImageDirs(USER_DATA)];
    expect(inImageViewScope(CHAT_IMAGE, roots)).toBe(true);
    // 应用数据目录的其它部分仍然拒绝
    expect(inImageViewScope(`${USER_DATA}/secretary/audit.jsonl`, roots)).toBe(false);
  });
});

describe('probeImageView', () => {
  it('只读文件头就给出大小与尺寸', async () => {
    const probe = await probeImageView(
      deps({
        files: { [CHAT_IMAGE]: PNG },
        roots: [...defaultImageRoots('/Users/me'), ...appUserImageDirs(USER_DATA)],
      }),
      CHAT_IMAGE
    );
    expect(probe).toMatchObject({
      ok: true,
      path: CHAT_IMAGE,
      size: PNG.length,
      facts: { format: 'png', mimeType: 'image/png', width: 4, height: 3 },
    });
  });

  it('越界、不存在、非图片、超大都在读整张图之前拒绝', async () => {
    const outOfScope = await probeImageView(
      deps({ files: { '/Users/me/secret.png': PNG } }),
      '/Users/me/secret.png'
    );
    expect(outOfScope.ok).toBe(false);
    if (!outOfScope.ok) expect(outOfScope.error).toContain('out of scope');

    const missing = await probeImageView(deps({}), '/tmp/missing.png');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('/tmp/missing.png');

    const notImage = await probeImageView(
      deps({ files: { '/tmp/fake.png': Uint8Array.from([1, 2, 3, 4]) } }),
      '/tmp/fake.png'
    );
    expect(notImage.ok).toBe(false);
    if (!notImage.ok) expect(notImage.error).toContain('not a supported image');

    const tooLarge = await probeImageView(
      deps({ files: { '/tmp/big.png': PNG }, sizes: { '/tmp/big.png': IMAGE_VIEW_MAX_BYTES + 1 } }),
      '/tmp/big.png'
    );
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.error).toContain('too large');
  });
});

describe('readImageView', () => {
  it('符号链接穿越按真实路径拒绝', async () => {
    const outcome = await readImageView(
      deps({
        files: { '/Users/me/secret.png': PNG },
        links: { '/tmp/link.png': '/Users/me/secret.png' },
      }),
      '/tmp/link.png'
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('out of scope');
  });
});
