import type {
  RemoteLinkStatus,
  RemotePushError,
  RemotePushSubscription,
} from '@shared/remoteBridge';
import type { ConnState } from '../client';
import type { PushFailureReason } from '../push';

export interface DeskLinkModel {
  deviceLabel: string;
  state: ConnState;
  transport: 'relay' | 'direct';
  rttMs: number | null;
  vapidPublicKey: string | null;
  pushEnabled: boolean;
  pushBusy: boolean;
  pushError: PushFailureReason | null;
}

export type DeskLinkEvent =
  | { type: 'state'; state: ConnState }
  | { type: 'transport'; transport: 'relay' | 'direct' }
  | { type: 'rtt'; rttMs: number }
  | { type: 'push-config'; key: string }
  | { type: 'push'; enabled: boolean; busy: boolean; error: PushFailureReason | null };

export function initialDeskLink(deviceLabel: string, pushEnabled: boolean): DeskLinkModel {
  return {
    deviceLabel,
    state: 'connecting',
    transport: 'relay',
    rttMs: null,
    vapidPublicKey: null,
    pushEnabled,
    pushBusy: false,
    pushError: null,
  };
}

export function reduceDeskLink(model: DeskLinkModel, event: DeskLinkEvent): DeskLinkModel {
  switch (event.type) {
    case 'state':
      return model.state === event.state ? model : { ...model, state: event.state };
    case 'transport':
      return model.transport === event.transport ? model : { ...model, transport: event.transport };
    case 'rtt':
      return model.rttMs === event.rttMs ? model : { ...model, rttMs: event.rttMs };
    case 'push-config':
      return model.vapidPublicKey === event.key ? model : { ...model, vapidPublicKey: event.key };
    case 'push':
      if (
        model.pushEnabled === event.enabled &&
        model.pushBusy === event.busy &&
        model.pushError === event.error
      ) {
        return model;
      }
      return {
        ...model,
        pushEnabled: event.enabled,
        pushBusy: event.busy,
        pushError: event.error,
      };
  }
}

const PUSH_ERRORS: readonly RemotePushError[] = [
  'unsupported',
  'permission-denied',
  'service-unreachable',
  'subscribe-failed',
];

export function parseRemotePushSubscription(value: unknown): RemotePushSubscription | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { endpoint?: unknown; keys?: unknown };
  if (typeof record.endpoint !== 'string' || record.endpoint.length === 0) return null;
  if (!record.keys || typeof record.keys !== 'object') return null;
  const keys = record.keys as { p256dh?: unknown; auth?: unknown };
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length === 0) return null;
  if (typeof keys.auth !== 'string' || keys.auth.length === 0) return null;
  return { endpoint: record.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export function parsePushPending(value: unknown): {
  busy: boolean;
  enabled: boolean;
  error: PushFailureReason | null;
} | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { busy?: unknown; enabled?: unknown; error?: unknown };
  if (typeof record.busy !== 'boolean' || typeof record.enabled !== 'boolean') return null;
  if (record.error == null) return { busy: record.busy, enabled: record.enabled, error: null };
  if (typeof record.error !== 'string' || !PUSH_ERRORS.includes(record.error as RemotePushError)) {
    return null;
  }
  return {
    busy: record.busy,
    enabled: record.enabled,
    error: record.error as PushFailureReason,
  };
}

export function toRemoteLinkStatus(
  model: DeskLinkModel,
  pushAvailability: RemoteLinkStatus['pushAvailability']
): RemoteLinkStatus {
  return {
    deviceLabel: model.deviceLabel,
    state: model.state,
    transport: model.transport,
    rttMs: model.rttMs,
    pushReady: model.vapidPublicKey !== null,
    pushEnabled: model.pushEnabled,
    pushBusy: model.pushBusy,
    pushAvailability,
    pushError: model.pushError,
  };
}
