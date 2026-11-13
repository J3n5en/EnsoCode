import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildProbeCommand,
  mergePathSegments,
  parseProbeOutput,
  parseProbeValue,
  seedPathEntries,
} from './shellPath';

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

describe('登录 shell NODE_EXTRA_CA_CERTS 探测', () => {
  const MARK = '__ENSO_PATH__';
  const CA = '__ENSO_CA__';

  it('同一份输出里 PATH 与 CA 各自解析，互不干扰', () => {
    const out = `banner\n${MARK}/a:/b${MARK}${CA}/etc/ssl/corp.pem${CA}\n`;
    expect(parseProbeOutput(out, MARK)).toEqual(['/a', '/b']);
    expect(parseProbeValue(out, CA)).toBe('/etc/ssl/corp.pem');
  });

  it('变量未设置或缺标记时为 undefined，PATH 不受影响', () => {
    const out = `${MARK}/a${MARK}${CA}${CA}`;
    expect(parseProbeValue(out, CA)).toBeUndefined();
    expect(parseProbeValue(`${MARK}/a${MARK}`, CA)).toBeUndefined();
    expect(parseProbeOutput(out, MARK)).toEqual(['/a']);
  });

  it.skipIf(process.platform === 'win32')(
    '真实 shell 执行探测命令：只输出 PATH 与 CA 两个值',
    () => {
      const stdout = execFileSync('/bin/sh', ['-c', buildProbeCommand(MARK, CA)], {
        env: { PATH: '/x/bin:/usr/bin:/bin', NODE_EXTRA_CA_CERTS: '/ca.pem', SECRET_TOKEN: 'sk-1' },
        encoding: 'utf8',
      });
      expect(stdout).toBe(`${MARK}/x/bin:/usr/bin:/bin${MARK}${CA}/ca.pem${CA}`);
      expect(parseProbeOutput(stdout, MARK)).toEqual(['/x/bin', '/usr/bin', '/bin']);
      expect(parseProbeValue(stdout, CA)).toBe('/ca.pem');
    }
  );
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
