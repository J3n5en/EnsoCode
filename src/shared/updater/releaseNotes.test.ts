import { describe, expect, it } from 'vitest';
import { normalizeReleaseNotes } from './releaseNotes';

describe('normalizeReleaseNotes', () => {
  it('字符串去首尾空白，空串视为无', () => {
    expect(normalizeReleaseNotes('  <h2>更新</h2>\n')).toBe('<h2>更新</h2>');
    expect(normalizeReleaseNotes('   ')).toBeUndefined();
  });

  it('fullChangelog 数组按版本分段拼接，跳过空条目', () => {
    expect(
      normalizeReleaseNotes([
        { version: '0.2.15', note: '<p>b</p>' },
        { version: '0.2.14', note: null },
        { version: '0.2.13', note: ' a ' },
      ])
    ).toBe('## 0.2.15\n\n<p>b</p>\n\n## 0.2.13\n\na');
  });

  it('脏输入返回 undefined', () => {
    expect(normalizeReleaseNotes(null)).toBeUndefined();
    expect(normalizeReleaseNotes(42)).toBeUndefined();
    expect(normalizeReleaseNotes([{ note: 'x' }, 'y'])).toBeUndefined();
  });
});
