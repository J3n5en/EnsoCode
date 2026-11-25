import { isSameChildSessionIdentity } from '@shared/builtinAgents';
import {
  type OauthFlowEvent,
  type OauthFlowLocator,
  parseOauthFlowEvent,
  type StartOauthResult,
} from '@shared/oauthFlow';
import type { OauthAccount, OauthLoginEvent, OauthLoginPrompt } from '@shared/types';
import * as React from 'react';
import { isRemoteClient } from '@/lib/remoteClient';

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
      /** 最近一条 Main 下发的 progress/auth/device 状态文案；提交时的乐观「Verifying...」不覆盖它 */
      lastProgress: string | null;
      authUrl: string | null;
      /** 远程浏览器要自己打开的完整授权链接。本机仍用剥参后的 authUrl 展示。 */
      fullAuthUrl: string | null;
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
  lastProgress: 'Starting login...',
  authUrl: null,
  fullAuthUrl: null,
  userCode: null,
  prompt: null,
});

export interface OauthLoginStartDependencies {
  attach: (providerId: string, locator: OauthFlowLocator) => void;
  invoke: (providerId: string) => Promise<StartOauthResult>;
}

/** 向导发起时绑定 Main 下发的完整 locator；busy/failed 绝不会转为 running。 */
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

/** child 接入时锁定第一个精确匹配 child/turn/request 的 locator，之后逐字段比对。 */
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
      return { ...current, progress: event.message, lastProgress: event.message };
    case 'auth_url':
      return {
        ...current,
        authUrl: event.url,
        fullAuthUrl: event.fullUrl ?? event.url,
        progress: event.instructions ?? 'Complete authorization in your browser',
        lastProgress: event.instructions ?? 'Complete authorization in your browser',
      };
    case 'device_code':
      return {
        ...current,
        authUrl: event.verificationUri,
        userCode: event.userCode,
        progress: 'Enter the code in your browser',
        lastProgress: 'Enter the code in your browser',
      };
    case 'prompt':
      // 提交时乐观置的「Verifying...」不是真实状态：新一轮提示（如粘贴被拒）要把状态行
      // 复位回 Main 最近一条 progress，否则「正在验证」与红字拒绝同时挂着
      return {
        ...current,
        prompt: event.prompt,
        progress: current.progress === 'Verifying...' ? current.lastProgress : current.progress,
      };
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

/** 远程收到授权链接时打开一次。返回已打开的地址，相同链接不再开。 */
export function noteRemoteAuthOpen(
  opened: string | null,
  oauthEvent: OauthLoginEvent
): string | null {
  if (!isRemoteClient() || oauthEvent.type !== 'auth_url') return opened;
  const url = oauthEvent.fullUrl || oauthEvent.url;
  if (!url || opened === url) return opened;
  window.open(url, '_blank', 'noopener,noreferrer');
  return url;
}

/** 远程重开走当前浏览器；本机仍让 Main shell.openExternal。 */
export function reopenOauthLoginFlow(state: OauthLoginFlowState): void {
  if (state.phase !== 'running' || !state.locator) return;
  if (isRemoteClient()) {
    const url = state.fullAuthUrl ?? state.authUrl;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  void window.electronAPI.providers.oauthLoginReopen({ locator: state.locator });
}

export function useOauthLoginFlow(options?: {
  onDone?: (providerId: string, account: OauthAccount) => void;
}): OauthLoginFlow {
  const [state, setState] = React.useState<OauthLoginFlowState>({ phase: 'idle' });
  const stateRef = React.useRef(state);
  const onDoneRef = React.useRef(options?.onDone);
  const openedAuthUrl = React.useRef<string | null>(null);
  onDoneRef.current = options?.onDone;

  React.useEffect(
    () =>
      window.electronAPI.providers.onOauthLoginEvent((event) => {
        const current = stateRef.current;
        if (current.phase !== 'running') return;
        const next = reduceOauthLoginFlowState(current, event);
        if (next === current) return;
        openedAuthUrl.current = noteRemoteAuthOpen(openedAuthUrl.current, event.event);
        stateRef.current = next;
        setState(next);
        if (event.event.type === 'done') {
          onDoneRef.current?.(event.event.providerId, event.event.account);
        }
      }),
    []
  );

  const attach = React.useCallback((providerId: string, binding: OauthFlowBinding) => {
    openedAuthUrl.current = null;
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
    reopenOauthLoginFlow(stateRef.current);
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
