// 用真实 pi AgentSession 核对优雅重启依赖的两处 SDK 行为：
// 1. prepareNextTurnWithContext 在工具批全部返回（结果已写进会话文件）之后、下一次 turn_start 之前被调用；
// 2. 另一个进程用同一个会话文件 open 后 continueSessionActivity，直接发下一次模型请求，不重跑工具。
// 3. prepareRequest 在每次模型请求前被调用（新一轮的首个请求时 user 消息已写进会话文件），停在这里续跑同样成立。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, expect, it, vi } from 'vitest';
import { continueSessionActivity } from './sessionAdapter';

const model = getModel('openai', 'gpt-4o-mini');
if (!model) throw new Error('Test model is not available in the bundled Pi catalog.');

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason']
) {
  return {
    role: 'assistant' as const,
    content,
    api: model!.api,
    provider: model!.provider,
    model: model!.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('真实 pi：工具结束后停在下一次模型请求前；新会话从文件续跑，不重跑工具', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-graceful-pi-'));
  roots.push(root);
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  const replies = [
    assistant([{ type: 'toolCall', id: 'call-1', name: 'probe', arguments: {} }], 'toolUse'),
    assistant([{ type: 'text', text: 'all done' }], 'stop'),
  ];
  const requests: TranscriptContext[] = [];
  vi.spyOn(runtime, 'streamSimple').mockImplementation((_model, context) => {
    requests.push(context as TranscriptContext);
    const stream = createAssistantMessageEventStream();
    const message = replies.shift();
    if (!message) throw new Error('unexpected model request');
    stream.push({ type: 'done', reason: message.stopReason as 'stop', message });
    return stream;
  });
  let toolRuns = 0;
  const probe: ToolDefinition = {
    name: 'probe',
    label: 'probe',
    description: 'test probe',
    parameters: Type.Object({}),
    execute: async () => {
      toolRuns++;
      return { content: [{ type: 'text', text: 'probe result' }], details: undefined };
    },
  };
  const open = async (sessionManager: SessionManager) => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'graceful restart test',
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: 'off',
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
      noTools: 'builtin',
      customTools: [probe],
    });
    return session;
  };

  const first = await open(SessionManager.create(cwd, sessionDir));
  const events: string[] = [];
  first.subscribe((event) => events.push(event.type));
  const paused = Promise.withResolvers<void>();
  const next = first.agent.prepareNextTurnWithContext;
  expect(typeof next).toBe('function');
  first.agent.prepareNextTurnWithContext = async () => {
    events.push('[restart-boundary]');
    paused.resolve();
    await new Promise(() => {});
    return undefined;
  };
  void first.prompt('run the probe');
  await paused.promise;

  const boundary = events.indexOf('[restart-boundary]');
  expect(events.lastIndexOf('tool_execution_end')).toBeLessThan(boundary);
  expect(events.lastIndexOf('turn_end')).toBeLessThan(boundary);
  expect(events.filter((type) => type === 'turn_start')).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(toolRuns).toBe(1);
  const sessionFile = first.sessionFile;
  if (!sessionFile) throw new Error('session file missing');
  expect(readFileSync(sessionFile, 'utf8')).toContain('"toolCallId":"call-1"');

  // 下一代：只靠会话文件
  const second = await open(SessionManager.open(sessionFile, sessionDir, cwd));
  expect(second.agent.state.messages.at(-1)?.role).toBe('toolResult');
  const after: string[] = [];
  second.subscribe((event) => after.push(event.type));
  await continueSessionActivity(second);
  expect(toolRuns).toBe(1);
  expect(after).not.toContain('tool_execution_start');
  expect(requests).toHaveLength(2);
  expect(
    requests[1].messages.some(
      (message) => message.role === 'toolResult' && message.toolCallId === 'call-1'
    )
  ).toBe(true);
  expect(second.agent.state.messages.at(-1)).toMatchObject({ role: 'assistant' });
  const roles = second.agent.state.messages.map((message) => message.role);
  expect(roles.filter((role) => role === 'user')).toHaveLength(1);
  expect(roles.filter((role) => role === 'toolResult')).toHaveLength(1);
  second.dispose();
});

it('真实 pi：prepareRequest 在新一轮首个模型请求前、user 消息落盘后；新会话从文件续跑同一条消息', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-graceful-pi-request-'));
  roots.push(root);
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  const requests: TranscriptContext[] = [];
  vi.spyOn(runtime, 'streamSimple').mockImplementation((_model, context) => {
    requests.push(context as TranscriptContext);
    const stream = createAssistantMessageEventStream();
    const message = assistant([{ type: 'text', text: 'on it' }], 'stop');
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  });
  const open = async (sessionManager: SessionManager) => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'graceful restart test',
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: 'off',
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
      noTools: 'builtin',
    });
    return session;
  };

  const first = await open(SessionManager.create(cwd, sessionDir));
  const paused = Promise.withResolvers<void>();
  first.agent.prepareRequest = async () => {
    paused.resolve();
    await new Promise(() => {});
    return undefined;
  };
  void first.prompt('continue the goal');
  await paused.promise;
  expect(requests).toHaveLength(0);
  const sessionFile = first.sessionFile;
  if (!sessionFile) throw new Error('session file missing');
  expect(readFileSync(sessionFile, 'utf8')).toContain('continue the goal');

  const second = await open(SessionManager.open(sessionFile, sessionDir, cwd));
  expect(second.agent.state.messages.at(-1)?.role).toBe('user');
  await continueSessionActivity(second);
  expect(requests).toHaveLength(1);
  const roles = second.agent.state.messages.map((message) => message.role);
  expect(roles.filter((role) => role === 'user')).toHaveLength(1);
  expect(roles.at(-1)).toBe('assistant');
  second.dispose();
});
