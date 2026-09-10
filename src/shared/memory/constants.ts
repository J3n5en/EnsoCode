// 数值禁止擅自修改。

export const UNIT_TYPES = [
  'fact',
  'preference',
  'decision',
  'plan',
  'procedure',
  'learning',
  'context',
  'event',
] as const;

export type UnitType = (typeof UNIT_TYPES)[number];

export function isUnitType(value: string): value is UnitType {
  return (UNIT_TYPES as readonly string[]).includes(value);
}

export const DEFAULT_UNIT_TYPE: UnitType = 'fact';
export const DEFAULT_IMPORTANCE = 0.5;

/**
 * 重要度分档。阈值必须与提炼提示词里告诉模型的标准一致
 * （prompts.ts：`0.9+ critical decision/insight; 0.7-0.9 important; 0.5-0.7 useful; <0.5 omit`）——
 * 两边漂移会导致模型按一套标准打分、界面按另一套显示，有测试锁住一致性。
 */
export const IMPORTANCE_CRITICAL = 0.9;
export const IMPORTANCE_IMPORTANT = 0.7;
export const IMPORTANCE_USEFUL = 0.5;

export type ImportanceTier = 'critical' | 'important' | 'useful' | 'low';

/** `<0.5` 提炼会丢弃，但手动写入 / 旧数据可能更低，所以保留 low 一档 */
export function importanceTier(importance: number): ImportanceTier {
  if (!Number.isFinite(importance)) return 'low';
  if (importance >= IMPORTANCE_CRITICAL) return 'critical';
  if (importance >= IMPORTANCE_IMPORTANT) return 'important';
  if (importance >= IMPORTANCE_USEFUL) return 'useful';
  return 'low';
}
export const AGENT_CREATE_IMPORTANCE = 0.6;

export const HALF_LIFE_DAYS = 30;
export const RECENCY_W = 0.7;
export const FREQUENCY_W = 0.3;
export const FREQUENCY_MAX_COUNT = 100;
export const MIN_FLOOR = 0.3;
export const IMP_MULT = 0.2;
export const DECAY_WEIGHT = 0.15;

export const RRF_K = 60;
// MMR = λ·relevance − (1−λ)·max(sim to selected)
export const MMR_LAMBDA = 0.7;

export const DEDUP_VECTOR = 0.8;
export const DEDUP_MAX = 3;
export const DEDUP_MIN_CHARS = 100;

export const EVOLVES_MIN_CONF = 0.7;
// content_relation 闭集
export const EVOLVES_RELATIONS = ['replaces', 'enriches', 'confirms', 'challenges'] as const;
export type EvolvesRelation = (typeof EVOLVES_RELATIONS)[number];
export function isEvolvesRelation(value: unknown): value is EvolvesRelation {
  return (EVOLVES_RELATIONS as readonly unknown[]).includes(value);
}
export const CRYSTAL_MIN_SOURCES = 3;
// 检索加权：crystal 行在混分之后乘 1.25。排序口径是 RRF + blend，
//   只把这一项乘在 finalScore 上，不引入其它乘法项。
export const CRYSTAL_BOOST = 1.25;

// 蒸馏：块上限 `min(max_chunk_size, 4000)`；importance 阈值取提示词 “<0.5 omit”
export const DISTILL_MAX_CHUNK_CHARS = 4000;
export const DISTILL_MIN_IMPORTANCE = 0.5;
// 暂时性失败（provider 超时 / 输出不可解析）保留 pending 重试的上限；超过则标 done 记 error，避免坏会话无限烧调用
export const DISTILL_MAX_ATTEMPTS = 3;

// 实体图谱 Level 1：“Up to 10 entities and 20 relationships”
export const KG_MAX_ENTITIES = 10;
export const KG_MAX_RELATIONS = 20;
// 长度上限是本项目加的防线（模型返回超大字段不能打爆库）
export const KG_MAX_ENTITY_NAME_CHARS = 100;
export const KG_MAX_DESCRIPTION_CHARS = 300;
export const KG_MAX_LABEL_CHARS = 40;
// 与 DISTILL_MAX_ATTEMPTS 同理：暂时性失败重试上限
export const KG_MAX_ATTEMPTS = 3;
// Level 2：分析最多 15 个实体，保留 confidence≥0.7，最多 10 个名字；上下文 >2000 字取头 1000 + 尾 800
export const KG_L2_MAX_ANALYZE = 15;
export const KG_L2_MIN_CONFIDENCE = 0.7;
export const KG_L2_CONTEXT_MAX_CHARS = 2000;
export const KG_L2_HEAD_CHARS = 1000;
export const KG_L2_TAIL_CHARS = 800;
// 类型 / 关系建议表。是建议不是闭集：模型给出表外英文标签照收（归一为 UPPER_SNAKE），空 / 非英文回退缺省值
export const KG_ENTITY_TYPES = [
  'PERSON',
  'ORGANIZATION',
  'TEAM',
  'COMMUNITY',
  'LOCATION',
  'PLACE',
  'REGION',
  'FACILITY',
  'PRODUCT',
  'TOOL',
  'DEVICE',
  'MATERIAL',
  'RESOURCE',
  'CONCEPT',
  'METHOD',
  'TECHNIQUE',
  'THEORY',
  'PRINCIPLE',
  'EVENT',
  'ACTIVITY',
  'PROCESS',
  'PROJECT',
  'DOCUMENT',
  'PUBLICATION',
  'MEDIA',
  'DATASET',
  'SYSTEM',
  'SERVICE',
  'PLATFORM',
  'STANDARD',
  'TERM',
] as const;
export const KG_DEFAULT_ENTITY_TYPE = 'CONCEPT';
export const KG_RELATION_TYPES = [
  'USES',
  'CREATES',
  'PRODUCES',
  'AFFECTS',
  'MODIFIES',
  'CONTAINS',
  'PART_OF',
  'BELONGS_TO',
  'CONSISTS_OF',
  'RELATED_TO',
  'WORKS_WITH',
  'CONNECTED_TO',
  'ASSOCIATED_WITH',
  'SIMILAR_TO',
  'DIFFERENT_FROM',
  'REPLACES',
  'ALTERNATIVE_TO',
  'REQUIRES',
  'DEPENDS_ON',
  'ENABLES',
  'SUPPORTS',
  'DESCRIBES',
  'EXPLAINS',
  'REPRESENTS',
  'IMPLEMENTS',
] as const;
export const KG_DEFAULT_RELATION_TYPE = 'RELATED_TO';
