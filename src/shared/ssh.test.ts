import { describe, expect, it } from 'vitest';
import { buildRemoteCommand, buildSshExecArgs, shellQuote } from './ssh';

describe('shellQuote', () => {
  it('单引号包裹,内嵌单引号/换行/UTF-8/空串安全', () => {
    expect(shellQuote('abc')).toBe("'abc'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('a\nb')).toBe("'a\nb'");
    expect(shellQuote('中文 空格')).toBe("'中文 空格'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('$HOME `id` "x"')).toBe(`'$HOME \`id\` "x"'`);
  });
});

describe('buildRemoteCommand', () => {
  it('argv 逐参 quote 拼接;cwd 前缀 cd', () => {
    expect(buildRemoteCommand(['ls', '-la'])).toBe("'ls' '-la'");
    expect(buildRemoteCommand(['cat', '/srv/my app/x.txt'], { cwd: '/srv/app' })).toBe(
      "cd '/srv/app' && 'cat' '/srv/my app/x.txt'"
    );
  });

  it('script 模式:整段脚本经 bash -lc,cwd 前缀', () => {
    expect(buildRemoteCommand('echo hi | wc -l', { cwd: '/srv/app' })).toBe(
      "cd '/srv/app' && bash -lc 'echo hi | wc -l'"
    );
    expect(buildRemoteCommand('echo hi')).toBe("bash -lc 'echo hi'");
  });
});

describe('buildSshExecArgs', () => {
  it('免交互 + ControlMaster 连接复用 + 目标与远端命令收尾', () => {
    const args = buildSshExecArgs('user@dev-box', "'ls'", { controlPath: '/tmp/cm-%C' });
    const joined = args.join(' ');
    expect(joined).toContain('BatchMode=yes');
    expect(joined).toContain('ControlMaster=auto');
    expect(joined).toContain('ControlPath=/tmp/cm-%C');
    expect(joined).toContain('ControlPersist=');
    expect(joined).toContain('ConnectTimeout=');
    expect(args[args.length - 2]).toBe('user@dev-box');
    expect(args[args.length - 1]).toBe("'ls'");
    // host 前有 -- 防以 - 开头的 host 被解析为选项
    expect(args[args.length - 3]).toBe('--');
  });

  it('不带 controlPath 时无 ControlMaster 参数(probe 单次场景)', () => {
    const args = buildSshExecArgs('h', 'test -d /x', {});
    expect(args.join(' ')).not.toContain('ControlMaster');
  });
});
