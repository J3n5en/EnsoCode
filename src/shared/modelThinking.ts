/**
 * 思考档支持性判定。逻辑照抄 pi-ai 0.84.3 的
 * `dist/models.js:547-578`（getSupportedThinkingLevels / clampThinkingLevel）——
 * 这两个函数没有从 @earendil-works/pi-coding-agent 的公开出口导出
 * （dist/index.d.ts 全量核对），且 @earendil-works/pi-ai 不在依赖树顶层
 * （见 src/shared/providers/piProviderTypes.ts 的同类说明），只能同构复刻。
 * ⚠️ pi 侧升级后必须重新核对 models.js 的这两个函数。
 *
 * 现场原文（node_modules/.pnpm/@earendil-works+pi-ai@0.84.3_…/dist/models.js）：
 * - 548-559 getSupportedThinkingLevels：`reasoning:false` → `["off"]`；
 *   `thinkingLevelMap[level] === null` 剔除；`xhigh`/`max` 必须显式声明才算支持；
 *   其余档（off/minimal/low/medium/high）恒支持。
 * - 560-578 clampThinkingLevel：命中即返回；否则先向上（更高档）再向下，
 *   都没有则 `availableLevels[0] ?? "off"`。全程静默。
 */
import { THINKING_LEVELS, type ThinkingLevel } from './types/agent';

/** pi 的完整档位序（含我们不暴露的 off/minimal/xhigh），钳位方向依赖这个顺序 */
const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

type PiThinkingLevel = (typeof PI_LEVELS)[number];

export interface ThinkingCapableModel {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

function supportedPiLevels(model: ThinkingCapableModel): PiThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  return PI_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/** 从 pi 模型对象算出本项目四档里哪些可用（`reasoning:false` → `[]`） */
export function supportedProjectThinkingLevels(model: ThinkingCapableModel): ThinkingLevel[] {
  if (!model.reasoning) return [];
  const supported = supportedPiLevels(model);
  return THINKING_LEVELS.filter((level) => supported.includes(level));
}

/**
 * 与 pi clampThinkingLevel 同向的降级：先向上、再向下、兜底第一个可用。
 * `supported === undefined` 表示未知，原样返回 level。
 */
export function clampProjectThinkingLevel(
  level: ThinkingLevel,
  supported: ThinkingLevel[] | undefined
): ThinkingLevel {
  if (supported === undefined) return level;
  if (supported.includes(level)) return level;
  if (supported.length === 0) return level;

  const requestedIndex = PI_LEVELS.indexOf(level);
  for (let i = requestedIndex; i < PI_LEVELS.length; i++) {
    const candidate = PI_LEVELS[i];
    if (isProjectLevel(candidate) && supported.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = PI_LEVELS[i];
    if (isProjectLevel(candidate) && supported.includes(candidate)) return candidate;
  }
  return supported[0] ?? level;
}

function isProjectLevel(level: PiThinkingLevel): level is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(level);
}
