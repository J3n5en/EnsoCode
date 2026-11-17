import { describe, expect, it } from 'vitest';
import {
  SHELL_READ_HINT,
  SHELL_SLEEP_HINT,
  SHELL_TIMEOUT_HINT,
  shellFailureHeadline,
  skipShellHints,
} from './shellHints';

describe('skipShellHints', () => {
  it('去掉开头连续的多条提示和紧随的空行', () => {
    const text = `${SHELL_READ_HINT}\n${SHELL_SLEEP_HINT}\n${SHELL_TIMEOUT_HINT}\n\nreal output`;
    expect(skipShellHints(text)).toBe('real output');
  });

  it('提示不在开头时原样返回；提示后为空也原样返回', () => {
    expect(skipShellHints(`ok\n${SHELL_READ_HINT}`)).toBe(`ok\n${SHELL_READ_HINT}`);
    expect(skipShellHints(SHELL_TIMEOUT_HINT)).toBe(SHELL_TIMEOUT_HINT);
  });
});

describe('shellFailureHeadline', () => {
  it('跳过提示和前面成功命令的输出，取退出状态前的报错行', () => {
    const output = [
      SHELL_READ_HINT,
      '',
      'ok 1 file changed, 123 deletions(-)',
      'ls: src/a.ts: No such file or directory',
      '',
      'Command exited with code 1',
      '',
      '[exit_nonzero] The command failed (exit code 1).',
    ].join('\n');
    expect(shellFailureHeadline(output)).toBe('ls: src/a.ts: No such file or directory');
  });

  it('附注行不算报错，pnpm 的失败汇总行可以当标题', () => {
    const output = [
      SHELL_TIMEOUT_HINT,
      '',
      '> enso@1.0.0 lint',
      ' ELIFECYCLE  Command failed with exit code 1.',
      '[full output: rtk recall 0123456789ab]',
      '',
      'Command exited with code 1',
    ].join('\n');
    expect(shellFailureHeadline(output)).toBe('ELIFECYCLE  Command failed with exit code 1.');
  });

  it('输出里没有像报错的行时，标题就是退出状态本身', () => {
    const output = `${SHELL_READ_HINT}\n\nimport { a } from './a';\nlog(error.message);\n0\n\nCommand exited with code 1`;
    expect(shellFailureHeadline(output)).toBe('Command exited with code 1');
  });

  it('超时和中断以状态行为准，不被输出里的 error 日志顶掉', () => {
    const timedOut =
      'warn: error budget low\n\nCommand timed out after 15 seconds\n\n[deadline] killed';
    expect(shellFailureHeadline(timedOut)).toBe('Command timed out after 15 seconds');
    expect(shellFailureHeadline('error: x\n\nCommand aborted')).toBe('Command aborted');
  });

  it('没有退出状态行时取第一条非空行', () => {
    expect(shellFailureHeadline('\nDo not background a foreground command\nmore')).toBe(
      'Do not background a foreground command'
    );
  });
});
