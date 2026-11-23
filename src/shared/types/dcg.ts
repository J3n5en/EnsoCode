export interface DcgStatus {
  supported: boolean;
  installed: boolean;
  version: string;
}

export interface DcgActionResult {
  ok: boolean;
  status: DcgStatus;
  error?: string;
}

/** 手动「检查更新」结果；current 是 EnsoCode 内置（固定 sha256）的 dcg 版本 */
export type DcgUpdateCheck =
  | { status: 'latest'; current: string; latest: string }
  | { status: 'available'; current: string; latest: string }
  | { status: 'failed'; current: string; reason: 'network' | 'rate-limited' | 'invalid' };

export interface DcgRuleState {
  allowCount: number;
  exempt: boolean;
  suggestExempt: boolean;
}

export interface DcgRuleExemption {
  ruleId: string;
  dcgVersion: string;
  at: number;
}

/** deny / ask 进审批链；warn 只提示不拦 */
export const DCG_GUARD_DECISIONS = ['deny', 'ask', 'warn'] as const;
export type DcgGuardDecision = (typeof DCG_GUARD_DECISIONS)[number];

export const DCG_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type DcgSeverity = (typeof DCG_SEVERITIES)[number];

export const DCG_EXPLANATION_MAX = 4000;
export const DCG_MATCHED_MAX = 500;
/** 内置系统 Temp 根删除守卫规则 ID（与 dcg 规则共存，跨层共享避免重复硬编码） */
export const TEMP_ROOT_RULE_ID = 'enso.windows:temp-root-delete';

/** dcg 命中；decision 缺省按 deny 处理 */
export interface DcgGuardHit {
  ruleId: string;
  reason: string;
  decision?: DcgGuardDecision;
  severity?: DcgSeverity;
  /** dcg 的英文长说明 */
  explanation?: string;
  /** matched_span 对应的命令片段 */
  matched?: string;
}

/** warn 档写进 bash / powershell 结果 details.dcgWarning 的提示 */
export type DcgWarning = Pick<DcgGuardHit, 'ruleId' | 'reason' | 'severity'>;

const GUARD_KEYS = new Set(['ruleId', 'reason', 'decision', 'severity', 'explanation', 'matched']);
const WARNING_KEYS = new Set(['ruleId', 'reason', 'severity']);

const optionalText = (value: unknown, max: number) =>
  value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max);

function isGuardShape(value: unknown, keys: ReadonlySet<string>): value is DcgGuardHit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => keys.has(key)) &&
    typeof record.ruleId === 'string' &&
    record.ruleId.length > 0 &&
    typeof record.reason === 'string' &&
    record.reason.length > 0 &&
    (record.decision === undefined ||
      (DCG_GUARD_DECISIONS as readonly unknown[]).includes(record.decision)) &&
    (record.severity === undefined ||
      (DCG_SEVERITIES as readonly unknown[]).includes(record.severity)) &&
    optionalText(record.explanation, DCG_EXPLANATION_MAX) &&
    optionalText(record.matched, DCG_MATCHED_MAX)
  );
}

export const isDcgGuardHit = (value: unknown): value is DcgGuardHit =>
  isGuardShape(value, GUARD_KEYS);

export const isDcgWarning = (value: unknown): value is DcgWarning =>
  isGuardShape(value, WARNING_KEYS);
