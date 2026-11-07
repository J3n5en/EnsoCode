import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { CodemodeHost } from '../codemode';
import { type ContextMessage, sanitizeContextMessages } from '../imageContext';
import { projectMessage } from '../projection';
import { createImageGenTool } from '../tools/imageGen';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=';

describe('ImageGen 真实 SDK 会话附件', () => {
  it.each([
    ['openai', 'gpt-4o-mini', 'ImageGen'],
    ['openai', 'gpt-4o-mini', 'codemode'],
    ['anthropic', 'claude-sonnet-4-5', 'ImageGen'],
    ['anthropic', 'claude-sonnet-4-5', 'codemode'],
  ] as const)('%s / %s 经 %s 后续请求和重开历史都有图片', async (provider, modelId, toolName) => {
    const model =
      provider === 'openai'
        ? getModel('openai', 'gpt-4o-mini')
        : getModel('anthropic', 'claude-sonnet-4-5');
    if (!model) throw new Error(`Missing catalog model ${provider}/${modelId}`);
    const root = mkdtempSync(path.join(tmpdir(), 'enso-imagegen-session-'));
    const agentDir = path.join(root, 'agent');
    mkdirSync(agentDir);
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    const requests: TranscriptContext[] = [];
    const auth = vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
    const stream = vi.spyOn(runtime, 'streamSimple').mockImplementation((requestModel, context) => {
      requests.push(structuredClone(context as TranscriptContext));
      const first = requests.length === 1;
      const message: AssistantMessage = {
        role: 'assistant',
        content: first
          ? [
              {
                type: 'toolCall',
                id: 'generate',
                name: toolName,
                arguments:
                  toolName === 'ImageGen'
                    ? { prompt: 'draw' }
                    : { code: 'await tools.ImageGen({prompt: "draw"});' },
              },
            ]
          : [{ type: 'text', text: 'done' }],
        api: requestModel.api,
        provider: requestModel.provider,
        model: requestModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
      const events = createAssistantMessageEventStream();
      events.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message });
      return events;
    });
    const host = new CodemodeHost({ codemode: toolName === 'codemode', deferredServers: [] });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'Test image conversation.',
      extensionFactories: [
        host.extension,
        {
          name: 'test-image-context',
          factory: (pi) => {
            pi.on('context', (event) => ({
              messages: sanitizeContextMessages(
                event.messages as ContextMessage[]
              ) as typeof event.messages,
            }));
          },
        },
      ],
    });
    const manager = SessionManager.create(root, path.join(root, 'sessions'));
    let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
    try {
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir,
        modelRuntime: runtime,
        model,
        thinkingLevel: 'off',
        resourceLoader: loader,
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          retry: { enabled: false },
          compaction: { enabled: false },
        }),
        noTools: 'builtin',
        customTools: [
          createImageGenTool({
            cwd: root,
            homeDir: root,
            confirmOutside: async () => {},
            fetch: async () => new Response(JSON.stringify({ data: [{ b64_json: png }] })),
            getConfig: () => ({
              config: {
                providerId: 'p',
                modelId: 'image',
                protocol: 'openai',
                baseUrl: 'http://localhost/v1',
                apiKey: 'test',
              },
            }),
          }),
        ],
      }));
      await session.prompt('生成图片');
      await session.prompt('把刚才那张图改为蓝色');
      expect(requests).toHaveLength(3);
      for (const request of requests.slice(1)) {
        const result = request.messages.find((message) => message.role === 'toolResult');
        expect(result?.content).toContainEqual({ type: 'image', data: png, mimeType: 'image/png' });
      }
      const reopened = SessionManager.open(manager.getSessionFile()!);
      const result = reopened
        .buildSessionContext()
        .messages.find((message) => message.role === 'toolResult');
      expect(result?.content).toContainEqual({ type: 'image', data: png, mimeType: 'image/png' });
      expect(projectMessage(result)?.generatedImages).toHaveLength(1);
      // 会话附件保存在 JSONL 中，删除临时产物也不丢失模型图片输入。
      rmSync(path.join(root, '.pi'), { recursive: true, force: true });
      expect(
        SessionManager.open(manager.getSessionFile()!)
          .buildSessionContext()
          .messages.find((message) => message.role === 'toolResult')?.content
      ).toContainEqual({ type: 'image', data: png, mimeType: 'image/png' });
    } finally {
      session?.dispose();
      stream.mockRestore();
      auth.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
