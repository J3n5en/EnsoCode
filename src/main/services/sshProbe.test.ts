import { describe, expect, it } from 'vitest';
import { buildSshProbeArgs, classifySshProbeFailure } from './sshProbe';

describe('buildSshProbeArgs', () => {
  it('BatchMode 免交互 + 超时 + test -d,路径不经 shell 展开', () => {
    const args = buildSshProbeArgs('user@dev-box', '/srv/my app');
    expect(args[args.length - 2]).toBe('user@dev-box');
    // 远端命令为单参数字符串,路径单引号包裹防空格/元字符
    expect(args[args.length - 1]).toBe("test -d '/srv/my app'");
    expect(args).toContain('-o');
    expect(args.join(' ')).toContain('BatchMode=yes');
    expect(args.join(' ')).toContain('ConnectTimeout=');
  });

  it('路径内单引号安全转义', () => {
    const args = buildSshProbeArgs('h', "/srv/it's");
    expect(args[args.length - 1]).toBe(`test -d '/srv/it'\\''s'`);
  });
});

describe('classifySshProbeFailure', () => {
  it('区分 host 不可达 / 认证失败 / 目录不存在', () => {
    expect(classifySshProbeFailure(255, 'ssh: Could not resolve hostname dev-box')).toMatch(
      /连接|reach|resolve/i
    );
    expect(classifySshProbeFailure(255, 'Permission denied (publickey)')).toMatch(
      /密钥|认证|auth/i
    );
    expect(classifySshProbeFailure(1, '')).toMatch(/目录|directory/i);
  });
});
