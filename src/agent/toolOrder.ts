import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

type StreamMethod = (model: Model<Api>, context: Context, options?: unknown) => unknown;

/**
 * 工具声明按名称稳定排序：同一工具集合不随 MCP 连接先后、重启恢复而换序，
 * 保住 tools → system → messages 前缀的 prompt cache（借鉴 qwen-code global-tool-schema-stable-sort）。
 */
export function stableToolOrder(context: Context): Context {
  const tools = context.tools;
  if (!tools || tools.length < 2) return context;
  if (tools.every((tool, i) => i === 0 || tools[i - 1].name <= tool.name)) return context;
  return {
    ...context,
    tools: [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/** 包共享 runtime 的两个出口：会话、压缩、辅助补全的请求都经过这里 */
export function installStableToolOrder(runtime: ModelRuntime): void {
  const target = runtime as unknown as Partial<Record<'stream' | 'streamSimple', StreamMethod>>;
  for (const name of ['stream', 'streamSimple'] as const) {
    const method = target[name];
    if (typeof method !== 'function') continue;
    const original = method.bind(runtime);
    target[name] = (model, context, options) => original(model, stableToolOrder(context), options);
  }
}
