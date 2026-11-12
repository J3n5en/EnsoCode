/** 脚点「生成中」正在经历的阶段。思考与正文必须解析到同一个起点。 */
export type GenerationElapsedPhase = 'thinking' | 'text' | 'tool';

export interface GenerationElapsedInput {
  /** 冷会话恢复 / 读历史 / 等快照：加载中不是生成中 */
  loading?: boolean;
  /** 本轮 running 开始时钉死的墙钟 */
  runStartedAt?: number;
  /**
   * 最近一次可见进展（思考 token、正文、工具）。
   * 思考阶段会一直刷新，不能拿来当脚点起点。
   */
  lastOutputAt?: number;
  phase?: GenerationElapsedPhase;
}

/**
 * 一轮回答的计时原点。思考开始就算，切到正文不重置；
 * 没有本轮起点时不退回 lastOutputAt，否则思考心跳会把读数钉在 0s。
 */
export function generationElapsedOrigin({
  loading = false,
  runStartedAt,
}: GenerationElapsedInput): number | undefined {
  if (loading) return undefined;
  return runStartedAt;
}
