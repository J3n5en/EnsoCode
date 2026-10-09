/**
 * pi 分类器 choice（单选）题的概率表合法性：讨论判断（discussRoute）与首轮智能选人（smartRoute）共用。
 *
 * 规则要对 pi 的所有分类器后端成立。分三层看：
 *
 * 1. 协议要求：choice 是单选概率分布。TypeSafe 文档写明值是 "floats that sum to 1"
 *    （api.md）/ "The sum of all values is 1"（choice.md）；Cloudflare 的 JSON schema 只约束
 *    每个值在 [0, 1]，但 schema 表达不了跨字段约束，不能理解成允许总和超过 1。
 * 2. adapter 实际行为：llama-cpp-classify 本地对全部选项做 softmax，键表完整、和为 1（只有浮点误差）；
 *    System One 系（TypeSafe / OpenRouter / Vercel / OpenCode / Cloudflare）原样透传服务端概率表，
 *    不补键、不归一化、不校验总和。透传只说明 adapter 宽松，不说明服务端会返回超额表。
 * 3. 应用层容差策略：
 *    - 只认本题选项的键：名单外的键说明回答与题目对不上；
 *    - 每个值必须是 [0, 1] 内的有限数；缺的选项按 0；至少要有一个选项的概率大于 0；
 *    - 总和上限 = 1 + 0.005 × 已返回的选项数 + 1e-9。推导：文档示例值是两位小数，
 *      假设每个值按两位小数四舍五入，单值最大误差 0.005，n 个值累计最多 0.005n；1e-9 吸收浮点累加误差。
 *      这是按舍入推出来的应用层容差，文档并没有明写精度保证。三项表上限 1.015：0.99、1.01 接受，1.1、2、3 拒绝；
 *    - 不设下限：稀疏表缺的概率去向未知，总和小于 1 合法；
 *    - 不补键、不重新归一化：调用方按原值比较阈值。
 */

/** 每个返回值按两位小数四舍五入时的最大舍入误差（应用层推定，非协议保证） */
const ROUNDING_SLACK_PER_VALUE = 0.005;
/** 浮点累加误差余量 */
const FLOAT_EPSILON = 1e-9;

/** 合法时原样返回概率表（只含已返回的键），不合法返回 null */
export function validChoiceProbabilities(
  probabilities: unknown,
  keys: Iterable<string>
): Readonly<Record<string, number>> | null {
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities))
    return null;
  const values = probabilities as Record<string, unknown>;
  const allowed = new Set(keys);
  const returned = Object.keys(values);
  let mass = 0;
  for (const key of returned) {
    if (!allowed.has(key)) return null;
    const value = values[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
    mass += value;
  }
  if (mass <= 0 || mass > 1 + ROUNDING_SLACK_PER_VALUE * returned.length + FLOAT_EPSILON)
    return null;
  return values as Record<string, number>;
}
