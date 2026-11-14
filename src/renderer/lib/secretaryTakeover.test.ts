import { parseProfile } from '@shared/secretary/parse';
import type { SecretaryProfile } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { canOfferTakeover } from './secretaryTakeover';

const profile = (over: Partial<SecretaryProfile> = {}): SecretaryProfile => ({
  ...(parseProfile({}) as SecretaryProfile),
  ...over,
});

describe('canOfferTakeover', () => {
  const on = { enabled: true, profile: profile() };
  const row = { projectId: 'p1' };

  it('秘书开着且设置过时，普通可见会话给「交给秘书接管」', () => {
    expect(canOfferTakeover(row, 'local', on)).toBe(true);
    expect(canOfferTakeover(row, 'ssh', on)).toBe(true);
  });

  it('秘书关着、没设置、会话不合格或项目不可见时不给', () => {
    expect(canOfferTakeover(row, 'local', { enabled: false, profile: profile() })).toBe(false);
    expect(canOfferTakeover(row, 'local', { enabled: true, profile: null })).toBe(false);
    expect(canOfferTakeover(undefined, 'local', on)).toBe(false);
    for (const bad of [
      { archived: true },
      { parentId: 'root' },
      { btwParentId: 'root' },
      { secretaryOrigin: { secretaryConversationId: 's' } },
    ])
      expect(canOfferTakeover({ ...row, ...bad }, 'local', on), JSON.stringify(bad)).toBe(false);
    for (const kind of ['secretary', 'scratch', 'bot-home'])
      expect(canOfferTakeover(row, kind, on), kind).toBe(false);
    expect(
      canOfferTakeover(row, 'local', {
        enabled: true,
        profile: profile({ visibleProjectIds: ['p2'] }),
      })
    ).toBe(false);
  });
});
