import { describe, expect, it } from 'vitest';
import {
  buildSshListDirsScript,
  buildSshProbeArgs,
  classifySshProbeFailure,
  parseSshListDirsOutput,
} from './sshProbe';

describe('buildSshProbeArgs', () => {
  it('BatchMode 免交互 + 超时 + test -d,路径不经 shell 展开', () => {
    const args = buildSshProbeArgs('user@dev-box', '/srv/my app');
    expect(args[args.length - 2]).toBe('user@dev-box');
    // 远端命令为单参数字符串,逐参单引号包裹防空格/元字符
    expect(args[args.length - 1]).toBe("'test' '-d' '/srv/my app'");
    expect(args).toContain('-o');
    expect(args.join(' ')).toContain('BatchMode=yes');
    expect(args.join(' ')).toContain('ConnectTimeout=');
  });

  it('路径内单引号安全转义', () => {
    const args = buildSshProbeArgs('h', "/srv/it's");
    expect(args[args.length - 1]).toBe(`'test' '-d' '/srv/it'\\''s'`);
  });
});

describe('buildSshListDirsScript', () => {
  it('缺省从 ~ 起列;指定路径安全 quote;首行 pwd 解析真实绝对路径', () => {
    expect(buildSshListDirsScript()).toBe(
      "cd ~ && pwd && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*'"
    );
    expect(buildSshListDirsScript('/srv/my app')).toBe(
      "cd '/srv/my app' && pwd && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*'"
    );
  });

  it('路径内单引号安全转义', () => {
    expect(buildSshListDirsScript("/it's")).toContain(`'/it'\\''s'`);
  });
});

describe('parseSshListDirsOutput', () => {
  it('首行为解析后路径,后续 ./name 去前缀排序', () => {
    expect(parseSshListDirsOutput('/home/dev\n./work\n./api\n')).toEqual({
      path: '/home/dev',
      dirs: ['api', 'work'],
    });
  });

  it('空目录只有 pwd 行;脏输出(空行/非 ./ 行)丢弃;空输出报错', () => {
    expect(parseSshListDirsOutput('/root\n')).toEqual({ path: '/root', dirs: [] });
    expect(parseSshListDirsOutput('/root\n\ngarbage\n./ok\n')).toEqual({
      path: '/root',
      dirs: ['ok'],
    });
    expect(parseSshListDirsOutput('')).toBeNull();
    expect(parseSshListDirsOutput('relative-not-abs\n./x')).toBeNull();
  });

  it('目录名含空格与 unicode 原样保留', () => {
    const parsed = parseSshListDirsOutput('/srv\n./my app\n./中文目录\n');
    expect(parsed?.path).toBe('/srv');
    expect(parsed?.dirs).toEqual(expect.arrayContaining(['my app', '中文目录']));
    expect(parsed?.dirs).toHaveLength(2);
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
    expect(classifySshProbeFailure(255, 'Permission denied', 'password')).toMatch(/密码/);
    expect(classifySshProbeFailure(1, '')).toMatch(/目录|directory/i);
  });
});
