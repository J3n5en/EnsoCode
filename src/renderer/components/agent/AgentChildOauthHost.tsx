import { isSameChildSessionIdentity } from '@shared/builtinAgents';
import type { CapabilityAskRequest } from '@shared/capabilities/types';
import { useEffect } from 'react';
import { refreshOauthCredentialState } from '@/components/oauth/OauthCredentialBootstrap';
import { OauthLoginStep } from '@/components/oauth/OauthLoginStep';
import { useOauthLoginFlow } from '@/components/oauth/useOauthLoginFlow';
import { useI18n } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';

export function isCurrentChildOauthHost(
  request: CapabilityAskRequest,
  conversationId: string,
  generation: string | undefined,
  activeRequest: CapabilityAskRequest | undefined
): boolean {
  return (
    request.host?.kind === 'oauth-login' &&
    activeRequest?.host?.kind === 'oauth-login' &&
    request.child.sessionId === conversationId &&
    request.child.generation === generation &&
    request.turnId === activeRequest.turnId &&
    request.requestId === activeRequest.requestId &&
    isSameChildSessionIdentity(request.child, activeRequest.child)
  );
}

/** OAuth is started by Main after the dangerous ASK; this child TAB only attaches to that flow. */
export function AgentChildOauthHost({
  request,
  conversationId,
}: {
  request: CapabilityAskRequest;
  conversationId: string;
}) {
  const { t } = useI18n();
  const conversation = useSessionsStore((state) => state.conversations[conversationId]);
  const flow = useOauthLoginFlow({
    onDone: () => {
      void refreshOauthCredentialState();
    },
  });
  const host = request.host;
  const current = isCurrentChildOauthHost(
    request,
    conversationId,
    conversation?.generation,
    conversation?.activeOauthAsk
  );

  useEffect(() => {
    if (!current || host?.kind !== 'oauth-login') return;
    flow.attach(host.providerId, {
      host: 'agent-child-tab',
      child: request.child,
      turnId: request.turnId,
      requestId: request.requestId,
    });
    return flow.reset;
  }, [current, flow.attach, flow.reset, host, request.child, request.requestId, request.turnId]);

  if (!current || host?.kind !== 'oauth-login') return null;
  return (
    <section className="mb-1 space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div>
        <p className="text-sm font-medium">{t('Subscription authorization')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{host.providerLabel}</p>
      </div>
      <OauthLoginStep flow={flow} providerLabel={host.providerLabel} />
    </section>
  );
}
