import { isSameChildSessionIdentity } from '@shared/builtinAgents';
import {
  type OauthFlowEvent,
  type OauthFlowLocator,
  parseOauthFlowEvent,
  type StartOauthResult,
} from '@shared/capabilities/types';
import type { OauthAccount, OauthLoginEvent, OauthLoginPrompt } from '@shared/types';
import * as React from 'react';

export type AgentChildOauthBinding = Omit<
  Extract<OauthFlowLocator, { host: 'agent-child-tab' }>,
  'flowId' | 'ownerWebContentsId'
>;
export type OauthFlowBinding = OauthFlowLocator | AgentChildOauthBinding;

export type OauthLoginFlowState =
  | { phase: 'idle' }
  | {
      phase: 'running';
      providerId: string;
      binding: OauthFlowBinding;
      locator: OauthFlowLocator | null;
      progress: string | null;
      authUrl: string | null;
      userCode: string | null;
      prompt: OauthLoginPrompt | null;
    }
  | { phase: 'error'; providerId: string; message: string }
  | { phase: 'done'; providerId: string; locator: OauthFlowLocator; account: OauthAccount };

export interface OauthLoginFlow {
  state: OauthLoginFlowState;
  attach: (providerId: string, binding: OauthFlowBinding) => void;
  start: (providerId: string) => void;
  cancel: () => void;
  retry: () => void;
  reopen: () => void;
  respond: (requestId: string, value: string) => void;
  reset: () => void;
}

export const attachedOauthLoginFlowState = (
  providerId: string,
  binding: OauthFlowBinding
): OauthLoginFlowState => ({
  phase: 'running',
  providerId,
  binding,
  locator: 'flowId' in binding ? binding : null,
  progress: 'Starting login...',
  authUrl: null,
  userCode: null,
  prompt: null,
});

export interface OauthLoginStartDependencies {
  attach: (providerId: string, locator: OauthFlowLocator) => void;
  invoke: (providerId: string) => Promise<StartOauthResult>;
}

/** Wizard start binds the complete Main-issued locator; busy/failed never become running. */
export async function startOauthLoginFlow(
  dependencies: OauthLoginStartDependencies,
  providerId: string
): Promise<StartOauthResult> {
  const result = await dependencies.invoke(providerId);
  if (result.status === 'started') dependencies.attach(providerId, result.locator);
  return result;
}

function isSameOauthFlowLocator(left: OauthFlowLocator, right: OauthFlowLocator): boolean {
  if (
    left.flowId !== right.flowId ||
    left.host !== right.host ||
    left.ownerWebContentsId !== right.ownerWebContentsId
  ) {
    return false;
  }
  if (left.host === 'provider-wizard' || right.host === 'provider-wizard') {
    return left.host === right.host;
  }
  return (
    left.turnId === right.turnId &&
    left.requestId === right.requestId &&
    isSameChildSessionIdentity(left.child, right.child)
  );
}

function matchesOauthFlowBinding(binding: OauthFlowBinding, locator: OauthFlowLocator): boolean {
  if ('flowId' in binding) return isSameOauthFlowLocator(binding, locator);
  return (
    locator.host === 'agent-child-tab' &&
    binding.host === locator.host &&
    binding.turnId === locator.turnId &&
    binding.requestId === locator.requestId &&
    isSameChildSessionIdentity(binding.child, locator.child)
  );
}

/** Child attachment locks the first exact child/turn/request locator, then compares every field. */
export function reduceOauthLoginFlowState(
  state: OauthLoginFlowState,
  payload: OauthFlowEvent
): OauthLoginFlowState {
  const envelope = parseOauthFlowEvent(payload);
  if (!envelope || state.phase !== 'running') return state;
  if (!matchesOauthFlowBinding(state.binding, envelope.locator)) return state;
  if (state.locator && !isSameOauthFlowLocator(state.locator, envelope.locator)) return state;
  const current = state.locator ? state : { ...state, locator: envelope.locator };
  const event: OauthLoginEvent = envelope.event;
  switch (event.type) {
    case 'info':
    case 'progress':
      return { ...current, progress: event.message };
    case 'auth_url':
      return {
        ...current,
        authUrl: event.url,
        progress: event.instructions ?? 'Complete authorization in your browser',
      };
    case 'device_code':
      return {
        ...current,
        authUrl: event.verificationUri,
        userCode: event.userCode,
        progress: 'Enter the code in your browser',
      };
    case 'prompt':
      return { ...current, prompt: event.prompt };
    case 'prompt-cancel':
      return current.prompt?.requestId === event.requestId ? { ...current, prompt: null } : current;
    case 'done':
      return {
        phase: 'done',
        providerId: event.providerId,
        locator: envelope.locator,
        account: event.account,
      };
    case 'error':
      return { phase: 'error', providerId: current.providerId, message: event.message };
  }
}

export function useOauthLoginFlow(options?: {
  onDone?: (providerId: string, account: OauthAccount) => void;
}): OauthLoginFlow {
  const [state, setState] = React.useState<OauthLoginFlowState>({ phase: 'idle' });
  const stateRef = React.useRef(state);
  const onDoneRef = React.useRef(options?.onDone);
  onDoneRef.current = options?.onDone;

  React.useEffect(
    () =>
      window.electronAPI.providers.onOauthLoginEvent((event) => {
        const current = stateRef.current;
        if (current.phase !== 'running') return;
        const next = reduceOauthLoginFlowState(current, event);
        if (next === current) return;
        stateRef.current = next;
        setState(next);
        if (event.event.type === 'done') {
          onDoneRef.current?.(event.event.providerId, event.event.account);
        }
      }),
    []
  );

  const attach = React.useCallback((providerId: string, binding: OauthFlowBinding) => {
    const next = attachedOauthLoginFlowState(providerId, binding);
    stateRef.current = next;
    setState(next);
  }, []);

  const start = React.useCallback(
    (providerId: string) => {
      void startOauthLoginFlow(
        {
          attach,
          invoke: (id) => window.electronAPI.providers.oauthLogin({ providerId: id }),
        },
        providerId
      )
        .then((result) => {
          if (result.status === 'started') return;
          const failed: OauthLoginFlowState = {
            phase: 'error',
            providerId,
            message:
              result.status === 'busy'
                ? `OAuth login is busy in ${result.activeHost}`
                : result.message,
          };
          stateRef.current = failed;
          setState(failed);
        })
        .catch((error) => {
          const failed: OauthLoginFlowState = {
            phase: 'error',
            providerId,
            message: error instanceof Error ? error.message : String(error),
          };
          stateRef.current = failed;
          setState(failed);
        });
    },
    [attach]
  );

  const cancel = React.useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== 'running' || !current.locator) return;
    void window.electronAPI.providers.oauthLoginCancel({ locator: current.locator });
    stateRef.current = { phase: 'idle' };
    setState({ phase: 'idle' });
  }, []);

  const retry = React.useCallback(() => {
    const current = stateRef.current;
    if (current.phase === 'error') start(current.providerId);
  }, [start]);

  const reopen = React.useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== 'running' || !current.locator) return;
    void window.electronAPI.providers.oauthLoginReopen({ locator: current.locator });
  }, []);

  const respond = React.useCallback((requestId: string, value: string) => {
    const current = stateRef.current;
    if (current.phase !== 'running' || !current.locator) return;
    const locator = current.locator;
    void window.electronAPI.providers.oauthLoginRespond({
      locator,
      requestId,
      value,
    });
    setState((latest) => {
      const next =
        latest.phase === 'running' &&
        latest.locator &&
        isSameOauthFlowLocator(latest.locator, locator)
          ? { ...latest, prompt: null, progress: 'Verifying...' }
          : latest;
      stateRef.current = next;
      return next;
    });
  }, []);

  const reset = React.useCallback(() => {
    stateRef.current = { phase: 'idle' };
    setState({ phase: 'idle' });
  }, []);

  return { state, attach, start, cancel, retry, reopen, respond, reset };
}
