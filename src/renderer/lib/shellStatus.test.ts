import { zhTranslations } from '@shared/i18n';
import { SHELL_FAILURE_KINDS, SHELL_QUIET_MS } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  quietDuration,
  RERUN_TIMEOUT_SEC,
  rerunActions,
  rerunPrompt,
  rerunViaComposer,
  SHELL_FAILURE_HINT_KEYS,
  SHELL_FAILURE_LABEL_KEYS,
  yieldCountdown,
} from './shellStatus';

describe('yieldCountdown', () => {
  it('按让位时刻算剩余时长与剩余比例', () => {
    expect(yieldCountdown(1_000, 46_000, 16_000)).toEqual({
      remainingMs: 30_000,
      fraction: 30 / 45,
    });
  });

  it('到点后归零不为负', () => {
    expect(yieldCountdown(1_000, 46_000, 50_000)).toEqual({ remainingMs: 0, fraction: 0 });
  });

  it('缺开始时间 / 截止时间或截止不晚于开始时不显示', () => {
    expect(yieldCountdown(undefined, 46_000, 2_000)).toBeNull();
    expect(yieldCountdown(1_000, undefined, 2_000)).toBeNull();
    expect(yieldCountdown(5_000, 5_000, 6_000)).toBeNull();
  });
});

describe('quietDuration', () => {
  it('无新输出达到阈值才算静默', () => {
    expect(quietDuration(0, SHELL_QUIET_MS - 1)).toBeNull();
    expect(quietDuration(0, SHELL_QUIET_MS)).toBe(SHELL_QUIET_MS);
    expect(quietDuration(1_000, 31_000, 5_000)).toBe(30_000);
  });
});

describe('失败徽章文案', () => {
  it('每种失败分类都有标签，且都有中文', () => {
    for (const kind of SHELL_FAILURE_KINDS) {
      const key = SHELL_FAILURE_LABEL_KEYS[kind];
      expect(key, kind).toBeTruthy();
      expect(zhTranslations[key], key).toBeTypeOf('string');
    }
    for (const key of Object.values(SHELL_FAILURE_HINT_KEYS)) {
      expect(zhTranslations[key], key).toBeTypeOf('string');
    }
  });

  it('需要终端 / 需要登录 / 截止被杀给出用户下一步', () => {
    expect(SHELL_FAILURE_HINT_KEYS.tty_required).toBeTruthy();
    expect(SHELL_FAILURE_HINT_KEYS.auth_required).toBeTruthy();
    expect(SHELL_FAILURE_HINT_KEYS.deadline).toBeTruthy();
  });
});

describe('失败卡重跑动作', () => {
  it('只有截止被杀的命令给「转后台重跑 / 提高 timeout 重跑」；需要终端、认证与普通失败不给', () => {
    expect(rerunActions({ kind: 'deadline', retryable: true })).toEqual(['background', 'timeout']);
    expect(rerunActions({ kind: 'tty_required', retryable: false })).toEqual([]);
    expect(rerunActions({ kind: 'auth_required', retryable: false })).toEqual([]);
    expect(rerunActions({ kind: 'exit_nonzero', retryable: true, exitCode: 1 })).toEqual([]);
    expect(rerunActions(undefined)).toEqual([]);
  });

  it('重跑提示词带原命令与改动点', () => {
    const t = (key: string, params?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (token, name: string) => String(params?.[name] ?? token));
    const bg = rerunPrompt('background', 'pnpm test', t);
    expect(bg).toContain('background: true');
    expect(bg).toContain('```\npnpm test\n```');
    const longer = rerunPrompt('timeout', 'pnpm test', t);
    expect(longer).toContain(`timeout: ${RERUN_TIMEOUT_SEC}`);
    expect(longer).toContain('pnpm test');
    for (const key of [
      'Rerun in background',
      'Rerun with {{seconds}}s timeout',
      'Rerun this command with background: true:\n\n{{command}}',
      'Rerun this command with timeout: {{seconds}}:\n\n{{command}}',
    ]) {
      expect(zhTranslations[key], key).toBeTypeOf('string');
    }
  });

  it('填入输入框并聚焦（不自动发送）；没有输入框时返回 false 且不聚焦', () => {
    const inserted: string[] = [];
    let focused = 0;
    expect(
      rerunViaComposer(
        'x',
        (text) => {
          inserted.push(text);
          return true;
        },
        () => {
          focused += 1;
          return true;
        }
      )
    ).toBe(true);
    expect(inserted).toEqual(['x']);
    expect(focused).toBe(1);
    expect(
      rerunViaComposer(
        'y',
        () => false,
        () => {
          focused += 1;
          return true;
        }
      )
    ).toBe(false);
    expect(focused).toBe(1);
  });
});
