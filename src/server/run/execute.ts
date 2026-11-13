import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import {
  applyHeadlessGoalSignal,
  emptyHeadlessRuntime,
  type HeadlessSessionRuntime,
} from '@shared/pair/headlessQueue';
import type {
  AgentWorkerEvent,
  ProjectedMessage,
  SessionIdentity,
  ThinkingLevel,
} from '@shared/types/agent';
import { THINKING_LEVELS } from '@shared/types/agent';
import {
  abortSession,
  agentDataDir,
  promptSession,
  releaseParentSession,
  setAgentEventListener,
  spawnSession,
  startAgentWorker,
  stopAgentWorker,
  stopAgentWorkerForQuit,
} from '../../main/services/agentHost';
import { readySecureStores } from '../../main/services/secureStores';
import { loadUsageModelPricing } from '../../main/services/usage/aliases';
import { disabledToolsForRun, type RunArgs } from './args';
import { initialPrompt, nextGoalStep } from './goalDrive';
import {
  type RunResult,
  type RunStatus,
  RunTranscript,
  renderResult,
  type StreamRecord,
  type TranscriptMessage,
  type TranscriptPart,
} from './output';
import { resolveRunProvider, settingsProviders, writeProviderSettings } from './provider';
import { findLatestSessionForCwd, findSessionById, readRunLast, writeRunLast } from './sessions';
import { UsageLogWriter, usageCallRecord, usageSummaryRecord } from './usageLog';

export interface RunIO {
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  readStdin(): string;
  signal: AbortSignal;
}

const STARTUP_TIMEOUT_MS = 60_000;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function resolvePrompt(
  args: RunArgs,
  io: RunIO
): { ok: true; text: string } | { ok: false; error: string } {
  if (args.prompt === undefined) return { ok: true, text: '' };
  if (args.prompt === '-') {
    const text = io.readStdin();
    if (!text.trim()) return { ok: false, error: '--prompt - 读到空标准输入' };
    return { ok: true, text };
  }
  if (args.prompt.startsWith('@')) {
    const file = path.resolve(args.cwd, args.prompt.slice(1));
    try {
      const text = readFileSync(file, 'utf8');
      if (!text.trim()) return { ok: false, error: `提示文件是空的: ${file}` };
      return { ok: true, text };
    } catch {
      return { ok: false, error: `读不到提示文件 ${file}` };
    }
  }
  return { ok: true, text: args.prompt };
}

function toTranscript(message: ProjectedMessage): TranscriptMessage {
  return {
    role: message.role,
    content: message.content.flatMap((part): TranscriptPart[] => {
      if (part.type === 'text') return [{ type: 'text', text: part.text }];
      if (part.type === 'toolCall') {
        return [{ type: 'toolCall', id: part.id, name: part.name, arguments: part.arguments }];
      }
      return [];
    }),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.isError ? { isError: true } : {}),
    ...(message.stopReason ? { stopReason: message.stopReason } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
  };
}

function configFailure(error: string): boolean {
  return /unavailable|assistant|provider|model|api key|select an|invalid|missing/i.test(error);
}

interface Stop {
  code: number;
  status: RunStatus;
  reason: string;
  error?: string;
}

function goalStop(runtime: HeadlessSessionRuntime): Stop {
  const goal = runtime.goal;
  if (!goal || goal.status === 'completed') {
    return { code: 0, status: 'success', reason: goal ? 'completed' : 'finished' };
  }
  if (goal.status === 'blocked') return { code: 3, status: 'blocked', reason: 'goal-blocked' };
  if (goal.status === 'waiting') return { code: 3, status: 'waiting', reason: 'goal-waiting' };
  if (goal.note?.startsWith('no progress')) {
    return { code: 4, status: 'exhausted', reason: 'no-progress' };
  }
  return { code: 4, status: 'exhausted', reason: 'auto-turns-exhausted' };
}

export async function executeRun(args: RunArgs, io: RunIO): Promise<number> {
  const fail = (error: string): number => {
    io.writeStderr(`${error}\n`);
    return 2;
  };
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let cwd: string;
  try {
    cwd = path.resolve(args.cwd);
    if (!statSync(cwd).isDirectory()) return fail(`--cwd 不是目录: ${cwd}`);
  } catch {
    return fail(`--cwd 不存在: ${path.resolve(args.cwd)}`);
  }
  const prompt = resolvePrompt({ ...args, cwd }, io);
  if (!prompt.ok) return fail(prompt.error);
  if (!prompt.text.trim() && !args.goal) return fail('需要 --prompt，或 --goal / --target');

  // 下面几处写盘失败（--data-dir / --usage-log 不可写）都属于配置错误：按约定退出码 2，
  // 不能任由异常冒成未处理 rejection（码 1 + 堆栈）
  let dataDir: string;
  try {
    dataDir = app.getPath('userData');
  } catch (error) {
    return fail(`数据目录不可用: ${reason(error)}`);
  }
  const settingsFile = path.join(dataDir, 'settings.json');
  const existing = readJson(settingsFile);
  const resolved = resolveRunProvider(
    {
      providerId: args.providerId,
      modelId: args.modelId,
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      api: args.api,
    },
    settingsProviders(existing)
  );
  if (!resolved.ok) return fail(resolved.error);
  if (resolved.value.changed) {
    try {
      writeProviderSettings(settingsFile, resolved.value.providers);
    } catch (error) {
      return fail(`写不进 ${settingsFile}: ${reason(error)}`);
    }
  }

  const sessionDir = path.join(agentDataDir(), 'sessions');
  const lastFile = path.join(agentDataDir(), 'run-last.json');
  let sessionId = randomUUID();
  let resumeFile: string | undefined;
  if (args.resume) {
    const found = findSessionById(sessionDir, args.resume);
    if (!found) return fail(`找不到会话 ${args.resume}`);
    sessionId = found.sessionId as typeof sessionId;
    resumeFile = found.sessionFile;
  } else if (args.continue) {
    const remembered = readRunLast(lastFile)[cwd];
    const found =
      (remembered && findSessionById(sessionDir, remembered.sessionId)) ||
      findLatestSessionForCwd(sessionDir, cwd);
    if (!found) return fail(`当前目录没有可继续的会话: ${cwd}`);
    sessionId = found.sessionId as typeof sessionId;
    resumeFile = found.sessionFile;
  }

  const effort = args.reasoningEffort;
  const thinkingLevel =
    effort &&
    effort !== 'off' &&
    effort !== 'none' &&
    (THINKING_LEVELS as readonly string[]).includes(effort)
      ? (effort as ThinkingLevel)
      : undefined;
  const identity: SessionIdentity = { sessionId, generation: randomUUID() };
  const transcript = new RunTranscript(resolved.value.providerId, loadUsageModelPricing());
  const usageFile = args.usageLog ? path.resolve(cwd, args.usageLog) : undefined;
  let usageLog: UsageLogWriter;
  try {
    usageLog = new UsageLogWriter(usageFile);
  } catch (error) {
    return fail(`写不了用量日志 ${usageFile}: ${reason(error)}`);
  }
  const startedAt = Date.now();
  let runtime: HeadlessSessionRuntime = {
    ...emptyHeadlessRuntime(),
    ...(args.goal ? { goal: { text: args.goal, status: 'active' as const, autoTurns: 0 } } : {}),
  };
  let lastOutput = '';
  let noProgressRuns = 0;
  let turns = 0;
  let sessionFile: string | undefined = resumeFile;
  let ready = false;
  let spawned = false;
  let settled = false;
  let loggedCalls = 0;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;

  const stderr = (line: string) => io.writeStderr(line.endsWith('\n') ? line : `${line}\n`);
  const emit = (records: StreamRecord[]) => {
    if (args.outputFormat === 'stream-json') {
      for (const record of records) io.writeStdout(`${JSON.stringify(record)}\n`);
    }
    while (loggedCalls < transcript.calls.length) {
      const call = transcript.calls[loggedCalls];
      if (call) usageLog.write(usageCallRecord(call));
      loggedCalls += 1;
    }
  };

  const writeResult = (stop: Stop) => {
    const usage = transcript.usage();
    const goal = runtime.goal;
    const finalMessage = transcript.finalText || goal?.note || '';
    const result: RunResult = {
      status: stop.status,
      exitCode: stop.code,
      exitReason: stop.reason,
      sessionId,
      finalMessage,
      turns,
      durationMs: Date.now() - startedAt,
      usage,
      ...(sessionFile ? { sessionFile } : {}),
      ...(goal ? { goal: { status: goal.status, ...(goal.note ? { note: goal.note } : {}) } } : {}),
    };
    if (stop.error) stderr(stop.error);
    if (args.outputFormat === 'stream-json') {
      io.writeStdout(`${JSON.stringify({ type: 'result', ...result })}\n`);
    } else if (spawned || stop.code !== 2) {
      io.writeStdout(renderResult(result, args.outputFormat === 'json' ? 'json' : 'text'));
    }
    usageLog.write(usageSummaryRecord(transcript.calls, new Date().toISOString()));
  };

  // MCP OAuth token 等凭据要先解密进内存，worker 起会话时才带得上
  await readySecureStores();
  return await new Promise<number>((resolve) => {
    const cleanup = async () => {
      if (spawned) {
        abortSession(identity);
        await Promise.race([
          releaseParentSession(identity),
          new Promise<void>((done) => setTimeout(done, 3_000)),
        ]);
      }
      await stopAgentWorkerForQuit(3_000);
      stopAgentWorker();
    };
    const stop = (next: Stop) => {
      if (settled) return;
      settled = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (stopTimer) clearTimeout(stopTimer);
      emit(transcript.flushTurn());
      writeResult(next);
      void cleanup()
        .catch((error: unknown) => stderr(error instanceof Error ? error.message : String(error)))
        .finally(() => resolve(next.code));
    };

    if (io.signal.aborted) {
      stop({ code: 130, status: 'interrupted', reason: 'interrupted' });
      return;
    }
    io.signal.addEventListener(
      'abort',
      () => stop({ code: 130, status: 'interrupted', reason: 'interrupted' }),
      { once: true }
    );
    if (args.timeoutMs) {
      stopTimer = setTimeout(
        () => stop({ code: 124, status: 'timeout', reason: 'timeout' }),
        args.timeoutMs
      );
    }
    startupTimer = setTimeout(
      () => {
        if (ready) return;
        stop({ code: 1, status: 'error', reason: 'worker-start-timeout' });
      },
      Math.min(args.timeoutMs ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS)
    );

    const relate = (event: AgentWorkerEvent): { key: string; parent: boolean } | null => {
      if (!('identity' in event) || !event.identity) return null;
      const current = event.identity;
      if ('parent' in current && current.parent.sessionId === sessionId) {
        return { key: current.sessionId, parent: false };
      }
      if (current.sessionId === sessionId) return { key: sessionId, parent: true };
      return null;
    };

    setAgentEventListener((event) => {
      try {
        if (settled) return;
        if (event.type === 'worker-exited') {
          stop({ code: 1, status: 'error', reason: 'worker-exited' });
          return;
        }
        const who = relate(event);
        if (!who) return;
        if (event.type === 'message-upsert') {
          emit(
            transcript.ingest(`${who.key}:${event.index}`, toTranscript(event.message), who.parent)
          );
          return;
        }
        if (!who.parent) return;
        if (event.type === 'goal-signal') {
          runtime = applyHeadlessGoalSignal(runtime, event.kind, event.note);
          emit([{ type: 'goal', kind: event.kind, note: event.note }]);
          return;
        }
        if (event.type === 'status') {
          runtime = { ...runtime, status: event.status, started: true };
          emit([
            {
              type: 'status',
              status: event.status,
              ...(event.error ? { error: event.error } : {}),
            },
          ]);
          // 通用异常只发 status failed，之后不保证还有 turn-failed；不收口会一直挂到超时
          if (event.status === 'failed') {
            turns += 1;
            emit(transcript.flushTurn());
            stop({ code: 1, status: 'error', reason: 'turn-failed', error: event.error });
          }
          return;
        }
        if (event.type === 'parent-rejected') {
          const code = configFailure(event.reason) ? 2 : 1;
          stop({
            code,
            status: 'error',
            reason: code === 2 ? 'config' : 'rejected',
            error: event.reason,
          });
          return;
        }
        if (event.type === 'parent-ready') {
          spawned = true;
          ready = true;
          sessionFile = event.sessionFile;
          if (startupTimer) clearTimeout(startupTimer);
          writeRunLast(lastFile, cwd, { sessionId, sessionFile });
          const text = initialPrompt(prompt.text, args.goal);
          if (runtime.goal) runtime = { ...runtime, goal: { ...runtime.goal, autoTurns: 1 } };
          const sent = promptSession(identity, text);
          if (!sent.ok) {
            stop({ code: 1, status: 'error', reason: 'prompt-rejected', error: sent.error });
          }
          return;
        }
        if (event.type === 'turn-failed') {
          turns += 1;
          emit(transcript.flushTurn());
          stop({ code: 1, status: 'error', reason: 'turn-failed', error: event.error });
          return;
        }
        if (event.type !== 'turn-completed' || event.aborted) {
          if (event.type === 'turn-completed') {
            turns += 1;
            emit(transcript.flushTurn());
            stop({ code: 1, status: 'error', reason: 'aborted' });
          }
          return;
        }
        turns += 1;
        emit(transcript.flushTurn());
        if (!args.goal) {
          stop({ code: 0, status: 'success', reason: 'finished' });
          return;
        }
        const step = nextGoalStep({
          runtime,
          assistantText: transcript.finalText,
          lastOutput,
          noProgressRuns,
          autoTurnLimit: args.autoTurns,
        });
        runtime = step.runtime;
        lastOutput = step.lastOutput;
        noProgressRuns = step.noProgressRuns;
        if (step.deliver && runtime.goal?.status === 'active') {
          const sent = promptSession(identity, step.deliver.text);
          if (!sent.ok)
            stop({ code: 1, status: 'error', reason: 'prompt-rejected', error: sent.error });
          return;
        }
        stop(goalStop(runtime));
      } catch (error) {
        stop({
          code: 1,
          status: 'error',
          reason: 'internal',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    try {
      startAgentWorker();
      const spawnedCommand = spawnSession(
        identity,
        {
          sessionId,
          providerId: resolved.value.providerId,
          modelId: resolved.value.modelId,
          cwd,
          approvalMode: args.mode,
          autoRejectApprovals: true,
          ...(resumeFile ? { resumeFile } : {}),
          ...(thinkingLevel ? { reasoningEnabled: true, thinkingLevel } : {}),
        },
        new Set(),
        undefined,
        undefined,
        { extraDisabledTools: disabledToolsForRun(args.disallowedTools, args.allowTools) }
      );
      if (!spawnedCommand.ok) {
        const code = configFailure(spawnedCommand.error ?? '') ? 2 : 1;
        stop({
          code,
          status: 'error',
          reason: code === 2 ? 'config' : 'spawn-failed',
          error: spawnedCommand.error,
        });
      } else {
        spawned = true;
        stderr(
          `[enso-server] run session=${sessionId} provider=${resolved.value.providerId} model=${resolved.value.modelId}`
        );
      }
    } catch (error) {
      stop({
        code: 1,
        status: 'error',
        reason: 'spawn-failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
