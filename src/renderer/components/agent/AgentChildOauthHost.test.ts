import type { CapabilityAskRequest } from '@shared/capabilities/types';
import { describe, expect, it, vi } from 'vitest';
import { isCurrentChildOauthHost } from './AgentChildOauthHost';

vi.mock('@/stores/sessions', () => ({ useSessionsStore: vi.fn() }));
vi.mock('@/components/oauth/useOauthLoginFlow', () => ({ useOauthLoginFlow: vi.fn() }));
vi.mock('@/components/oauth/OauthCredentialBootstrap', () => ({
  refreshOauthCredentialState: vi.fn(),
}));
vi.mock('@/components/oauth/OauthLoginStep', () => ({ OauthLoginStep: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }));

const request: CapabilityAskRequest = {
  child: {
    sessionId: 'parent::cw-enso',
    generation: '11111111-1111-4111-8111-111111111111',
    parent: {
      sessionId: 'parent',
      generation: '22222222-2222-4222-8222-222222222222',
    },
    instanceId: '123e4567-e89b-42d3-a456-426614174000',
    instanceName: 'Enso · a1',
    typeKey: 'agent:enso',
    profileId: 'enso-locked-v1',
  },
  turnId: 'turn-1',
  requestId: '123e4567-e89b-42d3-a456-426614174001',
  capabilityId: 'providers.oauth.login',
  summary: 'Open browser authorization for Anthropic',
  host: {
    kind: 'oauth-login',
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
  },
};

describe('AgentChildOauthHost identity gate', () => {
  it('accepts only the exact active child generation, parent, turn, and request', () => {
    expect(
      isCurrentChildOauthHost(request, request.child.sessionId, request.child.generation, request)
    ).toBe(true);
    expect(
      isCurrentChildOauthHost(request, request.child.sessionId, 'stale-generation', request)
    ).toBe(false);
    expect(
      isCurrentChildOauthHost(request, request.child.sessionId, request.child.generation, {
        ...request,
        turnId: 'turn-2',
      })
    ).toBe(false);
    expect(
      isCurrentChildOauthHost(request, request.child.sessionId, request.child.generation, {
        ...request,
        child: {
          ...request.child,
          parent: { ...request.child.parent, generation: 'different-parent-generation' },
        },
      })
    ).toBe(false);
    expect(
      isCurrentChildOauthHost(request, request.child.sessionId, request.child.generation, {
        ...request,
        requestId: 'different-request',
      })
    ).toBe(false);
  });
});
