import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
} from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { isXaiChatModelId } from '@shared/oauthCatalog';

function prepareContext(model: Model<Api>, context: Context): Context {
  if (model.api !== 'openai-responses') return context;
  const id = model.id.trim().replace(/^(?:xai|x-ai)\//i, '');
  if (id.includes('/') || !isXaiChatModelId(id)) return context;

  let messages: Message[] | undefined;
  for (let i = 0; i < context.messages.length; i++) {
    const message = context.messages[i];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const content = message.content;
    const signedThinking = content.some(
      (block) => block.type === 'thinking' && typeof block.thinkingSignature === 'string'
    );
    const hasText = content.some(
      (block) => block.type === 'text' && typeof block.text === 'string'
    );
    const insertAt = content.findIndex((block) => block.type === 'toolCall');
    if (!signedThinking || hasText || insertAt < 0) continue;

    const next = [...content];
    next.splice(insertAt, 0, { type: 'text', text: '' });
    messages ??= [...context.messages];
    messages[i] = { ...message, content: next };
  }
  return messages ? { ...context, messages } : context;
}

type StreamMethod = (
  model: Model<Api>,
  context: Context,
  options?: unknown
) => AssistantMessageEventStream;

const installed = new WeakSet<ModelRuntime>();

/**
 * 保留已有 xAI Responses 的 signed reasoning + tool-call 文本槽兼容，但只作用于物理 Grok。
 * context hook 的 ctx.model 可能仍是虚拟模型，不能在那里判断目标厂商。
 * Pi 1.4 的 complete(Simple) 和虚拟 streamSimple 路由动态调用 this.stream(Simple)；
 * 沿用 privacyMask/runtime 的实例出口包装，Pi 升级时须复检该派发契约。
 */
export function installModelContextCompat(runtime: ModelRuntime): void {
  if (installed.has(runtime)) return;
  installed.add(runtime);
  const target = runtime as unknown as {
    stream?: StreamMethod;
    streamSimple?: StreamMethod;
  };
  for (const name of ['stream', 'streamSimple'] as const) {
    const method = target[name];
    if (typeof method !== 'function') continue;
    const original = method.bind(runtime);
    target[name] = (model, context, options) =>
      original(model, prepareContext(model, context), options);
  }
}
