import { type ChildSessionIdentity, isUuid, parseChildSessionIdentity } from './builtinAgents';
import type { OauthLoginEvent } from './types/oauthProviders';

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
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

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
