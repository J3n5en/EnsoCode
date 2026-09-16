import {
  buildMockTurn,
  chunkText,
  MOCK_API_ID,
  MOCK_API_KEY,
  MOCK_BASE_URL,
  MOCK_CHAT_MODEL_ID,
  MOCK_MODELS,
  MOCK_PROVIDER_ID,
} from '../mockProvider';
import {
  createEventStream,
  emptyUsage,
  type PiAssistantMessage,
  type PiContext,
  type PiEventStream,
  type PiModel,
  type PiModelSpec,
  type PiStreamOptions,
  type PiTextContent,
  type PiToolCall,
  type ProviderConfigInput,
} from './piProviderTypes';

export interface MockProviderConfigOptions {
  modelId?: string;
  contextWindow?: number;
  maxTokens?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function chunkDelayMs(): number {
  const raw = process.env.ENSO_MOCK_CHUNK_DELAY_MS ?? (process.env.VITEST ? '0' : '16');
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function streamMock(model: PiModel, context: PiContext, options?: PiStreamOptions): PiEventStream {
  const stream = createEventStream();
  const output: PiAssistantMessage = {
    role: 'assistant',
    content: [],
    api: MOCK_API_ID,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      throwIfAborted(options?.signal);
      const turn = buildMockTurn(context.messages ?? []);
      stream.push({ type: 'start', partial: output });

      if (turn.kind === 'toolUse') {
        for (const call of turn.calls) {
          throwIfAborted(options?.signal);
          const toolCall: PiToolCall = {
            type: 'toolCall',
            id: `mock_${call.name}_${output.content.length}_${Date.now()}`,
            name: call.name,
            arguments: call.arguments,
          };
          output.content.push(toolCall);
          const contentIndex = output.content.length - 1;
          stream.push({ type: 'toolcall_start', contentIndex, partial: output });
          stream.push({
            type: 'toolcall_delta',
            contentIndex,
            delta: JSON.stringify(toolCall.arguments),
            partial: output,
          });
          stream.push({
            type: 'toolcall_end',
            contentIndex,
            toolCall,
            partial: output,
          });
        }
        output.stopReason = 'toolUse';
        stream.push({ type: 'done', reason: 'toolUse', message: output });
        stream.end();
        return;
      }

      const block: PiTextContent = { type: 'text', text: '' };
      output.content.push(block);
      stream.push({ type: 'text_start', contentIndex: 0, partial: output });
      for (const chunk of chunkText(turn.text)) {
        throwIfAborted(options?.signal);
        block.text += chunk;
        stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk, partial: output });
        await delay(chunkDelayMs(), options?.signal);
      }
      stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: output });
      output.stopReason = 'stop';
      stream.push({ type: 'done', reason: 'stop', message: output });
      stream.end();
    } catch (error) {
      const aborted =
        options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      output.stopReason = aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({
        type: 'error',
        reason: output.stopReason as 'aborted' | 'error',
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

function modelSpec(options?: MockProviderConfigOptions): PiModelSpec {
  const id = options?.modelId ?? MOCK_CHAT_MODEL_ID;
  const named = MOCK_MODELS.find((entry) => entry.id === id);
  return {
    id,
    name: named?.name ?? id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options?.contextWindow ?? 128_000,
    maxTokens: options?.maxTokens ?? 8_192,
  };
}

export function mockProviderConfig(options?: MockProviderConfigOptions): ProviderConfigInput {
  return {
    name: 'Mock',
    api: MOCK_API_ID,
    baseUrl: MOCK_BASE_URL,
    apiKey: MOCK_API_KEY,
    models: [modelSpec(options)],
    streamSimple: streamMock,
  };
}

export { MOCK_PROVIDER_ID };
