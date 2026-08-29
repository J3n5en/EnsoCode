import { describe, expect, it } from 'vitest';
import { mergePathSegments, parseProbeOutput, seedPathEntries } from './shellPath';

describe('登录 shell PATH 探测输出解析', () => {
  const MARK = '__ENSO_PATH__';

  it('取成对标记之间的 PATH 并按分隔符拆段', () => {
    const out = `banner line\n${MARK}/opt/homebrew/bin:/usr/bin:/bin${MARK}\n`;
    expect(parseProbeOutput(out, MARK)).toEqual(['/opt/homebrew/bin', '/usr/bin', '/bin']);
  });

  it('剥掉 ANSI 转义序列（花哨 prompt 会污染输出）', () => {
    const out = `\x1b[32m${MARK}/a:/b${MARK}\x1b[0m`;
    expect(parseProbeOutput(out, MARK)).toEqual(['/a', '/b']);
  });

  it('缺标记 / 空 PATH 返回空数组', () => {
    expect(parseProbeOutput('no markers here', MARK)).toEqual([]);
    expect(parseProbeOutput(`${MARK}${MARK}`, MARK)).toEqual([]);
    expect(parseProbeOutput(`${MARK}/a`, MARK)).toEqual([]); // 只有一个标记
  });

  it('段去重且保持首次出现的顺序（PATH 是先到先得）', () => {
    expect(parseProbeOutput(`${MARK}/a:/b:/a:/c${MARK}`, MARK)).toEqual(['/a', '/b', '/c']);
  });
});

describe('PATH 段合并', () => {
  it('shell 段前插且优先于现有段，整体去重', () => {
    expect(mergePathSegments(['/nvm/bin', '/usr/bin'], '/usr/bin:/bin')).toBe(
      '/nvm/bin:/usr/bin:/bin'
    );
  });

  it('无新段时返回原值', () => {
    expect(mergePathSegments([], '/usr/bin')).toBe('/usr/bin');
    expect(mergePathSegments(['/usr/bin'], '/usr/bin:/bin')).toBe('/usr/bin:/bin');
  });
});

describe('打包版 PATH seed', () => {
  it('darwin 包含 homebrew 与用户级 bin', () => {
    const entries = seedPathEntries('darwin', '/Users/me');
    expect(entries).toContain('/opt/homebrew/bin');
    expect(entries).toContain('/usr/local/bin');
    expect(entries).toContain('/Users/me/.local/bin');
  });

  it('无 home 时不产出用户级路径', () => {
    for (const entry of seedPathEntries('darwin', '')) {
      expect(entry.startsWith('/')).toBe(true);
    }
  });
});
