import { describe, expect, it } from 'vitest';
import { classifyMarkdownLink, splitFileLineRef, toWorkspaceRelativePath } from './markdownLinks';

describe('splitFileLineRef', () => {
  it('拆出路径与起始行号', () => {
    expect(splitFileLineRef('src/agent/supervisor.ts:107')).toEqual({
      path: 'src/agent/supervisor.ts',
      line: 107,
    });
    expect(splitFileLineRef('README.md:12-30')).toEqual({ path: 'README.md', line: 12 });
  });

  it('无行号或行号为 0 时只返回路径', () => {
    expect(splitFileLineRef('src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(splitFileLineRef('src/a.ts:0')).toEqual({ path: 'src/a.ts' });
  });
});

describe('classifyMarkdownLink', () => {
  it('保留网页链接交给默认浏览器', () => {
    expect(classifyMarkdownLink('https://example.com/a%20b')).toEqual({ kind: 'external' });
    expect(classifyMarkdownLink('http://example.com')).toEqual({ kind: 'external' });
  });

  it('识别 Windows 正反斜杠绝对路径与 file URL', () => {
    expect(classifyMarkdownLink('H:\\code\\EnsoCode\\docs\\中文%20空间\\README.md')).toEqual({
      kind: 'local',
      path: 'H:\\code\\EnsoCode\\docs\\中文 空间\\README.md',
    });
    expect(
      classifyMarkdownLink('H:/code/EnsoCode/dist/reveal-menu-0.1.32/EnsoCode-Setup-0.1.32.exe')
    ).toEqual({
      kind: 'local',
      path: 'H:/code/EnsoCode/dist/reveal-menu-0.1.32/EnsoCode-Setup-0.1.32.exe',
    });
    expect(
      classifyMarkdownLink(
        'file:///H:/code/EnsoCode/docs/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.md#L1'
      )
    ).toEqual({
      kind: 'local',
      path: 'H:/code/EnsoCode/docs/中文 空格.md',
    });
  });

  it('识别工作区相对路径并拒绝危险协议', () => {
    expect(classifyMarkdownLink('./docs/readme.md')).toEqual({
      kind: 'local',
      path: './docs/readme.md',
    });
    expect(classifyMarkdownLink('javascript:alert(1)')).toEqual({ kind: 'blocked' });
    expect(classifyMarkdownLink('data:text/html,alert(1)')).toEqual({ kind: 'blocked' });
  });
});

describe('toWorkspaceRelativePath', () => {
  it('按 Windows 工作区根转换正反斜杠绝对路径', () => {
    expect(
      toWorkspaceRelativePath(
        'H:\\code\\EnsoCode\\dist\\reveal-menu-0.1.32\\EnsoCode-Setup-0.1.32.exe',
        'H:/code/EnsoCode'
      )
    ).toBe('dist/reveal-menu-0.1.32/EnsoCode-Setup-0.1.32.exe');
  });

  it('保留工作区相对路径并拒绝逃出工作区的路径', () => {
    expect(toWorkspaceRelativePath('./docs/../README.md', 'H:/code/EnsoCode')).toBe('README.md');
    expect(toWorkspaceRelativePath('../outside.txt', 'H:/code/EnsoCode')).toBeNull();
    expect(
      toWorkspaceRelativePath('H:/code/EnsoCode-other/file.txt', 'H:/code/EnsoCode')
    ).toBeNull();
  });

  it('Windows 路径比较不区分盘符和大小写', () => {
    expect(toWorkspaceRelativePath('h:\\CODE\\ensocode\\README.md', 'H:/code/EnsoCode')).toBe(
      'README.md'
    );
  });

  it.each([
    '/H:/code/EnsoCode/dist/馆长-1.0.11-Windows-x64.exe',
    '/h:/CODE/ensocode/dist/馆长-1.0.11-Windows-x64.exe',
    '/H:\\code\\EnsoCode\\dist\\馆长-1.0.11-Windows-x64.exe',
  ])('兼容 AI 生成的带前导斜杠的 Windows 链接 %s', (link) => {
    const classified = classifyMarkdownLink(link);
    expect(classified.kind).toBe('local');
    if (classified.kind !== 'local') throw new Error('Expected local file link');
    expect(toWorkspaceRelativePath(classified.path, 'H:/code/EnsoCode')).toBe(
      'dist/馆长-1.0.11-Windows-x64.exe'
    );
  });

  it.each([
    '/H:/code/EnsoCode-other/setup.exe',
    '/D:/code/EnsoCode/setup.exe',
    '/H:/code/EnsoCode/../outside/setup.exe',
    '/H:/../README.md',
    '/H:/code/EnsoCode/../../../secret.txt',
  ])('带前导斜杠的 Windows 链接仍拒绝越界 %s', (link) => {
    expect(toWorkspaceRelativePath(link, 'H:/code/EnsoCode')).toBeNull();
  });

  it('仅在 Windows 工作区解释前导斜杠，不改变 Unix 路径或缺失上下文的边界', () => {
    expect(toWorkspaceRelativePath('/H:/code/EnsoCode/setup.exe')).toBeNull();
    expect(toWorkspaceRelativePath('/H:/code/EnsoCode/setup.exe', '/H:/code')).toBe(
      'EnsoCode/setup.exe'
    );
    expect(toWorkspaceRelativePath('/H:/code/EnsoCode/setup.exe', '/workspace')).toBeNull();
  });

  it('没有 worktree 时仍允许安全的相对路径交给 Main 校验', () => {
    expect(toWorkspaceRelativePath('./docs/README.md')).toBe('docs/README.md');
    expect(toWorkspaceRelativePath('../outside.txt')).toBeNull();
    expect(toWorkspaceRelativePath('H:/outside.txt')).toBeNull();
  });
});
