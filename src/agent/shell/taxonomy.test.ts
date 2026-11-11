import { SHELL_FAILURE_KINDS } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { classifyFailure } from './taxonomy';

describe('classifyFailure', () => {
  it('成功且无异常 → none', () => {
    expect(classifyFailure({ exitCode: 0, tail: 'ok' })).toEqual({
      kind: 'none',
      retryable: true,
      hint: '',
    });
  });

  it('用户停止优先于一切，且不可重试', () => {
    const result = classifyFailure({ exitCode: null, tail: '', stoppedByUser: true });
    expect(result.kind).toBe('stopped_by_user');
    expect(result.retryable).toBe(false);
    expect(result.hint).toMatch(/do not restart/i);
  });

  it('截止时间杀掉 → deadline，提示里带秒数', () => {
    const result = classifyFailure({
      exitCode: null,
      signal: 'SIGTERM',
      tail: '',
      killedByDeadline: true,
      deadlineSec: 300,
    });
    expect(result.kind).toBe('deadline');
    expect(result.hint).toContain('300s');
  });

  // Factory 逆向列表：大小写不敏感子串
  const tty = [
    'not a terminal',
    'no tty present',
    'not a tty',
    'inappropriate ioctl for device',
    'must be run from a terminal',
    'requires a terminal',
    'terminal is not interactive',
    'stdin is not a terminal',
    'stdout is not a terminal',
    'the input device is not a tty',
    'cannot open terminal',
    'terminal not fully functional',
  ];
  it.each(tty)('需要终端（原文）：%s', (pattern) => {
    const result = classifyFailure({
      exitCode: 1,
      tail: `prefix: ${pattern.toUpperCase()} :suffix`,
    });
    expect(result.kind).toBe('tty_required');
    expect(result.retryable).toBe(false);
  });

  it('需要终端的真实报错与下一步', () => {
    const result = classifyFailure({
      exitCode: 1,
      tail: 'sudo: no tty present and no askpass program specified',
    });
    expect(result.kind).toBe('tty_required');
    expect(result.hint).toMatch(/non-interactive/i);
  });

  const auth = [
    'permission denied (publickey)',
    'could not read username',
    'could not read password',
    'host key verification failed',
    'authentication failed',
    'invalid username or password',
    'terminal prompts disabled',
    'no more authentication methods to try',
  ];
  it.each(auth)('需要认证（原文）：%s', (pattern) => {
    const result = classifyFailure({ exitCode: 128, tail: `fatal: ${pattern.toUpperCase()}.` });
    expect(result.kind).toBe('auth_required');
    expect(result.retryable).toBe(false);
  });

  // stdin 关闭 + 硬化 env 下真机实测的原文（macOS）：措辞不含通用子串，不补就退化成 exit_nonzero
  it.each([
    ['tty_required', "error: there was a problem with the editor 'false'"],
    ['tty_required', "    input('q? ')\nEOFError: EOF when reading a line"],
    ['auth_required', 'sudo: a password is required'],
    ['auth_required', 'Enter passphrase for ./k:'],
  ])('stdin 关闭后的真实报错 → %s：%s', (kind, tail) => {
    expect(classifyFailure({ exitCode: 1, tail }).kind).toBe(kind);
  });

  it('编辑器失败不绑定具体编辑器；非 sudo 的 password is required 不判需认证', () => {
    const vim =
      "hint: Waiting for your editor...\nerror: there was a problem with the editor 'vim'";
    expect(classifyFailure({ exitCode: 1, tail: vim }).kind).toBe('tty_required');
    expect(
      classifyFailure({ exitCode: 1, tail: 'Error: a password is required for database "app"' })
        .kind
    ).toBe('exit_nonzero');
  });

  it('需要认证的真实报错与下一步', () => {
    const result = classifyFailure({
      exitCode: 128,
      tail: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    });
    expect(result.kind).toBe('auth_required');
    expect(result.hint).toMatch(/user/i);
  });

  it('不在列表里的相似文本不判 tty/auth', () => {
    // npm legacy 登录读到 EOF 只留裸提示：没有锚点，按行尾冒号猜会误伤大量普通报错
    const tail = 'npm notice Log in on http://127.0.0.1:9/\nUsername:';
    expect(classifyFailure({ exitCode: 1, tail }).kind).toBe('exit_nonzero');
  });

  const ttyExtras = [
    'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper',
    'Pseudo-terminal will not be allocated because stdin is not a terminal.',
    'Input is not from a terminal, can not continue',
  ];
  it.each(ttyExtras)('需要终端（补充措辞）：%s', (tail) => {
    const result = classifyFailure({ exitCode: 1, tail });
    expect(result.kind).toBe('tty_required');
    expect(result.retryable).toBe(false);
  });

  it('程序缺失判 not_found；但 source 配置文件里的 command not found 不算', () => {
    expect(classifyFailure({ exitCode: 127, tail: 'bash: pnpmx: command not found' }).kind).toBe(
      'not_found'
    );
    expect(classifyFailure({ exitCode: 1, tail: 'bash: pnpmx: command not found' }).kind).toBe(
      'not_found'
    );
    // 真实样本：source ~/.zshrc 在 bash 里加载失败，报的是配置文件里的命令不存在
    const sourced = [
      '/Users/john.doe/.zshrc: line 6: autoload: command not found',
      '/Users/john.doe/.zshrc: line 10: compinit: command not found',
      "Error: Oh My Zsh can't be loaded from: . You need to run zsh instead.",
    ].join('\n');
    expect(classifyFailure({ exitCode: 1, tail: sourced }).kind).toBe('exit_nonzero');
    // 即便整体退出码是 127，只要全是配置文件噪音也不判程序缺失
    expect(classifyFailure({ exitCode: 127, tail: sourced }).kind).toBe('exit_nonzero');
  });

  it('只判输出尾部：tty 文本在长输出开头不命中', () => {
    const tail = `not a terminal\n${'x'.repeat(5000)}`;
    expect(classifyFailure({ exitCode: 1, tail }).kind).toBe('exit_nonzero');
  });

  it('退出码 127 / command not found → not_found', () => {
    expect(classifyFailure({ exitCode: 127, tail: 'bash: foo: command not found' }).kind).toBe(
      'not_found'
    );
    expect(
      classifyFailure({
        exitCode: 1,
        tail: "foo : The term 'foo' is not recognized as the name of a cmdlet",
      }).kind
    ).toBe('not_found');
  });

  it('退出码 126 → not_executable', () => {
    expect(classifyFailure({ exitCode: 126, tail: 'Permission denied' }).kind).toBe(
      'not_executable'
    );
  });

  it('二进制输出 → binary_output（成功也提示）', () => {
    const binary = `PK\u0003\u0004\u0000\u0000${'\u0000\u0001\u0002'.repeat(50)}`;
    expect(classifyFailure({ exitCode: 0, tail: binary }).kind).toBe('binary_output');
    expect(classifyFailure({ exitCode: 0, tail: '\u001b[31mred\u001b[0m' }).kind).toBe('none');
  });

  it('日志截断是成功时的附加告警', () => {
    expect(classifyFailure({ exitCode: 0, tail: 'ok', droppedBytes: 10 }).kind).toBe(
      'output_truncated'
    );
  });

  it('不提供无法可靠探测的 leftover_processes 分类', () => {
    expect(SHELL_FAILURE_KINDS).not.toContain('leftover_processes');
    expect(
      classifyFailure({ exitCode: 0, tail: 'ok', leftoverPids: [42] } as Parameters<
        typeof classifyFailure
      >[0]).kind
    ).toBe('none');
  });

  it('普通非零退出 → exit_nonzero，可重试但提示别原样重跑', () => {
    const result = classifyFailure({ exitCode: 2, tail: 'error TS2322: Type mismatch' });
    expect(result).toMatchObject({ kind: 'exit_nonzero', retryable: true });
    expect(result.hint).toContain('exit code 2');
    expect(result.hint).toMatch(/unchanged/);
  });

  it('tty/auth 只在失败时判定：成功输出里出现相似文本不算', () => {
    expect(classifyFailure({ exitCode: 0, tail: 'Permission denied (publickey)' }).kind).toBe(
      'none'
    );
  });
});
