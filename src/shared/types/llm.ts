/** 模型 API 协议类型，值域对齐 pi sdk 的 Api，便于后续直接接入 */
export const MODEL_API_KINDS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'ollama',
] as const;

/** 注册模型时统一声明的上下文窗口（worker spawn 与渲染层水位表共用） */
export const MODEL_CONTEXT_WINDOW = 200_000;

export type ModelApiKind = (typeof MODEL_API_KINDS)[number];

export interface ModelEntry {
  id: string;
  label?: string;
  /** 是否启用（缺省视为启用） */
  enabled?: boolean;
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
}
