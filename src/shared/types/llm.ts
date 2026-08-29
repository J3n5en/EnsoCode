/** 模型 API 协议类型，值域对齐 pi sdk 的 Api，便于后续直接接入 */
export const MODEL_API_KINDS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'ollama',
] as const;

export type ModelApiKind = (typeof MODEL_API_KINDS)[number];

/** 行级推理覆盖：未设 / 空 = 跟随 catalog 或乐观默认。不要存 `'follow'`。 */
export const MODEL_REASONING_OVERRIDES = ['on', 'off'] as const;
export type ModelReasoningOverride = (typeof MODEL_REASONING_OVERRIDES)[number];

/**
 * 行级最高思考档覆盖，值域与 `THINKING_LEVELS` 对齐。
 * 写在 llm 以免 `types/agent` ↔ `types/llm` 循环依赖。
 */
export const MODEL_THINKING_LEVEL_OVERRIDES = ['low', 'medium', 'high', 'max'] as const;
export type ModelThinkingLevelOverride = (typeof MODEL_THINKING_LEVEL_OVERRIDES)[number];

/** 自定义模型行的可选能力覆盖。缺省字段 = 跟随上一层，不在数据层填假数字。 */
export interface ModelCapabilityOverrides {
  reasoning?: ModelReasoningOverride;
  thinkingLevel?: ModelThinkingLevelOverride;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelEntry extends ModelCapabilityOverrides {
  id: string;
  label?: string;
  /** 是否启用（缺省视为启用） */
  enabled?: boolean;
  /** 允许主 agent 给 subagent/coworker 指定该模型（缺省 false = 不暴露） */
  subagent?: boolean;
}

export interface ModelProvider {
  id: string;
  name: string;
  api: ModelApiKind;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  models: ModelEntry[];
  /** 从哪个本地应用导入（手动创建时为空） */
  importedFrom?: string;
  /**
   * 订阅账号 key（见 `oauthProviders.ts` 的多账号模型）；存在即订阅条目，apiKey/baseUrl 为空。
   * 同一厂商的多个账号各占一条 ModelProvider，key 分别是 `anthropic`、`anthropic#2`…
   */
  oauthAccountKey?: string;
}

/** provider 是否具备可用凭证（API key 或订阅账号） */
export const hasProviderCredentials = (
  provider: Pick<ModelProvider, 'apiKey' | 'oauthAccountKey'>
): boolean => Boolean(provider.apiKey || provider.oauthAccountKey);
