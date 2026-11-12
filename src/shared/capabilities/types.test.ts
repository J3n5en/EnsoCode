import { describe, expect, it } from 'vitest';
import { parseCapabilityReceipt } from './types';

const child = {
  sessionId: 'parent::cw-1',
  generation: '22222222-2222-4222-8222-222222222222',
  parent: {
    sessionId: 'parent',
    generation: '11111111-1111-4111-8111-111111111111',
  },
  instanceId: '33333333-3333-4333-8333-333333333333',
  instanceName: 'Enso 3333',
  typeKey: 'agent:enso',
  profileId: 'enso-locked-v1',
};

const receipt = {
  receiptId: '44444444-4444-4444-8444-444444444444',
  operationId: 'op-1',
  child,
  turnId: 'turn-1',
  requestId: 'request-1',
  capabilityId: 'appearance.theme',
  risk: 'reversible',
  subject: { kind: 'setting', id: 'theme', label: 'Theme' },
  outcome: 'succeeded',
  summary: 'Theme changed',
  changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
  occurredAt: 1,
  sequence: 0,
};

describe('legacy capability receipt', () => {
  it('历史 receipt 仍可读取并严格绑定 child/turn/request', () => {
    expect(parseCapabilityReceipt(receipt)).toEqual(receipt);
    expect(
      parseCapabilityReceipt({ ...receipt, child: { ...child, generation: 'old' } })
    ).toBeNull();
    expect(parseCapabilityReceipt({ ...receipt, apiKey: 'secret' })).toBeNull();
  });
});
