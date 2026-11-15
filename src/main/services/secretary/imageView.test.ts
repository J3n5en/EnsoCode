import type { SecretaryAuditEntry } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  createSecretaryImageViewHandler,
  defaultImageRoots,
  IMAGE_VIEW_MAX_BYTES,
  type ImageViewDeps,
  inImageViewScope,
  isUnderRoot,
  readImageView,
} from './imageView';

const ROOTS = ['/home/me/project/worktree', '/tmp', '/private/tmp', '/private/var/folders'];

const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 3, 8, 6, 0, 0,
  0,
]);

interface FakeOptions {
  files?: Record<string, Uint8Array>;
  /** 符号链接：key 是链接路径，值是它指向的真实路径 */
  links?: Record<string, string>;
  sizes?: Record<string, number>;
  roots?: string[];
}

function deps(options: FakeOptions = {}): ImageViewDeps {
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
    roots: () => options.roots ?? ROOTS,
  };
}

describe('isUnderRoot / inImageViewScope', () => {
  it('按目录边界判断，前缀相同但不同目录不算在内', () => {
    expect(isUnderRoot('/tmp/a.png', '/tmp')).toBe(true);
    expect(isUnderRoot('/tmp', '/tmp')).toBe(true);
    expect(isUnderRoot('/tmpfoo/a.png', '/tmp')).toBe(false);
    expect(isUnderRoot('/private/tmp/a.png', '/private/tmp')).toBe(true);
  });

  it('只放行会话 worktree 根与系统临时目录', () => {
    expect(inImageViewScope('/tmp/shot.png', ROOTS)).toBe(true);
    expect(inImageViewScope('/private/var/folders/xy/T/shot.png', ROOTS)).toBe(true);
    expect(inImageViewScope('/home/me/project/worktree/wt1/shot.png', ROOTS)).toBe(true);
    expect(inImageViewScope('/home/me/shot.png', ROOTS)).toBe(false);
    expect(inImageViewScope('/home/me/project/enso-code/shot.png', ROOTS)).toBe(false);
    expect(inImageViewScope('/home/me/Library/Application Support/enso-code/shot.png', ROOTS)).toBe(
      false
    );
  });

  it('默认根目录是 worktree 根加三处临时目录', () => {
    expect(defaultImageRoots('/Users/me')).toEqual([
      '/Users/me/project/worktree',
      '/tmp',
      '/private/tmp',
      '/private/var/folders',
    ]);
  });
});

describe('readImageView', () => {
  it('读得到 /tmp 下的 png，并给出大小与尺寸', async () => {
    const outcome = await readImageView(deps({ files: { '/tmp/shot.png': PNG } }), '/tmp/shot.png');
    expect(outcome).toMatchObject({
      ok: true,
      path: '/tmp/shot.png',
      size: PNG.length,
      facts: { format: 'png', mimeType: 'image/png', width: 4, height: 3 },
    });
    if (outcome.ok) expect(Buffer.from(outcome.data, 'base64')).toEqual(Buffer.from(PNG));
  });

  it('用户主目录、项目检出、应用数据目录一律拒绝', async () => {
    const files = {
      '/Users/me/shot.png': PNG,
      '/Users/me/project/enso-code/shot.png': PNG,
      '/Users/me/Library/Application Support/enso-code/shot.png': PNG,
    };
    for (const target of Object.keys(files)) {
      const outcome = await readImageView(deps({ files }), target);
      expect(outcome.ok, target).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('out of scope');
    }
  });

  it('符号链接指向白名单外时按真实路径拒绝', async () => {
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

  it('符号链接指向白名单内时放行，返回的是真实路径', async () => {
    const outcome = await readImageView(
      deps({
        files: { '/private/tmp/real.png': PNG },
        links: { '/tmp/alias.png': '/private/tmp/real.png' },
      }),
      '/tmp/alias.png'
    );
    expect(outcome).toMatchObject({ ok: true, path: '/private/tmp/real.png' });
  });

  it('扩展名是 png 但内容不是图片时按文件头拒绝', async () => {
    const outcome = await readImageView(
      deps({ files: { '/tmp/fake.png': Uint8Array.from([1, 2, 3, 4, 5]) } }),
      '/tmp/fake.png'
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('not a supported image');
  });

  it('超过 10MB 拒绝并说明大小', async () => {
    const outcome = await readImageView(
      deps({ files: { '/tmp/big.png': PNG }, sizes: { '/tmp/big.png': IMAGE_VIEW_MAX_BYTES + 1 } }),
      '/tmp/big.png'
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('too large');
      expect(outcome.error).toContain('10.0 MB');
    }
  });

  it('相对路径与空路径直接拒绝', async () => {
    expect((await readImageView(deps(), 'shot.png')).ok).toBe(false);
    expect((await readImageView(deps(), '   ')).ok).toBe(false);
  });

  it('文件不存在时说明路径', async () => {
    const outcome = await readImageView(deps(), '/tmp/missing.png');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('/tmp/missing.png');
  });
});

describe('createSecretaryImageViewHandler', () => {
  function harness(options: FakeOptions = {}) {
    const audits: SecretaryAuditEntry[] = [];
    const handler = createSecretaryImageViewHandler({
      deps: deps(options),
      audit: (entry) => audits.push(entry),
      now: () => 1700,
    });
    return { handler, audits };
  }

  it('成功时返回图片字节，审计只记路径与大小', async () => {
    const { handler, audits } = harness({ files: { '/tmp/shot.png': PNG } });
    const result = await handler({ path: '/tmp/shot.png' }, { secretaryConversationId: 'sec-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.result as Record<string, unknown>;
      expect(value).toMatchObject({ path: '/tmp/shot.png', width: 4, height: 3 });
      expect(typeof value.data).toBe('string');
    }
    expect(audits).toEqual([
      expect.objectContaining({
        op: 'image_view',
        ok: true,
        targetId: '/tmp/shot.png',
        secretaryConversationId: 'sec-1',
      }),
    ]);
    // 审计里不能出现图片内容
    expect(JSON.stringify(audits)).not.toContain('iVBOR');
  });

  it('拒绝时也记审计，并把原因交给模型', async () => {
    const { handler, audits } = harness({ files: { '/Users/me/x.png': PNG } });
    const result = await handler({ path: '/Users/me/x.png' }, { secretaryConversationId: 'sec-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('out of scope');
    expect(audits[0]).toMatchObject({ op: 'image_view', ok: false });
  });
});
