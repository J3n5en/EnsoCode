// 已移除的 Enso 能力层遗留的回执类型：仅供历史 safe journal / custom entry 读兼容。
import { type ChildSessionIdentity, isUuid, parseChildSessionIdentity } from '../builtinAgents';
import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceId } from '../productSurfaces';

export type JsonSchema = {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly uniqueItems?: boolean;
};

export type CapabilityRisk = 'read' | 'reversible' | 'dangerous';

export type CapabilityResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      code: 'denied' | 'invalid' | 'failed' | 'unavailable' | 'cancelled';
      error: string;
      suggestedAction?: string;
    };

export const CAPABILITY_SUBJECT_KINDS = [
  'setting',
  'provider',
  'account',
  'agent-type',
  'preset',
  'tool',
  'project',
  'conversation',
  'coworker',
  'other',
] as const;
export type CapabilitySubjectKind = (typeof CAPABILITY_SUBJECT_KINDS)[number];

export interface CapabilitySubject {
  kind: CapabilitySubjectKind;
  id: string;
  label: string;
}

export interface CapabilityChange {
  field: string;
  previous: unknown;
  value: unknown;
}

export const CAPABILITY_OUTCOMES = [
  'succeeded',
  'denied',
  'failed',
  'unavailable',
  'cancelled',
] as const;
export type CapabilityOutcome = (typeof CAPABILITY_OUTCOMES)[number];

export interface CapabilityReceipt {
  receiptId: string;
  operationId: string;
  child: ChildSessionIdentity;
  turnId: string;
  requestId: string;
  capabilityId: ProductSurfaceId;
  risk: CapabilityRisk;
  subject: CapabilitySubject;
  outcome: CapabilityOutcome;
  summary: string;
  changes?: readonly CapabilityChange[];
  suggestedAction?: string;
  occurredAt: number;
  sequence: number;
}

export interface CapabilityExecutionEnvelope {
  modelResult: CapabilityResult;
  receipt: CapabilityReceipt;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
const isProductSurfaceId = (value: unknown): value is ProductSurfaceId =>
  typeof value === 'string' && Object.hasOwn(PRODUCT_SURFACE_INVENTORY, value);

export function parseCapabilityResult(value: unknown): CapabilityResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null;
  if (value.ok) {
    return hasExactKeys(value, ['ok', 'data']) ? { ok: true, data: value.data } : null;
  }
  if (
    !hasOnlyKeys(value, ['ok', 'code', 'error', 'suggestedAction']) ||
    (value.code !== 'denied' &&
      value.code !== 'invalid' &&
      value.code !== 'failed' &&
      value.code !== 'unavailable' &&
      value.code !== 'cancelled') ||
    !isNonEmptyString(value.error) ||
    (value.suggestedAction !== undefined && !isNonEmptyString(value.suggestedAction))
  ) {
    return null;
  }
  return value as unknown as CapabilityResult;
}

function parseCapabilitySubject(value: unknown): CapabilitySubject | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'id', 'label'])) return null;
  return CAPABILITY_SUBJECT_KINDS.includes(value.kind as CapabilitySubjectKind) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label)
    ? (value as unknown as CapabilitySubject)
    : null;
}

function parseCapabilityChange(value: unknown): CapabilityChange | null {
  if (!isRecord(value) || !hasExactKeys(value, ['field', 'previous', 'value'])) return null;
  return isNonEmptyString(value.field) ? (value as unknown as CapabilityChange) : null;
}

export function parseCapabilityReceipt(value: unknown): CapabilityReceipt | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'receiptId',
      'operationId',
      'child',
      'turnId',
      'requestId',
      'capabilityId',
      'risk',
      'subject',
      'outcome',
      'summary',
      'changes',
      'suggestedAction',
      'occurredAt',
      'sequence',
    ]) ||
    !isUuid(value.receiptId) ||
    !isNonEmptyString(value.operationId) ||
    !parseChildSessionIdentity(value.child) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.requestId) ||
    !isProductSurfaceId(value.capabilityId) ||
    (value.risk !== 'read' && value.risk !== 'reversible' && value.risk !== 'dangerous') ||
    !parseCapabilitySubject(value.subject) ||
    !CAPABILITY_OUTCOMES.includes(value.outcome as CapabilityOutcome) ||
    !isNonEmptyString(value.summary) ||
    (value.changes !== undefined &&
      (!Array.isArray(value.changes) ||
        value.changes.some((change) => parseCapabilityChange(change) === null))) ||
    (value.suggestedAction !== undefined && !isNonEmptyString(value.suggestedAction)) ||
    typeof value.occurredAt !== 'number' ||
    !Number.isFinite(value.occurredAt) ||
    !Number.isInteger(value.sequence) ||
    (value.sequence as number) < 0
  ) {
    return null;
  }
  return value as unknown as CapabilityReceipt;
}
