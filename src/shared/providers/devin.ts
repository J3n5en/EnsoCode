/**
 * Devin 订阅 provider（Cascade / Codeium Connect）。
 *
 * 覆盖：CLI PKCE 登录、GetCliModelConfigs 发现、GetChatMessage 流式推理。
 * 协议与字段号对齐 oh-my-pi 的 Devin 实现；回调服务器复用本仓库的 node:http loopback。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { OauthUsageWindow } from '@shared/types';
import { startOauthCallbackServer } from './callbackServer';
import {
  CacheControlType,
  ChatMessagePromptSchema,
  ChatMessageRequestType,
  ChatMessageSource,
  ChatToolCallSchema,
  ChatToolChoiceSchema,
  ChatToolDefinitionSchema,
  CompletionConfigurationSchema,
  ConversationalPlannerMode,
  create,
  fromBinary,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  GetUserStatusRequestSchema,
  type GetUserStatusResponse,
  GetUserStatusResponseSchema,
  ImageDataSchema,
  MetadataSchema,
  PromptCacheOptionsSchema,
  StopReason,
  toBinary,
} from './devin/proto';
import {
  createEventStream,
  currentSystemPrompt,
  currentTools,
  emptyUsage,
  type PiAssistantMessage,
  type PiContext,
  type PiEventStream,
  type PiLoginCallbacks,
  type PiModel,
  type PiModelSpec,
  type PiOauthCredentials,
  type PiRefreshModelsContext,
  type PiStreamOptions,
  type PiTextContent,
  type PiThinkingContent,
  type PiToolCall,
  type ProviderConfigInput,
} from './piProviderTypes';

export const DEVIN_PROVIDER_ID = 'devin';
/**
 * 自定义 api 标识。pi 的 provider composer 要求注册 streamSimple 时必须给 api，
 * 且只有 `model.api === extension.api` 的模型才会走这条流。
 */
export const DEVIN_API_ID = 'devin-agent';

const DEVIN_WEBAPP_URL = 'https://app.devin.ai';
const DEVIN_TOKEN_URL = 'https://api.devin.ai/auth/cli/token';
const DEVIN_CASCADE_URL = 'https://server.codeium.com';
const CALLBACK_PORT = 59653;
const CALLBACK_PATH = '/callback';
const TOKEN_PATH_FALLBACK_MS = 365 * 24 * 60 * 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEVIN_IDE_VERSION = '3.2.23';
const DEVIN_EXTENSION_VERSION = '1.48.2';
const DEVIN_SESSION_TOKEN_PREFIX = 'devin-session-token$';
const CHAT_MESSAGE_PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
const DEVIN_AUTH_PATH = '/exa.auth_pb.AuthService/GetUserJwt';
const DEVIN_MODELS_PATH = '/exa.api_server_pb.ApiServerService/GetCliModelConfigs';
const DEVIN_STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const DEVIN_DEFAULT_STOP_PATTERNS = [
  '<|user|>',
  '<|bot|>',
  '<|context_request|>',
  '<|endoftext|>',
  '<|end_of_turn|>',
];
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 5_000;
const USAGE_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;

export interface DevinPkce {
  verifier: string;
  challenge: string;
}

export function generateDevinPkce(): DevinPkce {
  const verifier = randomBytes(96).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

export function buildDevinAuthUrl(state: string, redirectUri: string, challenge: string): string {
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    prompt: 'select_account',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`;
}

export async function exchangeDevinCliToken(
  authorizationCode: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(DEVIN_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code: authorizationCode,
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Devin CLI token exchange failed: ${response.status} ${error}`.trim());
  }
  const data = (await response.json()) as { token?: unknown };
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('Devin CLI token exchange returned an empty token');
  }
  return data.token;
}

export function getDevinTokenExpiry(token: string, nowMs = Date.now()): number {
  try {
    const payload = token.split('.')[1];
    if (payload) {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        exp?: unknown;
      };
      if (typeof decoded.exp === 'number' && Number.isFinite(decoded.exp)) {
        return decoded.exp * 1000 - REFRESH_SKEW_MS;
      }
    }
  } catch {
    // 非 JWT 走长期兜底
  }
  return nowMs + TOKEN_PATH_FALLBACK_MS;
}

function emailFromJwt(token: string): string | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' && claims.email ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

async function login(callbacks: PiLoginCallbacks): Promise<PiOauthCredentials> {
  const state = randomUUID();
  const pkce = generateDevinPkce();
  const server = await startOauthCallbackServer({
    preferredPort: CALLBACK_PORT,
    callbackPath: CALLBACK_PATH,
    expectedState: state,
    signal: callbacks.signal,
    onProgress: callbacks.onProgress,
  });

  try {
    callbacks.onAuth({
      url: buildDevinAuthUrl(state, server.redirectUri, pkce.challenge),
      instructions: 'Sign in to Devin in your browser.',
    });
    callbacks.onProgress?.('Waiting for browser authentication...');
    const code = await server.waitForCode();
    callbacks.onProgress?.('Exchanging authorization code for tokens...');
    const token = await exchangeDevinCliToken(code, pkce.verifier);
    const email = emailFromJwt(token);
    return {
      access: token,
      refresh: token,
      expires: getDevinTokenExpiry(token),
      ...(email ? { email } : {}),
    };
  } finally {
    server.close();
  }
}

async function refreshToken(credentials: PiOauthCredentials): Promise<PiOauthCredentials> {
  const expires = getDevinTokenExpiry(credentials.access);
  if (expires > Date.now()) {
    return { ...credentials, expires };
  }
  throw new Error('Devin 登录已过期，请重新登录');
}

export function normalizeDevinSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return '';
  return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)
    ? apiKey
    : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

export interface DevinDiscoveredModel {
  label: string;
  modelUid: string;
  disabled: boolean;
  supportsImages: boolean;
  maxTokens: number;
  modelInfo?: { modelFeatures?: { supportsThinking?: boolean } };
}

function supportsDevinThinking(config: DevinDiscoveredModel): boolean {
  if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
  return (
    config.modelInfo?.modelFeatures?.supportsThinking === true ||
    REASONING_LABEL_PATTERN.test(config.label)
  );
}

export function normalizeDevinModels(configs: readonly DevinDiscoveredModel[]): PiModelSpec[] {
  const byId = new Map<string, PiModelSpec>();
  for (const config of configs) {
    if (config.disabled) continue;
    const id = config.modelUid.trim();
    if (!id) continue;
    const contextWindow = config.maxTokens > 0 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW;
    byId.set(id, {
      id,
      name: config.label.trim() || id,
      reasoning: supportsDevinThinking(config),
      input: config.supportsImages ? ['text', 'image'] : ['text'],
      cost: ZERO_COST,
      contextWindow,
      maxTokens: Math.min(
        config.maxTokens > 0 ? config.maxTokens : DEFAULT_MAX_TOKENS,
        DEFAULT_MAX_TOKENS
      ),
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function cascadeMetadata(apiKey: string, userJwt = '') {
  return create(MetadataSchema, {
    apiKey,
    userJwt,
    ideName: 'windsurf',
    ideVersion: DEVIN_IDE_VERSION,
    extensionName: 'windsurf',
    extensionVersion: DEVIN_EXTENSION_VERSION,
    locale: 'en',
  });
}

function decodeProto<T>(decode: (bytes: Uint8Array) => T, payload: Uint8Array): T {
  try {
    return decode(payload);
  } catch {
    return decode(gunzipSync(payload));
  }
}

function protoBody(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

function protoFetchBody(bytes: Uint8Array): BodyInit {
  return protoBody(bytes) as BodyInit;
}

export async function fetchDevinModels(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<PiModelSpec[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  try {
    const baseUrl = (options.baseUrl ?? DEVIN_CASCADE_URL).replace(/\/+$/, '');
    const request = create(GetCliModelConfigsRequestSchema, {
      metadata: cascadeMetadata(normalizeDevinSessionToken(options.apiKey)),
    });
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl(`${baseUrl}${DEVIN_MODELS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/proto',
        'connect-protocol-version': '1',
        accept: '*/*',
      },
      body: protoFetchBody(toBinary(GetCliModelConfigsRequestSchema, request)),
      signal,
    });
    if (!response.ok) return null;
    const decoded = decodeProto(
      (bytes) => fromBinary(GetCliModelConfigsResponseSchema, bytes),
      new Uint8Array(await response.arrayBuffer())
    );
    return normalizeDevinModels(decoded.clientModelConfigs);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface DevinUsageProbe {
  windows: OauthUsageWindow[];
  email?: string;
  plan?: string;
}

function unixToMs(value: bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function quotaWindow(
  label: string,
  remaining: number | undefined,
  reset: bigint | undefined,
  hide: boolean
): OauthUsageWindow | null {
  if (hide) return null;
  const remainingN = typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : 0;
  const resetN = typeof reset === 'bigint' ? reset : 0n;
  if (remainingN === 0 && resetN === 0n) return null;
  const window: OauthUsageWindow = {
    label,
    usedPercent: Math.round(Math.min(100, Math.max(0, 100 - remainingN))),
  };
  const resetsAt = unixToMs(resetN);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return window;
}

function creditWindow(
  used: number | undefined,
  available: number | undefined
): OauthUsageWindow | null {
  const usedN = typeof used === 'number' && Number.isFinite(used) ? used : 0;
  const availableN = typeof available === 'number' && Number.isFinite(available) ? available : 0;
  const total = usedN + availableN;
  if (total <= 0) return null;
  return {
    label: 'credits',
    usedPercent: Math.round(Math.min(100, Math.max(0, (usedN / total) * 100))),
  };
}

/** SeatManagement GetUserStatus → 订阅设置用的日/周窗口；未填充字段不展示。 */
export function parseDevinUsage(response: GetUserStatusResponse): DevinUsageProbe {
  const status = response.userStatus;
  const planInfo = status?.planStatus?.planInfo ?? response.planInfo;
  const planStatus = status?.planStatus;
  const windows: OauthUsageWindow[] = [];
  if (planStatus) {
    const daily = quotaWindow(
      'Daily',
      planStatus.dailyQuotaRemainingPercent,
      planStatus.dailyQuotaResetAtUnix,
      planInfo?.hideDailyQuota === true
    );
    const weekly = quotaWindow(
      'Weekly',
      planStatus.weeklyQuotaRemainingPercent,
      planStatus.weeklyQuotaResetAtUnix,
      planInfo?.hideWeeklyQuota === true
    );
    if (daily) windows.push(daily);
    if (weekly) windows.push(weekly);
    if (windows.length === 0) {
      const credits =
        creditWindow(planStatus.usedFlexCredits, planStatus.availableFlexCredits) ??
        creditWindow(planStatus.usedPromptCredits, planStatus.availablePromptCredits) ??
        creditWindow(planStatus.usedFlowCredits, planStatus.availableFlowCredits);
      if (credits) windows.push(credits);
    }
  }
  const email = status?.email?.trim();
  const plan = planInfo?.planName?.trim();
  return {
    windows,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

export async function fetchDevinUsage(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<DevinUsageProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  try {
    const baseUrl = (options.baseUrl ?? DEVIN_CASCADE_URL).replace(/\/+$/, '');
    const request = create(GetUserStatusRequestSchema, {
      metadata: cascadeMetadata(normalizeDevinSessionToken(options.apiKey)),
    });
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl(`${baseUrl}${DEVIN_STATUS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/proto',
        'connect-protocol-version': '1',
        accept: '*/*',
      },
      body: protoFetchBody(toBinary(GetUserStatusRequestSchema, request)),
      signal,
    });
    if (!response.ok) return { windows: [] };
    const decoded = decodeProto(
      (bytes) => fromBinary(GetUserStatusResponseSchema, bytes),
      new Uint8Array(await response.arrayBuffer())
    );
    return parseDevinUsage(decoded);
  } catch {
    return { windows: [] };
  } finally {
    clearTimeout(timer);
  }
}

let lastDiscoveredModels: PiModelSpec[] | undefined;

async function refreshModels(context: PiRefreshModelsContext): Promise<PiModelSpec[]> {
  const credential = context.credential;
  const access =
    credential && credential.type === 'oauth' && typeof credential.access === 'string'
      ? credential.access
      : undefined;
  const cached = lastDiscoveredModels ?? [];
  if (!context.allowNetwork || !access) return cached;
  const discovered = await fetchDevinModels({ apiKey: access, signal: context.signal });
  if (!discovered || discovered.length === 0) return cached;
  lastDiscoveredModels = discovered;
  return discovered;
}

function deterministicUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseJsonObject(text: string | undefined): PiToolCall['arguments'] {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PiToolCall['arguments'];
  } catch {
    return {};
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part && typeof part === 'object' && 'type' in part && part.type === 'text') {
      const value = (part as { text?: unknown }).text;
      if (typeof value === 'string') text += value;
    }
  }
  return text;
}

function imagesOf(content: unknown) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'image')
      continue;
    const data = (part as { data?: unknown }).data;
    const mimeType = (part as { mimeType?: unknown }).mimeType;
    if (typeof data === 'string' && typeof mimeType === 'string') {
      images.push(create(ImageDataSchema, { base64Data: data, mimeType }));
    }
  }
  return images;
}

function buildChatMessagePrompts(context: PiContext, cascadeId: string, model: PiModel) {
  const prompts = [];
  for (const [index, message] of context.messages.entries()) {
    if (message.role === 'user') {
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId: deterministicUuid(`${cascadeId}\0${index}\0user`),
          source: ChatMessageSource.USER,
          prompt: textOf(message.content),
          images: imagesOf(message.content),
        })
      );
      continue;
    }
    if (message.role === 'assistant') {
      // 与 pi transformMessages 一致整轮跳过：中断轮里的 toolCall 从未执行，Enso 的
      // dropUnpairedToolResults 也已按同一规则删掉其结果，回放只会留下没有结果的工具调用
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
      const native =
        message.api === model.api &&
        message.provider === model.provider &&
        message.model === model.id;
      let promptText = '';
      let thinkingText = '';
      let signature = '';
      const toolCalls = [];
      for (const part of message.content) {
        if (part.type === 'text') promptText += part.text;
        else if (part.type === 'thinking') {
          thinkingText += part.thinking;
          if (native && !signature && part.thinkingSignature) signature = part.thinkingSignature;
        } else if (part.type === 'toolCall') {
          toolCalls.push(
            create(ChatToolCallSchema, {
              id: part.id,
              name: part.name,
              argumentsJson: JSON.stringify(part.arguments ?? {}),
            })
          );
        }
      }
      if (!promptText && !thinkingText && !signature && toolCalls.length === 0) continue;
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId:
            native && 'responseId' in message && typeof message.responseId === 'string'
              ? message.responseId
              : `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
          source: ChatMessageSource.SYSTEM,
          prompt: promptText,
          thinking: thinkingText,
          signature,
          signatureType: '',
          toolCalls,
        })
      );
      continue;
    }
    if (message.role !== 'toolResult') continue;
    prompts.push(
      create(ChatMessagePromptSchema, {
        messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${message.toolCallId}`),
        source: ChatMessageSource.TOOL,
        toolCallId: message.toolCallId,
        toolResultIsError: Boolean(message.isError),
        prompt: textOf(message.content),
        images: imagesOf(message.content),
      })
    );
  }
  return prompts;
}

function buildDevinChatRequest(
  model: PiModel,
  context: PiContext,
  options: PiStreamOptions | undefined,
  apiKey: string,
  userJwt: string
) {
  const cascadeId = randomUUID();
  const stopPatterns = DEVIN_DEFAULT_STOP_PATTERNS;
  return create(GetChatMessageRequestSchema, {
    metadata: cascadeMetadata(apiKey, userJwt),
    prompt: currentSystemPrompt(context).trim(),
    chatMessagePrompts: buildChatMessagePrompts(context, cascadeId, model),
    chatModelUid: model.id,
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: create(ChatToolChoiceSchema, { choice: { case: 'optionName', value: 'auto' } }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, {
      type: CacheControlType.EPHEMERAL,
    }),
    disableParallelToolCalls: true,
    cascadeId,
    executionId: randomUUID(),
    configuration: create(CompletionConfigurationSchema, {
      numCompletions: 1n,
      maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? DEFAULT_MAX_TOKENS),
      maxNewlines: 200n,
      temperature: options?.temperature ?? 0.4,
      firstTemperature: options?.temperature ?? 0.4,
      topK: 50n,
      topP: 1,
      stopPatterns,
      fimEotProbThreshold: 1,
    }),
    tools: currentTools(context).map((tool) =>
      create(ChatToolDefinitionSchema, {
        name: tool.name,
        description: tool.description || '',
        jsonSchemaString: JSON.stringify(tool.parameters ?? {}),
        strict: 'strict' in tool && tool.strict === true,
      })
    ),
  });
}

async function fetchDevinAuthMetadata(
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined
): Promise<{ userJwt: string; baseUrl?: string }> {
  const request = create(GetUserJwtRequestSchema, {
    metadata: cascadeMetadata(apiKey),
  });
  const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
      accept: '*/*',
    },
    body: protoFetchBody(toBinary(GetUserJwtRequestSchema, request)),
    signal,
  });
  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(
      `Devin auth error ${response.status} ${response.statusText}: ${new TextDecoder().decode(payload)}`
    );
  }
  const decoded = decodeProto((bytes) => fromBinary(GetUserJwtResponseSchema, bytes), payload);
  if (!decoded.userJwt) throw new Error('Devin auth error: GetUserJwt returned an empty user JWT');
  const customBaseUrl = decoded.customApiServerUrl.trim();
  return {
    userJwt: decoded.userJwt,
    ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, '') } : {}),
  };
}

function readConnectTrailerError(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const err = parsed?.error;
    if (!err || typeof err !== 'object') return null;
    const code = typeof err.code === 'string' ? err.code : '';
    const message = typeof err.message === 'string' ? err.message : '';
    if (!code && !message) return null;
    return `Devin stream error${code ? ` ${code}` : ''}: ${message}`;
  } catch {
    return null;
  }
}

function streamDevin(model: PiModel, context: PiContext, options?: PiStreamOptions): PiEventStream {
  const stream = createEventStream();
  const output: PiAssistantMessage = {
    role: 'assistant',
    content: [],
    api: DEVIN_API_ID,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      if (!options?.apiKey) throw new Error('Devin 需要 OAuth 登录后才能调用');
      const fetchImpl = options.fetch ?? fetch;
      const baseUrl = (model.baseUrl || DEVIN_CASCADE_URL).replace(/\/+$/, '');
      const apiKey = normalizeDevinSessionToken(options.apiKey);
      const auth = await fetchDevinAuthMetadata(apiKey, baseUrl, fetchImpl, options.signal);
      const chatBaseUrl = auth.baseUrl ?? baseUrl;
      const request = buildDevinChatRequest(model, context, options, apiKey, auth.userJwt);
      const reqBytes = toBinary(GetChatMessageRequestSchema, request);
      const gz = gzipSync(reqBytes);
      const frame = Buffer.alloc(5 + gz.length);
      frame[0] = CONNECT_COMPRESSED_FLAG;
      frame.writeUInt32BE(gz.length, 1);
      frame.set(gz, 5);

      const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/connect+proto',
          'connect-protocol-version': '1',
          'connect-content-encoding': 'gzip',
          'accept-encoding': 'identity',
          'user-agent': 'connect-go/1.18.1 (go1.26.3)',
          'connect-accept-encoding': 'gzip',
        },
        body: frame as BodyInit,
        signal: options.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Devin API error ${response.status} ${response.statusText}: ${await response.text()}`
        );
      }
      if (!response.body) throw new Error('Devin API error: response body is empty');

      stream.push({ type: 'start', partial: output });

      let currentText: PiTextContent | null = null;
      let currentThinking: PiThinkingContent | null = null;
      const toolBlocks = new Map<string, PiToolCall>();
      const toolPartialJson = new Map<string, string>();
      let activeToolCallId: string | undefined;
      let latestStopReason = StopReason.UNSPECIFIED;

      const endText = () => {
        if (!currentText) return;
        stream.push({
          type: 'text_end',
          contentIndex: output.content.indexOf(currentText),
          content: currentText.text,
          partial: output,
        });
        currentText = null;
      };
      const endThinking = () => {
        if (!currentThinking) return;
        stream.push({
          type: 'thinking_end',
          contentIndex: output.content.indexOf(currentThinking),
          content: currentThinking.thinking,
          partial: output,
        });
        currentThinking = null;
      };

      const reader = response.body.getReader();
      let pending = Buffer.alloc(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.length > 0) {
          pending =
            pending.length === 0
              ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
              : Buffer.concat([pending, value]);
        }
        while (pending.length >= 5) {
          const flag = pending[0];
          const len = pending.readUInt32BE(1);
          if (len > MAX_CONNECT_FRAME_PAYLOAD) {
            throw new Error(
              `Devin Connect frame length ${len} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`
            );
          }
          if (pending.length < 5 + len) break;
          const payload = pending.subarray(5, 5 + len);
          pending = pending.subarray(5 + len);

          if (flag & CONNECT_END_STREAM_FLAG) {
            const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
            const trailerError = readConnectTrailerError(
              Buffer.from(trailerBytes).toString('utf8').trim()
            );
            if (trailerError) throw new Error(trailerError);
            continue;
          }

          const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
          const msg = fromBinary(GetChatMessageResponseSchema, raw);
          if (msg.messageId && 'responseId' in output) {
            (output as PiAssistantMessage & { responseId?: string }).responseId = msg.messageId;
          }

          if (msg.deltaThinking) {
            const block: PiThinkingContent = currentThinking ?? { type: 'thinking', thinking: '' };
            if (currentThinking !== block) {
              output.content.push(block);
              currentThinking = block;
              stream.push({
                type: 'thinking_start',
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            block.thinking += msg.deltaThinking;
            if (msg.deltaSignature) block.thinkingSignature = msg.deltaSignature;
            stream.push({
              type: 'thinking_delta',
              contentIndex: output.content.indexOf(block),
              delta: msg.deltaThinking,
              partial: output,
            });
          }

          if (msg.deltaText) {
            endThinking();
            const block: PiTextContent = currentText ?? { type: 'text', text: '' };
            if (currentText !== block) {
              output.content.push(block);
              currentText = block;
              stream.push({
                type: 'text_start',
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            block.text += msg.deltaText;
            stream.push({
              type: 'text_delta',
              contentIndex: output.content.indexOf(block),
              delta: msg.deltaText,
              partial: output,
            });
          }

          if (msg.deltaToolCalls.length > 0) {
            endText();
            endThinking();
            for (const tc of msg.deltaToolCalls) {
              const toolCallId = tc.id || activeToolCallId;
              if (!toolCallId) continue;
              let block: PiToolCall | undefined = toolBlocks.get(toolCallId);
              if (!block) {
                block = { type: 'toolCall', id: toolCallId, name: tc.name, arguments: {} };
                output.content.push(block);
                toolBlocks.set(toolCallId, block);
                toolPartialJson.set(toolCallId, '');
                stream.push({
                  type: 'toolcall_start',
                  contentIndex: output.content.length - 1,
                  partial: output,
                });
              }
              if (tc.name) block.name = tc.name;
              activeToolCallId = toolCallId;
              if (!tc.argumentsJson) continue;
              const previousJson = toolPartialJson.get(toolCallId) ?? '';
              const accumulated = tc.argumentsJson.startsWith(previousJson)
                ? tc.argumentsJson
                : previousJson + tc.argumentsJson;
              const delta = accumulated.slice(previousJson.length);
              toolPartialJson.set(toolCallId, accumulated);
              const parsed = parseJsonObject(accumulated);
              if (Object.keys(parsed).length > 0) block.arguments = parsed;
              stream.push({
                type: 'toolcall_delta',
                contentIndex: output.content.indexOf(block),
                delta,
                partial: output,
              });
            }
          }

          if (msg.stopReason !== StopReason.UNSPECIFIED) latestStopReason = msg.stopReason;
          if (msg.usage) {
            output.usage.input = Number(msg.usage.inputTokens);
            output.usage.output = Number(msg.usage.outputTokens);
            output.usage.cacheRead = Number(msg.usage.cacheReadTokens);
            output.usage.cacheWrite = Number(msg.usage.cacheWriteTokens);
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
          }
        }
        if (done) break;
      }

      endText();
      endThinking();
      for (const [id, block] of toolBlocks) {
        block.arguments = parseJsonObject(toolPartialJson.get(id));
        stream.push({
          type: 'toolcall_end',
          contentIndex: output.content.indexOf(block),
          toolCall: block,
          partial: output,
        });
      }

      output.stopReason =
        toolBlocks.size > 0
          ? 'toolUse'
          : latestStopReason === StopReason.MAX_TOKENS
            ? 'length'
            : 'stop';
      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
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

export function devinProviderConfig(): ProviderConfigInput {
  return {
    name: 'Devin',
    api: DEVIN_API_ID,
    baseUrl: DEVIN_CASCADE_URL,
    models: [],
    refreshModels,
    streamSimple: streamDevin,
    oauth: {
      name: 'Devin',
      isSubscription: true,
      login,
      refreshToken,
      getApiKey: (credentials) => credentials.access,
    },
  };
}
