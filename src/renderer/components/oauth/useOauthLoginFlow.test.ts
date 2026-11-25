import type { OauthFlowEvent, OauthFlowLocator, StartOauthResult } from '@shared/oauthFlow';
import { describe, expect, it, vi } from 'vitest';
import {
  attachedOauthLoginFlowState,
  noteRemoteAuthOpen,
  type OauthLoginFlowState,
  reduceOauthLoginFlowState,
  reopenOauthLoginFlow,
  startOauthLoginFlow,
} from './useOauthLoginFlow';

const flowA = '11111111-1111-4111-8111-111111111111';
const flowB = '22222222-2222-4222-8222-222222222222';
const wizardA: OauthFlowLocator = {
  flowId: flowA,
  host: 'provider-wizard',
  ownerWebContentsId: 7,
};
const wizardB: OauthFlowLocator = {
  flowId: flowB,
  host: 'provider-wizard',
  ownerWebContentsId: 7,
};
const child = {
  sessionId: 'parent::cw-enso',
  generation: '33333333-3333-4333-8333-333333333333',
  parent: {
    sessionId: 'parent',
    generation: '44444444-4444-4444-8444-444444444444',
  },
  instanceId: '55555555-5555-4555-8555-555555555555',
  instanceName: 'Enso · a1',
  typeKey: 'agent:enso' as const,
  profileId: 'enso-locked-v1' as const,
};
const childLocatorA: OauthFlowLocator = {
  flowId: flowA,
  host: 'agent-child-tab',
  ownerWebContentsId: 7,
  child,
  turnId: 'turn-1',
  requestId: 'request-1',
};
const childLocatorB: OauthFlowLocator = {
  ...childLocatorA,
  flowId: flowB,
  child: { ...child, sessionId: 'parent::cw-other' },
};
const running = attachedOauthLoginFlowState('anthropic', wizardA) as Extract<
  OauthLoginFlowState,
  { phase: 'running' }
>;
const event = (locator: OauthFlowLocator, value: OauthFlowEvent['event']): OauthFlowEvent => ({
  locator,
  event: value,
});

describe('OAuth exact locator state machine', () => {
  it('wizard updates only the complete matching locator', () => {
    const stale = reduceOauthLoginFlowState(
      running,
      event(wizardB, { type: 'progress', message: 'stale' })
    );
    const wrongOwner = reduceOauthLoginFlowState(
      running,
      event({ ...wizardA, ownerWebContentsId: 8 }, { type: 'progress', message: 'foreign' })
    );
    const withUrl = reduceOauthLoginFlowState(
      running,
      event(wizardA, {
        type: 'auth_url',
        url: 'https://accounts.example.test/authorize',
        instructions: 'Continue in browser',
      })
    );
    const withPrompt = reduceOauthLoginFlowState(
      withUrl,
      event(wizardA, {
        type: 'prompt',
        prompt: { requestId: 'prompt-1', type: 'manual_code', message: 'Paste the code' },
      })
    );

    expect(stale).toBe(running);
    expect(wrongOwner).toBe(running);
    expect(withPrompt).toMatchObject({
      phase: 'running',
      locator: wizardA,
      authUrl: 'https://accounts.example.test/authorize',
      prompt: { requestId: 'prompt-1' },
    });
  });

  it('prompt 带上的拒绝原因原样留下，下一条提示换掉', () => {
    const rejected = 'That is not an authorization callback address.';
    const withError = reduceOauthLoginFlowState(
      running,
      event(wizardA, {
        type: 'prompt',
        prompt: {
          requestId: 'prompt-1',
          type: 'manual_code',
          message: 'Paste the address',
          error: rejected,
        },
      })
    );
    expect(withError).toMatchObject({
      phase: 'running',
      prompt: { requestId: 'prompt-1', error: rejected },
    });
    const replaced = reduceOauthLoginFlowState(
      withError,
      event(wizardA, {
        type: 'prompt',
        prompt: { requestId: 'prompt-2', type: 'manual_code', message: 'Paste the address' },
      })
    );
    expect(replaced).toMatchObject({
      prompt: { requestId: 'prompt-2', message: 'Paste the address' },
    });
    if (replaced.phase !== 'running') throw new Error('expected running');
    expect(replaced.prompt?.error).toBeUndefined();
  });

  it('粘贴被拒重提示时状态行从「Verifying...」复位回上一条 progress', () => {
    // 等待浏览器授权 → 用户提交（乐观置 Verifying...）→ 被拒重提示：状态行要回去
    const waiting = reduceOauthLoginFlowState(
      running,
      event(wizardA, { type: 'progress', message: 'Waiting for browser authentication...' })
    );
    const optimistic = {
      ...waiting,
      prompt: null,
      progress: 'Verifying...',
    } as typeof waiting;
    const rejected = reduceOauthLoginFlowState(
      optimistic,
      event(wizardA, {
        type: 'prompt',
        prompt: {
          requestId: 'prompt-2',
          type: 'manual_code',
          message: 'Paste the address',
          error: 'That is not an authorization callback address.',
        },
      })
    );
    expect(rejected).toMatchObject({ progress: 'Waiting for browser authentication...' });
  });

  it('auth_url 把完整链接放进 fullAuthUrl，剥参链接仍留给展示', () => {
    const full =
      'https://accounts.example.test/authorize?state=secret&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb';
    const next = reduceOauthLoginFlowState(
      running,
      event(wizardA, {
        type: 'auth_url',
        url: 'https://accounts.example.test/authorize',
        fullUrl: full,
        instructions: 'Continue in browser',
      })
    );
    expect(next).toMatchObject({
      authUrl: 'https://accounts.example.test/authorize',
      fullAuthUrl: full,
      progress: 'Continue in browser',
    });
  });

  it('远程重开和首次授权都走 window.open，同一链接只自动开一次', () => {
    const full = 'https://accounts.example.test/authorize?state=secret';
    const open = vi.fn();
    const ipc = vi.fn();
    vi.stubGlobal('window', {
      open,
      electronAPI: { remote: {}, providers: { oauthLoginReopen: ipc } },
    });
    try {
      const next = reduceOauthLoginFlowState(
        running,
        event(wizardA, {
          type: 'auth_url',
          url: 'https://accounts.example.test/authorize',
          fullUrl: full,
        })
      );
      const opened = noteRemoteAuthOpen(null, {
        type: 'auth_url',
        url: 'https://accounts.example.test/authorize',
        fullUrl: full,
      });
      expect(
        noteRemoteAuthOpen(opened, {
          type: 'auth_url',
          url: 'https://accounts.example.test/authorize',
          fullUrl: full,
        })
      ).toBe(opened);
      reopenOauthLoginFlow(next);
      expect(open).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledWith(full, '_blank', 'noopener,noreferrer');
      expect(ipc).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('child locks only a matching child/generation/turn/request locator, then rejects all other fields', () => {
    const attached = attachedOauthLoginFlowState('anthropic', {
      host: 'agent-child-tab',
      child,
      turnId: childLocatorA.turnId,
      requestId: childLocatorA.requestId,
    });
    const foreign = reduceOauthLoginFlowState(
      attached,
      event(childLocatorB, { type: 'progress', message: 'foreign child' })
    );
    const locked = reduceOauthLoginFlowState(
      attached,
      event(childLocatorA, { type: 'progress', message: 'Waiting for browser' })
    );
    const wrongOwner = reduceOauthLoginFlowState(
      locked,
      event(
        { ...childLocatorA, ownerWebContentsId: 8 },
        { type: 'error', message: 'foreign owner' }
      )
    );
    const wrongTurn = reduceOauthLoginFlowState(
      locked,
      event({ ...childLocatorA, turnId: 'turn-2' }, { type: 'error', message: 'foreign turn' })
    );

    expect(foreign).toBe(attached);
    expect(locked).toMatchObject({
      phase: 'running',
      locator: childLocatorA,
      progress: 'Waiting for browser',
    });
    expect(wrongOwner).toBe(locked);
    expect(wrongTurn).toBe(locked);
  });

  it('busy/failed do not attach; started binds the complete Main locator', async () => {
    const attach = vi.fn();
    const invoke = vi.fn<(providerId: string) => Promise<StartOauthResult>>();
    invoke.mockResolvedValueOnce({ status: 'busy', activeHost: 'agent-child-tab' });
    await expect(startOauthLoginFlow({ attach, invoke }, 'anthropic')).resolves.toMatchObject({
      status: 'busy',
    });
    expect(attach).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({ status: 'started', locator: wizardA });
    await expect(startOauthLoginFlow({ attach, invoke }, 'anthropic')).resolves.toEqual({
      status: 'started',
      locator: wizardA,
    });
    expect(attach).toHaveBeenCalledWith('anthropic', wizardA);
  });

  it('done and prompt-cancel settle only the exact locator/request', () => {
    const prompted: OauthLoginFlowState = {
      ...running,
      prompt: { requestId: 'new', type: 'text', message: 'Value' },
    };
    expect(
      reduceOauthLoginFlowState(
        prompted,
        event(wizardA, { type: 'prompt-cancel', requestId: 'old' })
      )
    ).toBe(prompted);
    expect(
      reduceOauthLoginFlowState(
        prompted,
        event(wizardA, { type: 'prompt-cancel', requestId: 'new' })
      )
    ).toMatchObject({ phase: 'running', prompt: null });

    const account = { key: 'anthropic#3', providerId: 'anthropic', email: 'third@example.com' };
    expect(
      reduceOauthLoginFlowState(
        running,
        event(wizardA, { type: 'done', providerId: 'anthropic', account })
      )
    ).toEqual({ phase: 'done', providerId: 'anthropic', locator: wizardA, account });
  });
});
