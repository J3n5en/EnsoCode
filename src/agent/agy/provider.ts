import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { isSignedOutError } from '@shared/agy/catalog';
import {
  AGY_API_ID,
  AGY_DEFAULT_MODEL_ID,
  AGY_DEFAULT_MODEL_NAME,
  AGY_PLACEHOLDER_API_KEY,
  AGY_PROVIDER_ID,
  AGY_PROVIDER_NAME,
} from '@shared/agy/constants';
import type { AgyModelOption } from '@shared/agy/types';
import {
  createEventStream,
  emptyUsage,
  type PiAssistantMessage,
  type PiContext,
  type PiModel,
  type PiStreamOptions,
  type PiTextContent,
  type PiThinkingContent,
  type PiToolCall,
  type ProviderConfigInput,
} from '@shared/providers/piProviderTypes';
import { AgyRpcError } from './connection';
import { getAgyBridge } from './sessionBridge';
import { getAgyWorkerConfig } from './workerConfig';

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CONTEXT_WINDOW = 1_000_000;
const MAX_TOKENS = 64_000;

export function isAgyModel(model: { provider?: string; api?: string }): boolean {
  return model.provider === AGY_PROVIDER_ID || model.api === AGY_API_ID;
}

export function agyCatalog(models: readonly AgyModelOption[]): AgyModelOption[] {
  const list = models.filter((model) => model.id);
  if (list.some((model) => model.id === AGY_DEFAULT_MODEL_ID)) return list;
  return [{ id: AGY_DEFAULT_MODEL_ID, name: AGY_DEFAULT_MODEL_NAME }, ...list];
}

export function agyProviderConfig(models: readonly AgyModelOption[] = []): ProviderConfigInput {
  return {
    name: AGY_PROVIDER_NAME,
    api: AGY_API_ID,
    baseUrl: 'http://agy-cli.invalid',
    apiKey: AGY_PLACEHOLDER_API_KEY,
    models: agyCatalog(models).map((model) => ({
      id: model.id,
      name: model.name,
      api: AGY_API_ID,
      reasoning: true,
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: ZERO_COST,
      contextWindow: CONTEXT_WINDOW,
      maxTokens: MAX_TOKENS,
    })),
    streamSimple: streamAgy,
  };
}

export function registerAgyProvider(
  runtime: ModelRuntime,
  models: readonly AgyModelOption[] = getAgyWorkerConfig().models,
  extraModelId?: string
): void {
  const catalog = agyCatalog(models);
  if (extraModelId && !catalog.some((model) => model.id === extraModelId)) {
    catalog.push({ id: extraModelId, name: extraModelId });
  }
  runtime.registerProvider(AGY_PROVIDER_ID, agyProviderConfig(catalog));
}

export function streamAgy(model: PiModel, context: PiContext, options?: PiStreamOptions) {
  const stream = createEventStream();
  const output: PiAssistantMessage = {
    role: 'assistant',
    content: [],
    api: AGY_API_ID,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  void (async () => {
    try {
      const bridge = getAgyBridge();
      // 只有会话的 agent 循环请求绑了桥；压缩、摘要和会话外的 complete 都到不了 agy
      if (!bridge) {
        throw new Error(
          'agy only serves chat turns of an attached session; compaction and summary requests are not sent to agy'
        );
      }
      stream.push({ type: 'start', partial: output });
      const result = await bridge.runTurn({
        messages: context.messages,
        modelId: model.id,
        modelLabel: model.name || model.id,
        signal: options?.signal,
        onText: (delta) => appendText(stream, output, delta),
        onThinking: (delta) => appendThinking(stream, output, delta),
        onTool: (tool) => appendToolCall(stream, output, tool),
      });
      endBlocks(stream, output);
      output.usage = {
        ...emptyUsage(),
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        totalTokens: result.usage.totalTokens,
      };
      if (result.stopReason === 'aborted' || result.stopReason === 'error') {
        output.stopReason = result.stopReason;
        output.errorMessage = result.stopReason === 'aborted' ? 'aborted' : 'agy turn failed';
        stream.push({ type: 'error', reason: result.stopReason, error: output });
      } else {
        output.stopReason = result.stopReason === 'length' ? 'length' : 'stop';
        stream.push({
          type: 'done',
          reason: output.stopReason,
          message: output,
        });
      }
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = agyErrorMessage(error);
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

function agyErrorMessage(error: unknown): string {
  if (error instanceof AgyRpcError && isSignedOutError(error.code, error.message)) {
    return 'agy is not signed in. Run agy in a terminal to sign in, then detect again.';
  }
  return error instanceof Error ? error.message : String(error);
}

function appendText(
  stream: ReturnType<typeof createEventStream>,
  output: PiAssistantMessage,
  delta: string
) {
  let block = output.content.at(-1);
  if (block?.type !== 'text') {
    block = { type: 'text', text: '' };
    output.content.push(block);
    stream.push({ type: 'text_start', contentIndex: output.content.length - 1, partial: output });
  }
  (block as PiTextContent).text += delta;
  stream.push({
    type: 'text_delta',
    contentIndex: output.content.indexOf(block),
    delta,
    partial: output,
  });
}

function appendThinking(
  stream: ReturnType<typeof createEventStream>,
  output: PiAssistantMessage,
  delta: string
) {
  let block = output.content.at(-1);
  if (block?.type !== 'thinking') {
    block = { type: 'thinking', thinking: '' };
    output.content.push(block);
    stream.push({
      type: 'thinking_start',
      contentIndex: output.content.length - 1,
      partial: output,
    });
  }
  (block as PiThinkingContent).thinking += delta;
  stream.push({
    type: 'thinking_delta',
    contentIndex: output.content.indexOf(block),
    delta,
    partial: output,
  });
}

/** agy 已执行的工具：toolCall 进正在流的消息让卡片实时出现；message_end 时由 bridge 拆出去。 */
function appendToolCall(
  stream: ReturnType<typeof createEventStream>,
  output: PiAssistantMessage,
  tool: { id: string; name: string; args: Record<string, unknown> }
) {
  const toolCall: PiToolCall = {
    type: 'toolCall',
    id: tool.id,
    name: tool.name,
    arguments: tool.args as PiToolCall['arguments'],
  };
  output.content.push(toolCall);
  const contentIndex = output.content.length - 1;
  stream.push({ type: 'toolcall_start', contentIndex, partial: output });
  stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
}

function endBlocks(stream: ReturnType<typeof createEventStream>, output: PiAssistantMessage) {
  for (const block of output.content) {
    const contentIndex = output.content.indexOf(block);
    if (block.type === 'text') {
      stream.push({ type: 'text_end', contentIndex, content: block.text, partial: output });
    } else if (block.type === 'thinking') {
      stream.push({
        type: 'thinking_end',
        contentIndex,
        content: block.thinking,
        partial: output,
      });
    }
  }
}
