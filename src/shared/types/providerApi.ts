import type { ModelApiKind } from './llm';

/** 拉取模型 / 连通性测试所需的最小 provider 配置 */
export interface ProviderApiConfig {
  api: ModelApiKind;
  apiKey: string;
  baseUrl: string;
}

export interface ListModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export interface TestProviderResult {
  ok: boolean;
  latencyMs: number;
  /** 成功时为使用的模型，失败时为错误信息 */
  message: string;
}
