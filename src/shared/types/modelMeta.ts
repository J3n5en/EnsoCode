import type { ThinkingLevel } from './agent';

/**
 * 模型的运行时元数据（不持久化，按需向 Main 查询）。
 *
 * ⚠️ 全部可选字段都用「缺失 = 未知」编码：
 * - 缺失 → 未知，UI 不加限制（保持现有行为）
 * - 有值 → 权威，UI 据此禁用/展示
 *
 * 不用显式 'unknown' 字面量：跨 IPC 的 JSON 序列化天然省略 undefined，
 * 少一个需要两端同步维护的枚举值。
 */
export interface ModelMeta {
  modelId: string;
  /** 上下文窗口 token 数。缺失 = 未知（UI 显示占位符，运行时按 128K 处理） */
  contextWindow?: number;
  /** 最大输出 token 数。缺失 = 未知 */
  maxTokens?: number;
  /** 缺失 = 未知（不禁用推理开关）；false = 明确不支持（禁用开关并注明原因） */
  reasoning?: boolean;
  /**
   * 支持的思考档，值域是本项目的 THINKING_LEVELS（不含 pi 的 off/minimal/xhigh）。
   * 缺失 = 未知（四档全放开）；[] = 明确不支持任何档（等价 reasoning: false）。
   * ⚠️「缺失」与「空数组」语义不同，序列化/反序列化都不许把 undefined 归一成 []。
   */
  thinkingLevels?: ThinkingLevel[];
  /** 仅用于 UI 打「估算」标记与排障，⛔ 不参与任何逻辑判定 */
  source: 'catalog' | 'catalog-fallback' | 'unknown';
}

export interface ModelMetaQuery {
  /** 订阅条目传 oauthAccountKey；API-key 条目省略 */
  oauthAccountKey?: string;
  /** 要查的模型 id；空数组 = 查该 provider 全部模型 */
  modelIds: string[];
}

export interface ModelMetaResult {
  ok: boolean;
  models: ModelMeta[];
  error?: string;
}
