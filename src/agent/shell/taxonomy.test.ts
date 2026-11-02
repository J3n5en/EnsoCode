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

  const tty = [
    'sudo: a terminal is required to read the password',
    'the input device is not a TTY',
    'stdin is not a terminal',
    'Inappropriate ioctl for device',
    'open /dev/tty: No such device or address',
    'Error: This command must be run in a terminal',
    'Vim: Warning: Input is not from a terminal',
    'Prompts can not be meaningfully rendered in non-TTY environments',
    'Pseudo-terminal will not be allocated because stdin is not a terminal.',
  ];
  it.each(tty)('需要终端：%s', (tail) => {
    const result = classifyFailure({ exitCode: 1, tail });
    expect(result.kind).toBe('tty_required');
    expect(result.retryable).toBe(false);
    expect(result.hint).toMatch(/non-interactive/i);
  });

  const auth = [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    'git@github.com: Permission denied (publickey).',
    'Host key verification failed.',
    'sudo: a password is required',
    'npm ERR! code ENEEDAUTH',
    'To get started with GitHub CLI, please run:  gh auth login',
  ];
  it.each(auth)('需要认证：%s', (tail) => {
    const result = classifyFailure({ exitCode: 128, tail });
    expect(result.kind).toBe('auth_required');
    expect(result.retryable).toBe(false);
    expect(result.hint).toMatch(/user/i);
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

  it('日志截断与残留进程是成功时的附加告警', () => {
    expect(classifyFailure({ exitCode: 0, tail: 'ok', droppedBytes: 10 }).kind).toBe(
      'output_truncated'
    );
    expect(classifyFailure({ exitCode: 0, tail: 'ok', leftoverPids: [42] }).kind).toBe(
      'leftover_processes'
    );
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
