import type { ModelApiKind } from './llm';

/** 拉取模型 / 连通性测试所需的最小 provider 配置 */
export interface ProviderApiConfig {
  api: ModelApiKind;
  apiKey: string;
  baseUrl: string;
}

/** 拉取模型列表时从响应里识别出的单个模型（元数据字段可能缺失） */
export interface FetchedModel {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ListModelsResult {
  ok: boolean;
  models: FetchedModel[];
  error?: string;
}

export interface TestProviderResult {
  ok: boolean;
  latencyMs: number;
  /** 成功时为使用的模型，失败时为错误信息 */
  message: string;
}
