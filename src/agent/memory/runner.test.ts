import { describe, expect, it } from 'vitest';
import { createMemoryCompleteSimple } from './runner';

type Runtime = Parameters<typeof createMemoryCompleteSimple>[0]['runtime'];
const model = {} as Parameters<typeof createMemoryCompleteSimple>[0]['sessionModel'];

function runtimeReturning(message: unknown): Runtime {
  return { completeSimple: async () => message } as unknown as Runtime;
}

describe('createMemoryCompleteSimple', () => {
  it('拼接 assistant 文本分片', async () => {
    const complete = createMemoryCompleteSimple({
      runtime: runtimeReturning({
        role: 'assistant',
        content: [
          { type: 'text', text: '{"a":' },
          { type: 'text', text: '1}' },
        ],
        stopReason: 'stop',
      }),
      sessionModel: model,
    });
    await expect(complete({ systemPrompt: 's', userText: 'u', phase: 1 })).resolves.toBe('{"a":1}');
  });

  // 真实场景：cfbot 的 gemini 路由返回 stopReason=error + 空 content，管线曾把空串当正常回复并把线程标 done
  it('模型返回 stopReason=error 时抛出 errorMessage，而不是返回空串', async () => {
    const complete = createMemoryCompleteSimple({
      runtime: runtimeReturning({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Request timed out.',
      }),
      sessionModel: model,
    });
    await expect(complete({ systemPrompt: 's', userText: 'u', phase: 1 })).rejects.toThrow(
      'Request timed out.'
    );
  });
});
