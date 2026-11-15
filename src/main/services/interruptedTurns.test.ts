import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectedMessage } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  interruptedTurnReason,
  readInterruptedTurnFacts,
  recoverInterruptedTurns,
} from './interruptedTurns';
import { runningAtExitPath, writeRunningAtExit } from './runningAtExit';

const STREAM_ERROR = 'OpenAI Responses stream ended before a terminal response event';

function assistant(parts: ProjectedMessage['content'], extra: Partial<ProjectedMessage> = {}) {
  return { role: 'assistant', content: parts, ...extra } satisfies ProjectedMessage;
}

function toolCall(id: string, name: string) {
  return { type: 'toolCall' as const, id, name, arguments: {} };
}

describe('recoverInterruptedTurns', () => {
  let dir: string;
  const messages: Record<string, ProjectedMessage[]> = {};
  const readMessages = async (conversationId: string): Promise<ProjectedMessage[] | null> =>
    messages[conversationId] ?? null;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'enso-interrupted-turns-'));
    for (const key of Object.keys(messages)) delete messages[key];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('正常退出：标成 interrupted，带上时刻、原因与未完成工具', async () => {
    messages.c1 = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistant([toolCall('call-1', 'bash'), toolCall('call-2', 'apply_patch')], {
        timestamp: 1_000,
      }),
      { role: 'toolResult', content: [], toolCallId: 'call-1', toolName: 'bash' },
    ];
    writeRunningAtExit(dir, {
      pid: 4242,
      kind: 'update',
      at: 2_000,
      sessions: [{ conversationId: 'c1', turnId: 't1', startedAt: 900, lastMessageIndex: 2 }],
    });
    const turns = await recoverInterruptedTurns({
      agentDir: dir,
      startupAt: 5_000,
      now: 5_000,
      pid: 9,
      pidAlive: () => false,
      readMessages,
    });
    expect(turns).toEqual([
      {
        conversationId: 'c1',
        turnId: 't1',
        startedAt: 900,
        exitAt: 2_000,
        kind: 'update',
        lastMessageIndex: 2,
        unfinishedTools: ['apply_patch'],
      },
    ]);
    // 记录只消费一次
    expect(existsSync(runningAtExitPath(dir))).toBe(false);
  });

  it('SIGKILL：只有心跳留下的记录、进程已不在，也能识别', async () => {
    messages.c1 = [assistant([{ type: 'text', text: 'half' }], { timestamp: 1_500 })];
    writeRunningAtExit(dir, {
      pid: 4242,
      kind: 'quit',
      at: 1_600,
      sessions: [{ conversationId: 'c1', startedAt: 1_000 }],
    });
    const turns = await recoverInterruptedTurns({
      agentDir: dir,
      startupAt: 9_000,
      now: 9_000,
      pid: 9,
      pidAlive: () => false,
      readMessages,
    });
    expect(turns.map((turn) => turn.conversationId)).toEqual(['c1']);
    expect(turns[0].exitAt).toBe(1_600);
  });

  it('记录里的进程还活着就不算中断（记录也不删）', async () => {
    writeRunningAtExit(dir, {
      pid: 4242,
      kind: 'quit',
      at: 1_600,
      sessions: [{ conversationId: 'c1', startedAt: 1_000 }],
    });
    expect(
      await recoverInterruptedTurns({
        agentDir: dir,
        startupAt: 9_000,
        now: 9_000,
        pid: 9,
        pidAlive: () => true,
        readMessages,
      })
    ).toEqual([]);
  });

  it('过旧记录不采信，也不误标', async () => {
    writeRunningAtExit(dir, {
      pid: 4242,
      kind: 'quit',
      at: 1_000,
      sessions: [{ conversationId: 'c1', startedAt: 1_000 }],
    });
    expect(
      await recoverInterruptedTurns({
        agentDir: dir,
        startupAt: 3 * 24 * 60 * 60 * 1000,
        now: 3 * 24 * 60 * 60 * 1000,
        pid: 9,
        pidAlive: () => false,
        readMessages,
      })
    ).toEqual([]);
  });

  it('退出窗口内的断流错误归到中断并被吞掉', async () => {
    messages.c1 = [
      assistant([{ type: 'text', text: 'half' }], {
        errorMessage: STREAM_ERROR,
        timestamp: 1_990,
      }),
    ];
    writeRunningAtExit(dir, {
      pid: 4242,
      kind: 'quit',
      at: 2_000,
      sessions: [{ conversationId: 'c1', startedAt: 1_000 }],
    });
    const [turn] = await recoverInterruptedTurns({
      agentDir: dir,
      startupAt: 5_000,
      now: 5_000,
      pid: 9,
      pidAlive: () => false,
      readMessages,
    });
    expect(turn.suppressedError).toBe(STREAM_ERROR);
  });

  it('窗口外的同一类错误仍留给会话按失败处理', async () => {
    messages.c1 = [
      assistant([{ type: 'text', text: 'half' }], {
        errorMessage: STREAM_ERROR,
        timestamp: 10 * 60 * 1000,
      }),
    ];
    writeRunningAtExit(dir, {
      pid: 4242,
      kind: 'quit',
      at: 2_000,
      sessions: [{ conversationId: 'c1', startedAt: 1_000 }],
    });
    const [turn] = await recoverInterruptedTurns({
      agentDir: dir,
      startupAt: 5_000,
      now: 5_000,
      pid: 9,
      pidAlive: () => false,
      readMessages,
    });
    expect(turn.suppressedError).toBeUndefined();
  });

  it('非退出类错误（鉴权/限流）不吞', async () => {
    messages.c1 = [assistant([], { errorMessage: '401 invalid api key', timestamp: 1_990 })];
    writeRunningAtExit(dir, {
      pid: 4242,
      kind: 'quit',
      at: 2_000,
      sessions: [{ conversationId: 'c1', startedAt: 1_000 }],
    });
    const [turn] = await recoverInterruptedTurns({
      agentDir: dir,
      startupAt: 5_000,
      now: 5_000,
      pid: 9,
      pidAlive: () => false,
      readMessages,
    });
    expect(turn.suppressedError).toBeUndefined();
  });

  it('恢复后留下本次启动的中断事实，供秘书同步读原因；下次启动清掉', async () => {
    messages.c1 = [assistant([toolCall('call-1', 'bash')], { timestamp: 1_990 })];
    writeRunningAtExit(dir, {
      pid: 4242,
      kind: 'update',
      at: 2_000,
      sessions: [{ conversationId: 'c1', startedAt: 1_000 }],
    });
    await recoverInterruptedTurns({
      agentDir: dir,
      startupAt: 5_000,
      now: 5_000,
      pid: 9,
      pidAlive: () => false,
      readMessages,
    });
    expect(readInterruptedTurnFacts(dir)).toHaveLength(1);
    expect(interruptedTurnReason(dir, 'c1')).toContain('安装更新');
    expect(interruptedTurnReason(dir, 'c1')).toContain('bash');
    expect(interruptedTurnReason(dir, 'other')).toBeUndefined();

    // 下一次启动没有退出记录：旧事实不能留着误导秘书
    await recoverInterruptedTurns({
      agentDir: dir,
      startupAt: 9_000,
      now: 9_000,
      pid: 9,
      pidAlive: () => false,
      readMessages,
    });
    expect(readInterruptedTurnFacts(dir)).toEqual([]);
  });
});
