import {
  type ChildSessionIdentity,
  isSameChildSessionIdentity,
  isUuid,
  parseChildSessionIdentity,
} from '../builtinAgents';
import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceId } from '../productSurfaces';
import type { OauthLoginEvent } from '../types/oauthProviders';

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
export type TargetContext = 'global' | 'origin-window' | 'origin-project' | 'origin-conversation';

export type AvailabilityRequirement =
  | { kind: 'default-model' }
  | { kind: 'configured-provider' }
  | { kind: 'oauth-provider' }
  | { kind: 'origin-window' }
  | { kind: 'origin-project' }
  | { kind: 'origin-conversation' }
  | { kind: 'started-origin-conversation' }
  | { kind: 'desktop-updater' };

export type CapabilityExecution<HandlerId extends string = string> =
  | { kind: 'executable'; handlerId: HandlerId }
  | { kind: 'known-unavailable'; reason: string; suggestedAction: string };

export interface CapabilitySpec<Id extends string = string, HandlerId extends string = string> {
  id: Id;
  domain: string;
  description: string;
  inputSchema: JsonSchema;
  resultSchema?: JsonSchema;
  risk: CapabilityRisk;
  targetContext: TargetContext;
  availability: readonly AvailabilityRequirement[];
  execution: CapabilityExecution<HandlerId>;
}

export type CapabilityResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      code: 'denied' | 'invalid' | 'failed' | 'unavailable' | 'cancelled';
      error: string;
      suggestedAction?: string;
    };

export interface ParentCapabilityBinding {
  parentConversationId: string;
  parentProjectId: string;
  parentProjectPath: string;
}

export interface CapabilityInvocationContext {
  child: ChildSessionIdentity;
  parentBinding: ParentCapabilityBinding;
  turnId: string;
  ownerWebContentsId: number;
}

export interface CapabilityInvokeRequest {
  child: ChildSessionIdentity;
  turnId: string;
  requestId: string;
  capabilityId: ProductSurfaceId;
  params: unknown;
}

export type CapabilityAskHost = {
  kind: 'oauth-login';
  providerId: string;
  providerLabel: string;
};

export interface CapabilityAskRequest {
  child: ChildSessionIdentity;
  turnId: string;
  requestId: string;
  capabilityId: ProductSurfaceId;
  summary: string;
  host?: CapabilityAskHost;
}

export interface CapabilityAskResponse {
  child: ChildSessionIdentity;
  turnId: string;
  requestId: string;
  decision: 'allow' | 'deny';
}

export type DangerousExecutionState =
  | 'queued'
  | 'waiting-decision'
  | 'executing'
  | 'cancel-requested'
  | 'settled';

export type CapabilityAskDecisionAck =
  | {
      ok: true;
      accepted: true;
      state: 'executing' | 'settled';
    }
  | {
      ok: true;
      accepted: false;
      state: DangerousExecutionState;
    }
  | { ok: false; accepted: false; state: DangerousExecutionState; error: string };

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

export type ReceiptLifecycleEvent =
  | {
      type: 'receipt-started';
      child: ChildSessionIdentity;
      turnId: string;
      requestId: string;
      receiptId: string;
      receiptSeq: number;
      executionState: 'executing' | 'cancel-requested';
    }
  | {
      type: 'receipt-settled';
      child: ChildSessionIdentity;
      turnId: string;
      requestId: string;
      receiptId: string;
      receiptSeq: number;
      executionState: 'settled';
      receipt: CapabilityReceipt;
    };

export interface CapabilityExecutionEnvelope {
  modelResult: CapabilityResult;
  receipt: CapabilityReceipt;
}

export type OauthFlowLocator =
  | {
      flowId: string;
      host: 'provider-wizard';
      ownerWebContentsId: number;
    }
  | {
      flowId: string;
      host: 'agent-child-tab';
      ownerWebContentsId: number;
      child: ChildSessionIdentity;
      turnId: string;
      requestId: string;
    };

export interface StartOauthWizardRequest {
  providerId: string;
}

export interface OauthFlowPromptResponse {
  locator: OauthFlowLocator;
  requestId: string;
  value: string;
}

export interface OauthFlowControlRequest {
  locator: OauthFlowLocator;
}

export type StartOauthResult =
  | { status: 'started'; locator: OauthFlowLocator }
  | { status: 'busy'; activeHost: OauthFlowLocator['host'] }
  | { status: 'failed'; code: string; message: string };

export interface OauthFlowEvent {
  locator: OauthFlowLocator;
  event: OauthLoginEvent;
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

export function parseCapabilityAskHost(value: unknown): CapabilityAskHost | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'providerId', 'providerLabel'])) {
    return null;
  }
  return value.kind === 'oauth-login' &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.providerLabel)
    ? (value as unknown as CapabilityAskHost)
    : null;
}

function parseParentCapabilityBinding(value: unknown): ParentCapabilityBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['parentConversationId', 'parentProjectId', 'parentProjectPath'])
  ) {
    return null;
  }
  return isNonEmptyString(value.parentConversationId) &&
    isNonEmptyString(value.parentProjectId) &&
    isNonEmptyString(value.parentProjectPath)
    ? (value as unknown as ParentCapabilityBinding)
    : null;
}

export function parseCapabilityInvocationContext(
  value: unknown
): CapabilityInvocationContext | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['child', 'parentBinding', 'turnId', 'ownerWebContentsId']) ||
    !parseChildSessionIdentity(value.child) ||
    !parseParentCapabilityBinding(value.parentBinding) ||
    !isNonEmptyString(value.turnId) ||
    !Number.isInteger(value.ownerWebContentsId) ||
    (value.ownerWebContentsId as number) < 0
  ) {
    return null;
  }
  return value as unknown as CapabilityInvocationContext;
}

export function parseCapabilityInvokeRequest(value: unknown): CapabilityInvokeRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['child', 'turnId', 'requestId', 'capabilityId', 'params']) ||
    !parseChildSessionIdentity(value.child) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.requestId) ||
    !isProductSurfaceId(value.capabilityId)
  ) {
    return null;
  }
  return value as unknown as CapabilityInvokeRequest;
}

export function parseCapabilityAskRequest(value: unknown): CapabilityAskRequest | null {
  if (!isRecord(value)) return null;
  const host = value.host === undefined ? undefined : parseCapabilityAskHost(value.host);
  if (
    !hasOnlyKeys(value, ['child', 'turnId', 'requestId', 'capabilityId', 'summary', 'host']) ||
    !parseChildSessionIdentity(value.child) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.requestId) ||
    !isProductSurfaceId(value.capabilityId) ||
    !isNonEmptyString(value.summary) ||
    (value.host !== undefined && !host)
  ) {
    return null;
  }
  return value as unknown as CapabilityAskRequest;
}

export function parseCapabilityAskResponse(value: unknown): CapabilityAskResponse | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['child', 'turnId', 'requestId', 'decision']) ||
    !parseChildSessionIdentity(value.child) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.requestId) ||
    (value.decision !== 'allow' && value.decision !== 'deny')
  ) {
    return null;
  }
  return value as unknown as CapabilityAskResponse;
}

export function parseCapabilityAskDecisionAck(value: unknown): CapabilityAskDecisionAck | null {
  if (!isRecord(value)) return null;
  const states: readonly DangerousExecutionState[] = [
    'queued',
    'waiting-decision',
    'executing',
    'cancel-requested',
    'settled',
  ];
  if (
    typeof value.ok !== 'boolean' ||
    typeof value.accepted !== 'boolean' ||
    !states.includes(value.state as DangerousExecutionState)
  ) {
    return null;
  }
  if (value.ok) {
    if (!hasExactKeys(value, ['ok', 'accepted', 'state'])) return null;
    if (value.accepted && value.state !== 'executing' && value.state !== 'settled') {
      return null;
    }
    return value as unknown as CapabilityAskDecisionAck;
  }
  return !value.accepted &&
    hasExactKeys(value, ['ok', 'accepted', 'state', 'error']) &&
    isNonEmptyString(value.error)
    ? (value as unknown as CapabilityAskDecisionAck)
    : null;
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

export function parseReceiptLifecycleEvent(value: unknown): ReceiptLifecycleEvent | null {
  if (!isRecord(value)) return null;
  const common =
    parseChildSessionIdentity(value.child) &&
    isNonEmptyString(value.turnId) &&
    isNonEmptyString(value.requestId) &&
    isUuid(value.receiptId) &&
    Number.isInteger(value.receiptSeq) &&
    (value.receiptSeq as number) >= 0;
  if (!common) return null;
  if (value.type === 'receipt-started') {
    return hasExactKeys(value, [
      'type',
      'child',
      'turnId',
      'requestId',
      'receiptId',
      'receiptSeq',
      'executionState',
    ]) &&
      (value.executionState === 'executing' || value.executionState === 'cancel-requested')
      ? (value as unknown as ReceiptLifecycleEvent)
      : null;
  }
  if (value.type !== 'receipt-settled' || value.executionState !== 'settled') return null;
  const receipt = parseCapabilityReceipt(value.receipt);
  return hasExactKeys(value, [
    'type',
    'child',
    'turnId',
    'requestId',
    'receiptId',
    'receiptSeq',
    'executionState',
    'receipt',
  ]) &&
    receipt &&
    receipt.receiptId === value.receiptId &&
    receipt.turnId === value.turnId &&
    receipt.requestId === value.requestId &&
    receipt.sequence === value.receiptSeq &&
    isSameChildSessionIdentity(receipt.child, value.child)
    ? (value as unknown as ReceiptLifecycleEvent)
    : null;
}

export function parseCapabilityExecutionEnvelope(
  value: unknown
): CapabilityExecutionEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, ['modelResult', 'receipt'])) return null;
  const modelResult = parseCapabilityResult(value.modelResult);
  const receipt = parseCapabilityReceipt(value.receipt);
  return modelResult && receipt ? { modelResult, receipt } : null;
}

export function parseOauthFlowLocator(value: unknown): OauthFlowLocator | null {
  if (!isRecord(value) || !isUuid(value.flowId)) return null;
  if (!Number.isInteger(value.ownerWebContentsId) || (value.ownerWebContentsId as number) < 0) {
    return null;
  }
  if (value.host === 'provider-wizard') {
    return hasExactKeys(value, ['flowId', 'host', 'ownerWebContentsId'])
      ? (value as unknown as OauthFlowLocator)
      : null;
  }
  if (value.host !== 'agent-child-tab') return null;
  return hasExactKeys(value, [
    'flowId',
    'host',
    'ownerWebContentsId',
    'child',
    'turnId',
    'requestId',
  ]) &&
    parseChildSessionIdentity(value.child) &&
    isNonEmptyString(value.turnId) &&
    isNonEmptyString(value.requestId)
    ? (value as unknown as OauthFlowLocator)
    : null;
}

export function parseStartOauthWizardRequest(value: unknown): StartOauthWizardRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ['providerId'])) return null;
  return isNonEmptyString(value.providerId) ? { providerId: value.providerId } : null;
}

export function parseOauthFlowPromptResponse(value: unknown): OauthFlowPromptResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['locator', 'requestId', 'value'])) {
    return null;
  }
  return parseOauthFlowLocator(value.locator) &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.value)
    ? (value as unknown as OauthFlowPromptResponse)
    : null;
}

export function parseOauthFlowControlRequest(value: unknown): OauthFlowControlRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ['locator'])) return null;
  return parseOauthFlowLocator(value.locator)
    ? (value as unknown as OauthFlowControlRequest)
    : null;
}

export function parseStartOauthResult(value: unknown): StartOauthResult | null {
  if (!isRecord(value)) return null;
  switch (value.status) {
    case 'started':
      return hasExactKeys(value, ['status', 'locator']) && parseOauthFlowLocator(value.locator)
        ? (value as unknown as StartOauthResult)
        : null;
    case 'completed':
      return null;
    case 'busy':
      return hasExactKeys(value, ['status', 'activeHost']) &&
        (value.activeHost === 'provider-wizard' || value.activeHost === 'agent-child-tab')
        ? (value as unknown as StartOauthResult)
        : null;
    case 'failed':
      return hasExactKeys(value, ['status', 'code', 'message']) &&
        isNonEmptyString(value.code) &&
        isNonEmptyString(value.message)
        ? (value as unknown as StartOauthResult)
        : null;
    default:
      return null;
  }
}

function isOauthLoginEvent(value: unknown): value is OauthLoginEvent {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  switch (value.type) {
    case 'info':
    case 'progress':
    case 'error':
      return isNonEmptyString(value.message);
    case 'auth_url':
      return (
        isNonEmptyString(value.url) &&
        (value.instructions === undefined || typeof value.instructions === 'string')
      );
    case 'device_code':
      return isNonEmptyString(value.userCode) && isNonEmptyString(value.verificationUri);
    case 'prompt':
      return isRecord(value.prompt) && isNonEmptyString(value.prompt.requestId);
    case 'prompt-cancel':
      return isNonEmptyString(value.requestId);
    case 'done':
      return isNonEmptyString(value.providerId) && isRecord(value.account);
    default:
      return false;
  }
}

export function parseOauthFlowEvent(value: unknown): OauthFlowEvent | null {
  if (!isRecord(value) || !hasExactKeys(value, ['locator', 'event'])) return null;
  return parseOauthFlowLocator(value.locator) && isOauthLoginEvent(value.event)
    ? (value as unknown as OauthFlowEvent)
    : null;
}
