import type { Api, Context, Model, Provider, ProviderRequestOptions } from '@earendil-works/pi-ai';
import { imagePlaceholder } from './imageContext';
import { reportRequestBodyUsage } from './requestBodyTelemetry';

type OnPayload = NonNullable<ProviderRequestOptions['onPayload']>;
const guardedStreams = new WeakSet<object>();
type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// 与 pi catalog 的 direct-provider 元数据一致；未知协议不凭空设限。
const DEFAULT_LIMITS: Readonly<Record<string, number>> = {
  'anthropic-messages': 32 * 1024 * 1024,
  'openai-completions': 512 * 1024 * 1024,
  'openai-responses': 512 * 1024 * 1024,
  'google-generative-ai': 20 * 1024 * 1024,
};

function requestLimit(model: Model<Api>): number | undefined {
  const configured = model.inputLimits?.maxRequestBytes;
  if (configured === undefined)
    return Object.hasOwn(DEFAULT_LIMITS, model.api) ? DEFAULT_LIMITS[model.api] : undefined;
  if (!Number.isSafeInteger(configured) || configured <= 0)
    throw new Error('Invalid inputLimits.maxRequestBytes: expected a positive safe integer');
  return configured;
}

function tooLarge(bytes: number, limit: number): Error {
  // pi 识别 request_too_large 后走有限的 compact-and-retry，而非瞬态错误退避。
  // 不含图片、正文、凭证或任意 provider 错误，用户可直接看到本地阻止原因。
  return new Error(
    `request_too_large: model request is ${bytes} UTF-8 bytes; limit is ${limit} bytes. ` +
      'Already-seen tool images were considered; current images and user attachments are protected. ' +
      'Compact the context or reduce the current input before retrying.'
  );
}

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Model request payload is not JSON serializable');
  return Buffer.byteLength(json, 'utf8');
}

interface SeenResult {
  source: string;
  images: Array<{ data: string; mimeType: string }>;
}

// Anthropic 的 tool_use_id 字符 / 长度规范，对齐 pi serializer；碰撞的 id 一律不淘汰。
const anthropicId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

function seenToolImages(context: Context): Map<string, SeenResult> {
  const messages = context.messages;
  let lastSuccessfulAssistant = -1;
  const calls = new Map<string, { name: string; path?: string }>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (
      message.role !== 'assistant' ||
      message.stopReason === 'error' ||
      message.stopReason === 'aborted'
    )
      continue;
    lastSuccessfulAssistant = i;
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const args: unknown = block.arguments;
      const path = isRecord(args) ? (args.path ?? args.file ?? args.filePath) : undefined;
      calls.set(block.id, { name: block.name, ...(typeof path === 'string' ? { path } : {}) });
    }
  }
  const seen = new Map<string, SeenResult>();
  const ids = new Set<string>();
  const protectedIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'toolResult') continue;
    const id = anthropicId(message.toolCallId);
    if (ids.has(id) || i >= lastSuccessfulAssistant) {
      protectedIds.add(id);
      seen.delete(id);
    }
    ids.add(id);
    if (protectedIds.has(id)) continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    const images = message.content.flatMap((block) =>
      block.type === 'image' ? [{ data: block.data, mimeType: block.mimeType }] : []
    );
    if (!images.length) continue;
    const tool = message.toolName || call.name;
    seen.set(id, { images, source: call.path ? `${tool} ${call.path}` : `from ${tool}` });
  }
  return seen;
}

/**
 * 只整理已经看过的 Anthropic tool_result 图片，不删消息、不拆工具配对。
 * 超限才动，最新工具批次与 user 附件原样保留；不依赖 user 轮次边界。
 * onPayload caller 改写后的图片须与原图匹配，不能把扩展注入的新图误认作已看过。
 */
function fitAnthropicPayload(
  payload: RecordValue,
  context: Context,
  limit: number,
  options: ProviderRequestOptions | undefined
): RecordValue {
  // adapter 对 replacement 强制 stream:true；guard 也必须按真正要发送的值衡量。
  const body = payload.stream === true ? payload : { ...payload, stream: true };
  let bytes = jsonBytes(body);
  if (bytes <= limit) {
    reportRequestBodyUsage(bytes, limit, 'payload', options);
    return body;
  }
  const seen = seenToolImages(context);
  let changed = false;
  const messages = Array.isArray(body.messages)
    ? body.messages.map((message) => {
        if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.content))
          return message;
        let messageChanged = false;
        const content = message.content.map((result) => {
          if (
            !isRecord(result) ||
            result.type !== 'tool_result' ||
            typeof result.tool_use_id !== 'string' ||
            !Array.isArray(result.content)
          )
            return result;
          const candidate = seen.get(result.tool_use_id);
          if (!candidate) return result;
          let resultChanged = false;
          const parts = result.content.map((block) => {
            if (
              bytes <= limit ||
              !isRecord(block) ||
              block.type !== 'image' ||
              !isRecord(block.source)
            )
              return block;
            const source = block.source;
            if (
              source.type !== 'base64' ||
              !candidate.images.some(
                (image) => image.data === source.data && image.mimeType === source.media_type
              )
            )
              return block;
            const replacement = {
              ...imagePlaceholder(
                { type: 'image', mimeType: String(source.media_type) },
                candidate.source
              ),
              ...(block.cache_control !== undefined ? { cache_control: block.cache_control } : {}),
            };
            const saving = jsonBytes(block) - jsonBytes(replacement);
            if (saving <= 0) return block;
            bytes -= saving;
            resultChanged = true;
            return replacement;
          });
          if (!resultChanged) return result;
          messageChanged = true;
          return { ...result, content: parts };
        });
        if (!messageChanged) return message;
        changed = true;
        return { ...message, content };
      })
    : body.messages;
  const fitted = changed ? { ...body, messages } : body;
  bytes = jsonBytes(fitted);
  reportRequestBodyUsage(bytes, limit, 'payload', options);
  if (bytes > limit) throw tooLarge(bytes, limit);
  return fitted;
}

function budgetOptions<T extends ProviderRequestOptions | undefined>(
  model: Model<Api>,
  context: Context,
  options: T
): T | (T & { onPayload: OnPayload; fetch: typeof fetch }) {
  // 未知协议没有权威上限时，不以无效的 fetch 覆盖 native transport 默认值。
  if (model.inputLimits?.maxRequestBytes === undefined && !Object.hasOwn(DEFAULT_LIMITS, model.api))
    return options;
  const delegateFetch = options?.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    ...options,
    async onPayload(payload: unknown, requestModel: Model<Api>) {
      const replacement = await options?.onPayload?.(payload, requestModel);
      const body = replacement === undefined ? payload : replacement;
      const limit = requestLimit(requestModel);
      if (limit === undefined) return body;
      if (requestModel.api === 'anthropic-messages' && isRecord(body))
        return fitAnthropicPayload(body, context, limit, options);
      const bytes = jsonBytes(body);
      reportRequestBodyUsage(bytes, limit, 'payload', options);
      if (bytes > limit) throw tooLarge(bytes, limit);
      return body;
    },
    async fetch(input, init) {
      // 最后一道守卫：SDK 在 onPayload 后的序列化 / 流标记等额外处理也不能绕过。
      const limit = requestLimit(model);
      let outboundInit = init;
      if (limit !== undefined) {
        // Request 构造会转移原 body；仅读取 clone，不能把 delegate 的请求读坏。
        const measurementInput =
          input instanceof Request && init?.body == null ? input.clone() : input;
        let measurementInit = init;
        if (init?.body instanceof ReadableStream) {
          const [measurement, outbound] = init.body.tee();
          measurementInit = { ...init, body: measurement };
          outboundInit = { ...init, body: outbound };
        }
        const bytes =
          typeof init?.body === 'string'
            ? Buffer.byteLength(init.body, 'utf8')
            : (await new Request(measurementInput, measurementInit).arrayBuffer()).byteLength;
        reportRequestBodyUsage(bytes, limit, 'wire', options);
        if (bytes > limit) {
          if (outboundInit !== init && outboundInit?.body instanceof ReadableStream)
            void outboundInit.body.cancel().catch(() => {});
          throw tooLarge(bytes, limit);
        }
      }
      return delegateFetch(input, outboundInit);
    },
  };
}

/** raw / simple 两条出口均覆盖，摘要、缓存预热、自动与手动重试共用。 */
export function withRequestBodyBudget(provider: Provider): Provider {
  // resolve / native refresh 会复用或浅拷贝 provider，不能每次再叠一层 guard。
  if (guardedStreams.has(provider.stream) && guardedStreams.has(provider.streamSimple))
    return provider;
  const guarded: Provider = {
    ...provider,
    stream(model, context, options) {
      return provider.stream<Api>(model, context, budgetOptions(model, context, options));
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(model, context, budgetOptions(model, context, options));
    },
  };
  guardedStreams.add(guarded.stream);
  guardedStreams.add(guarded.streamSimple);
  return guarded;
}
