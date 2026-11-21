import { describe, expect, it } from 'vitest';
import {
  extractPullRef,
  extractReportImagePaths,
  parseNumstat,
  parsePullView,
  reportTextForView,
} from './doneReport';

describe('extractReportImagePaths', () => {
  it('认出汇报里的绝对路径、markdown 图片与 file:// 地址，按出现顺序去重', () => {
    const text = [
      '截图：/tmp/secretary-done-report-desk.png，手机版见 `/tmp/shot mobile.png`',
      '![结果](/private/var/folders/ab/T/a.JPG)',
      '再看一次 /tmp/secretary-done-report-desk.png。',
      '链接 file:///tmp/%E5%9B%BE.webp 和 (/Users/me/project/worktree/x/docs/b.gif)',
    ].join('\n');
    expect(extractReportImagePaths(text)).toEqual([
      '/tmp/secretary-done-report-desk.png',
      '/tmp/shot mobile.png',
      '/private/var/folders/ab/T/a.JPG',
      '/tmp/图.webp',
      '/Users/me/project/worktree/x/docs/b.gif',
    ]);
  });

  it('网址、非图片扩展名和半截扩展名都不算', () => {
    const text =
      'https://github.com/o/r/blob/main/a.png /tmp/a.png.bak /tmp/notes.txt //cdn/x.png /tmp/b.svg';
    expect(extractReportImagePaths(text)).toEqual([]);
  });
});

describe('extractPullRef', () => {
  it('优先认 PR 链接，没有链接再认带 PR 字样的号', () => {
    expect(extractPullRef('PR: https://github.com/J3n5en/enso-code/pull/342 已开')).toEqual({
      url: 'https://github.com/J3n5en/enso-code/pull/342',
      number: 342,
    });
    expect(extractPullRef('已开 PR #57，等你看截图')).toEqual({ number: 57 });
    expect(extractPullRef('修了 issue #12')).toBeNull();
    expect(extractPullRef(undefined)).toBeNull();
  });
});

describe('parseNumstat', () => {
  it('文件名与增删行数，二进制记 null，重命名取新路径，坏行跳过', () => {
    const out = [
      '12\t3\tsrc/a.ts',
      '-\t-\tdocs/shot.png',
      '4\t0\tsrc/{old => new}/b.ts',
      '1\t1\tlib/c.ts => lib/d.ts',
      'garbage',
      '',
    ].join('\n');
    expect(parseNumstat(out)).toEqual([
      { path: 'src/a.ts', additions: 12, deletions: 3 },
      { path: 'docs/shot.png', additions: null, deletions: null },
      { path: 'src/new/b.ts', additions: 4, deletions: 0 },
      { path: 'lib/d.ts', additions: 1, deletions: 1 },
    ]);
  });
});

describe('parsePullView', () => {
  it('合并了才给 squash 后的 sha；文件只取路径与行数', () => {
    const out = JSON.stringify({
      number: 342,
      url: 'https://github.com/o/r/pull/342',
      state: 'MERGED',
      mergeCommit: { oid: 'abcdef0123456789abcdef0123456789abcdef01' },
      files: [{ path: 'src/a.ts', additions: 5, deletions: 2, extra: 'x' }, { bad: true }],
    });
    expect(parsePullView(out)).toEqual({
      pr: {
        number: 342,
        url: 'https://github.com/o/r/pull/342',
        state: 'MERGED',
        mergeSha: 'abcdef0123456789abcdef0123456789abcdef01',
      },
      files: [{ path: 'src/a.ts', additions: 5, deletions: 2 }],
    });
    const open = parsePullView(
      JSON.stringify({
        number: 9,
        url: 'https://github.com/o/r/pull/9',
        state: 'OPEN',
        mergeCommit: { oid: 'abcdef0' },
        files: [],
      })
    );
    expect(open?.pr).toEqual({ number: 9, url: 'https://github.com/o/r/pull/9', state: 'OPEN' });
    expect(parsePullView('not json')).toBeNull();
    expect(parsePullView(JSON.stringify({ number: 'x' }))).toBeNull();
  });
});

describe('reportTextForView', () => {
  it('本地图片的 markdown 嵌入换成文件名，网图与普通链接不动', () => {
    expect(
      reportTextForView(
        '看图 ![桌面](/tmp/a/desk.png) 与 ![](file:///tmp/m.png) ![logo](https://x.dev/l.png) [PR](https://github.com/o/r/pull/1)'
      )
    ).toBe(
      '看图 `desk.png` 与 `m.png` ![logo](https://x.dev/l.png) [PR](https://github.com/o/r/pull/1)'
    );
  });
});
