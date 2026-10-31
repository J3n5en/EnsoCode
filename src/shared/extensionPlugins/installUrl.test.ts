import { describe, expect, it } from 'vitest';
import { resolvePluginArchive } from './installUrl';

const href = (input: string) => {
  const result = resolvePluginArchive(new URL(input));
  return result.ok ? { archive: result.archive.href, subdir: result.subdir } : result;
};

describe('resolvePluginArchive', () => {
  it('普通链接原样当作 zip', () => {
    expect(href('https://example.com/plugin.zip')).toEqual({
      archive: 'https://example.com/plugin.zip',
      subdir: null,
    });
  });

  it('GitHub 仓库默认分支打成 zipball，tree 链接带上分支和子目录', () => {
    expect(href('https://github.com/acme/demo')).toEqual({
      archive: 'https://api.github.com/repos/acme/demo/zipball',
      subdir: null,
    });
    expect(href('https://www.github.com/acme/demo.git/')).toEqual({
      archive: 'https://api.github.com/repos/acme/demo/zipball',
      subdir: null,
    });
    expect(href('https://github.com/acme/demo/tree/main/plugins/demo')).toEqual({
      archive: 'https://api.github.com/repos/acme/demo/zipball/main',
      subdir: 'plugins/demo',
    });
  });

  it('已经是 GitHub zip 的链接不改写', () => {
    expect(href('https://github.com/acme/demo/releases/download/v1/plugin.zip')).toEqual({
      archive: 'https://github.com/acme/demo/releases/download/v1/plugin.zip',
      subdir: null,
    });
  });

  it('不是仓库的 GitHub 链接拒绝', () => {
    const result = resolvePluginArchive(new URL('https://github.com/acme'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('github.com/owner/repo');
  });
});
