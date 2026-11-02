import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ShellFailureBadge, ShellFailureBar } from './ShellStatus';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (token, name: string) => String(params?.[name] ?? token)),
  }),
}));

describe('ShellFailureBadge', () => {
  it('非零退出显示退出码，其它分类显示标签', () => {
    expect(
      renderToStaticMarkup(
        createElement(ShellFailureBadge, {
          failure: { kind: 'exit_nonzero', retryable: true, exitCode: 2 },
        })
      )
    ).toContain('Exit 2');
    const tty = renderToStaticMarkup(
      createElement(ShellFailureBadge, { failure: { kind: 'tty_required', retryable: false } })
    );
    expect(tty).toContain('Needs terminal');
    expect(tty).toContain('data-shell-failure="tty_required"');
  });
});

describe('ShellFailureBar', () => {
  it('状态条带分类、用户下一步与复制命令', () => {
    const html = renderToStaticMarkup(
      createElement(ShellFailureBar, {
        failure: { kind: 'auth_required', retryable: false, exitCode: 128 },
        command: 'git push',
      })
    );
    expect(html).toContain('data-shell-status="auth_required"');
    expect(html).toContain('Needs login');
    expect(html).toContain('Sign in from your own terminal');
    expect(html).toContain('Copy command');
  });

  it('没有失败时不渲染', () => {
    expect(
      renderToStaticMarkup(createElement(ShellFailureBar, { failure: undefined, command: 'ls' }))
    ).toBe('');
  });

  it('截止被杀：带「转后台重跑」「提高 timeout 重跑」两个动作', () => {
    const html = renderToStaticMarkup(
      createElement(ShellFailureBar, {
        failure: { kind: 'deadline', retryable: true },
        command: 'pnpm test',
      })
    );
    expect(html).toContain('data-shell-rerun="background"');
    expect(html).toContain('data-shell-rerun="timeout"');
    expect(html).toContain('Rerun in background');
    expect(html).toContain('Rerun with 600s timeout');
  });

  it('需要终端：不给重跑动作，只有复制命令', () => {
    const html = renderToStaticMarkup(
      createElement(ShellFailureBar, {
        failure: { kind: 'tty_required', retryable: false },
        command: 'sudo apt install x',
      })
    );
    expect(html).not.toContain('data-shell-rerun');
    expect(html).toContain('Copy command');
  });
});
