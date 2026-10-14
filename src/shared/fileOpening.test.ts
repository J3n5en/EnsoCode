import { describe, expect, it } from 'vitest';
import {
  fileOpenViewer,
  normalizeFileOpenRules,
  parseFileOpenRules,
  resolveFileOpenTarget,
} from './fileOpening';

describe('文件打开规则', () => {
  it('扩展名支持省略点与通配前缀，统一小写并保留应用路径', () => {
    expect(
      normalizeFileOpenRules([
        { extension: ' MD ', target: 'internal' },
        { extension: '*.PDF', target: 'system' },
        { extension: 'csv', target: 'application', applicationPath: '/Applications/Reader.app' },
      ])
    ).toEqual([
      { extension: '.md', target: 'internal' },
      { extension: '.pdf', target: 'system' },
      { extension: '.csv', target: 'application', applicationPath: '/Applications/Reader.app' },
    ]);
  });

  it.each([
    null,
    {},
    'md',
    [{ extension: '../md', target: 'system' }],
    [{ extension: 'folder/md', target: 'system' }],
    [{ extension: '*.md;exe', target: 'system' }],
    [{ extension: 'md', target: 'command' }],
    [{ extension: 'md', target: 'internal', command: 'bad' }],
    [{ extension: 'md', target: 'application' }],
    [{ extension: 'md', target: 'application', applicationPath: 'editor.exe' }],
    [{ extension: 'md', target: 'application', applicationPath: '/bin/editor --execute' }],
    [{ extension: 'md', target: 'application', applicationPath: '"C:\\Editor.exe" --run' }],
    [{ extension: 'md', target: 'application', applicationPath: '/bin/editor;rm' }],
    [{ extension: 'md', target: 'internal', applicationPath: '/bin/editor' }],
    [
      { extension: 'md', target: 'internal' },
      { extension: '*.MD', target: 'system' },
    ],
  ])('脏配置整体拒绝且不保留部分规则 %#', (value) => {
    expect(parseFileOpenRules(value)).toBeNull();
    expect(normalizeFileOpenRules(value)).toEqual([]);
  });

  it('绝对应用路径允许空格以及 Windows 驱动器和 UNC', () => {
    for (const applicationPath of [
      'C:\\Program Files\\Reader.exe',
      'C:/Apps/Reader.exe',
      '\\\\host\\apps\\Reader.exe',
    ]) {
      expect(
        parseFileOpenRules([{ extension: '.pdf', target: 'application', applicationPath }])
      ).toEqual([{ extension: '.pdf', target: 'application', applicationPath }]);
    }
    expect(parseFileOpenRules([])).toEqual([]);
  });

  it.each([
    'readme.md',
    'a.markdown',
    'a.mdx',
    'source.ts',
    'a.txt',
    'a.json',
    'a.py',
    'a.sh',
    'README',
    'Dockerfile',
    '.gitignore',
    'image.PNG',
    'image.webp',
    'document.pdf',
  ])('默认在内部预览 %s', (rel) => {
    expect(resolveFileOpenTarget(rel, undefined)).toBe('internal');
  });

  it.each(['a.exe', 'a.MSI', 'a.com', 'a.app', 'a.lnk', 'a.pkg', 'a.dmg', 'a.unknown', 'a.bin'])(
    '危险或未知文件默认只定位 %s',
    (rel) => {
      expect(resolveFileOpenTarget(rel, [])).toBe('reveal');
    }
  );

  it.each(['exe', 'msi', 'com', 'app', 'lnk', 'bat', 'cmd', 'ps1', 'sh', 'py', 'js', 'jar', 'url'])(
    '外部规则不能执行 %s',
    (extension) => {
      for (const target of ['system', 'application'] as const) {
        expect(
          resolveFileOpenTarget(`file.${extension}`, [
            {
              extension,
              target,
              ...(target === 'application' ? { applicationPath: '/bin/editor' } : {}),
            },
          ])
        ).toBe('reveal');
      }
    }
  );

  it('规则覆盖默认，但可执行文件不能切换为内部文本', () => {
    expect(resolveFileOpenTarget('docs/readme.MD', [{ extension: 'md', target: 'reveal' }])).toBe(
      'reveal'
    );
    expect(resolveFileOpenTarget('a.csv', [{ extension: 'csv', target: 'system' }])).toBe('system');
    expect(resolveFileOpenTarget('a.unknown', [{ extension: 'unknown', target: 'internal' }])).toBe(
      'internal'
    );
    expect(resolveFileOpenTarget('a.exe', [{ extension: 'exe', target: 'internal' }])).toBe(
      'reveal'
    );
    expect(resolveFileOpenTarget('a.ps1', [{ extension: 'ps1', target: 'internal' }])).toBe(
      'internal'
    );
  });

  it('隐藏名称与 Windows 尾点空格不掩盖危险扩展名', () => {
    expect(resolveFileOpenTarget('.pif', [{ extension: 'pif', target: 'internal' }])).toBe(
      'reveal'
    );
    expect(resolveFileOpenTarget('danger.exe. ', [{ extension: 'exe', target: 'system' }])).toBe(
      'reveal'
    );
  });

  it('内部查看器仅支持明确已知格式，SVG 只走已有图片链路且未知二进制不当作文本', () => {
    expect(fileOpenViewer('a.unknown')).toBeNull();
    expect(fileOpenViewer('image.svg')).toBe('image');
    expect(resolveFileOpenTarget('image.svg', [])).toBe('internal');
    expect(fileOpenViewer('.env')).toBe('text');
    expect(fileOpenViewer('.gitignore')).toBe('text');
    expect(fileOpenViewer('a.html')).toBe('text');
    expect(fileOpenViewer('a.md')).toBe('markdown');
    expect(fileOpenViewer('a.png')).toBe('image');
    expect(fileOpenViewer('a.pdf')).toBe('pdf');
  });

  it.each(['pif', 'msp', 'msix', 'appx', 'appxbundle', 'msixbundle', 'msu'])(
    'Windows 启动文件和安装包 %s 任何规则都只定位',
    (extension) => {
      for (const target of ['internal', 'system', 'application'] as const) {
        expect(
          resolveFileOpenTarget(`file.${extension}`, [
            {
              extension,
              target,
              ...(target === 'application' ? { applicationPath: 'C:\\Apps\\Reader.exe' } : {}),
            },
          ])
        ).toBe('reveal');
      }
    }
  );
});
