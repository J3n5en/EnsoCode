import { describe, expect, it } from 'vitest';
import {
  buildRemoteCommand,
  buildSshExecArgs,
  buildSshPtyArgs,
  buildSshShellCommand,
  resolveSshTarget,
  shellQuote,
} from './ssh';

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

  it('密码认证:不加 BatchMode,限制只试密码,可选 -p', () => {
    const args = buildSshExecArgs('u@h', 'true', { auth: 'password', port: 2222 });
    const joined = args.join(' ');
    expect(joined).not.toContain('BatchMode');
    expect(joined).toContain('PreferredAuthentications=password');
    expect(args).toContain('-p');
    expect(args).toContain('2222');
    expect(args[args.length - 2]).toBe('u@h');
  });

  it('端口 22 或未设不传 -p;key 默认仍 BatchMode', () => {
    expect(buildSshExecArgs('h', 'true', { auth: 'key', port: 22 }).includes('-p')).toBe(false);
    expect(buildSshExecArgs('h', 'true', {}).join(' ')).toContain('BatchMode=yes');
  });
});

describe('buildSshPtyArgs', () => {
  it('强制 TTY,远端 cd 到项目目录后 exec 登录壳', () => {
    const args = buildSshPtyArgs('user@box', { cwd: '/opt/bot2api', controlPath: '/tmp/cm-%C' });
    expect(args[0]).toBe('-tt');
    expect(args.join(' ')).toContain('ControlMaster=auto');
    expect(args.at(-2)).toBe('user@box');
    expect(args.at(-1)).toContain("cd '/opt/bot2api'");
    expect(args.at(-1)).toContain('exec');
    expect(args.at(-1)).toContain('SHELL');
  });

  it('无 cwd 时仍 exec 登录壳,密码认证不加 BatchMode', () => {
    const args = buildSshPtyArgs('h', { auth: 'password' });
    expect(args[0]).toBe('-tt');
    expect(args.join(' ')).not.toContain('BatchMode');
    expect(args.at(-1)).toContain('exec');
    expect(args.at(-1)).not.toContain('cd ');
  });
});

describe('resolveSshTarget', () => {
  it('有 user 则 user@host,否则原样(含 ssh 别名)', () => {
    expect(resolveSshTarget({ host: 'dev-box', user: 'root' })).toBe('root@dev-box');
    expect(resolveSshTarget({ host: 'jump' })).toBe('jump');
    expect(resolveSshTarget({ host: 'jump', user: '' })).toBe('jump');
  });
});

describe('buildSshShellCommand', () => {
  it('拼成可经本地 shell spawn 的单条命令,逐参 quote', () => {
    const cmd = buildSshShellCommand('user@dev-box', 'npm run dev', {
      cwd: '/srv/my app',
      controlPath: '/tmp/ctl/%C',
    });
    expect(cmd.startsWith('ssh ')).toBe(true);
    expect(cmd).toContain("'ControlPath=/tmp/ctl/%C'");
    expect(cmd).toContain("'user@dev-box'");
    // 远端命令整体作为最后一个参数,内层 quote 嵌套安全
    expect(cmd).toContain(shellQuote("cd '/srv/my app' && bash -lc 'npm run dev'"));
  });
});
