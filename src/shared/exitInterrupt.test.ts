import { describe, expect, it } from 'vitest';
import {
  EXIT_RECORD_MAX_AGE_MS,
  EXIT_WINDOW_AFTER_MS,
  EXIT_WINDOW_BEFORE_MS,
  exitWindowOf,
  formatExitClock,
  inExitWindow,
  interruptNotice,
  isExitCausedStreamError,
  parseRunningAtExit,
} from './exitInterrupt';

const record = {
  v: 1 as const,
  at: Date.UTC(2024, 0, 1, 12, 0, 0),
  pid: 4242,
  kind: 'update' as const,
  sessions: [{ conversationId: 'c1', turnId: 't1', startedAt: 1, lastMessageIndex: 7 }],
};

describe('parseRunningAtExit', () => {
  it('接受合法记录并丢弃脏会话项', () => {
    expect(parseRunningAtExit(record)?.sessions).toHaveLength(1);
    expect(
      parseRunningAtExit({
        ...record,
        sessions: [{ conversationId: 'c1' }, { conversationId: '' }, { turnId: 'x' }, 3, null],
      })?.sessions
    ).toEqual([{ conversationId: 'c1', startedAt: record.at }]);
  });

  it('坏形状、坏版本、坏时间一律不采信', () => {
    expect(parseRunningAtExit(null)).toBeNull();
    expect(parseRunningAtExit('{}')).toBeNull();
    expect(parseRunningAtExit({ ...record, v: 2 })).toBeNull();
    expect(parseRunningAtExit({ ...record, at: 'now' })).toBeNull();
    expect(parseRunningAtExit({ ...record, pid: 0 })).toBeNull();
    expect(parseRunningAtExit({ ...record, kind: 'crash' })).toBeNull();
    expect(parseRunningAtExit({ ...record, sessions: 'c1' })).toBeNull();
  });
});

describe('exitWindowOf / inExitWindow', () => {
  it('窗口是退出前 30 秒到启动后 10 秒', () => {
    const startupAt = record.at + 60_000;
    const window = exitWindowOf(record, startupAt);
    expect(window).toEqual({
      from: record.at - EXIT_WINDOW_BEFORE_MS,
      to: startupAt + EXIT_WINDOW_AFTER_MS,
    });
    expect(inExitWindow(record.at - EXIT_WINDOW_BEFORE_MS, window)).toBe(true);
    expect(inExitWindow(record.at, window)).toBe(true);
    expect(inExitWindow(startupAt + EXIT_WINDOW_AFTER_MS, window)).toBe(true);
    expect(inExitWindow(record.at - EXIT_WINDOW_BEFORE_MS - 1, window)).toBe(false);
    expect(inExitWindow(startupAt + EXIT_WINDOW_AFTER_MS + 1, window)).toBe(false);
  });

  it('窗口外的同一类错误仍按失败处理', () => {
    const startupAt = record.at + 60_000;
    const window = exitWindowOf(record, startupAt);
    const error = 'OpenAI Responses stream ended before a terminal response event';
    expect(isExitCausedStreamError(error)).toBe(true);
    // 时间点在窗口外：调用方据此不归到中断
    expect(inExitWindow(startupAt + 10 * 60_000, window)).toBe(false);
  });
});

describe('isExitCausedStreamError', () => {
  it('认退出导致的断流与断连', () => {
    for (const text of [
      'OpenAI Responses stream ended before a terminal response event',
      'read ECONNRESET',
      'socket hang up',
      'other side closed',
      'Error: aborted (UND_ERR_SOCKET)',
      // 退出收尾中止模型请求：undici fetch 的 AbortError 与 pi-ai 重试等待被中止
      'This operation was aborted',
      'Request aborted',
    ])
      expect(isExitCausedStreamError(text)).toBe(true);
  });

  it('不认真正的模型/鉴权错误', () => {
    for (const text of [
      '401 invalid api key',
      '429 rate limit exceeded',
      '500 internal server error',
      'context length exceeded',
      'Request aborted by user',
      '',
    ])
      expect(isExitCausedStreamError(text)).toBe(false);
  });
});

describe('interruptNotice', () => {
  it('中文提示带关闭时刻、原因与重试引导', () => {
    const text = interruptNotice({
      at: new Date(2024, 0, 1, 20, 26, 52).getTime(),
      kind: 'update',
      unfinishedTools: [],
      lang: 'zh',
    });
    expect(text).toContain('20:26:52');
    expect(text).toContain('安装更新');
    expect(text).toContain('重试');
  });

  it('有未完成工具调用时点名可能只执行了一半', () => {
    const text = interruptNotice({
      at: 0,
      kind: 'quit',
      unfinishedTools: ['bash', 'apply_patch'],
      lang: 'zh',
    });
    expect(text).toContain('bash');
    expect(text).toContain('apply_patch');
    expect(text).toContain('一半');
  });

  it('英文文案同样带原因与工具提示', () => {
    const text = interruptNotice({ at: 0, kind: 'quit', unfinishedTools: ['bash'], lang: 'en' });
    expect(text).toContain('closed');
    expect(text).toContain('bash');
    expect(text).toContain('retry');
  });
});

describe('formatExitClock', () => {
  it('只给本地钟点，便于直接对上', () => {
    expect(formatExitClock(new Date(2024, 0, 1, 9, 5, 3).getTime())).toBe('09:05:03');
  });
});

describe('EXIT_RECORD_MAX_AGE_MS', () => {
  it('陈旧记录只保留一天', () => {
    expect(EXIT_RECORD_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
