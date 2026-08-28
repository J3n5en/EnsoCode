import { CircleAlert, ExternalLink, Loader2, RotateCcw, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import type { OauthLoginFlow } from './useOauthLoginFlow';

interface OauthLoginStepProps {
  flow: OauthLoginFlow;
  providerLabel: string;
  onBack?: () => void;
}

/** 可嵌入任意宿主的 OAuth 当前步骤；不拥有 Dialog，也不假设来自 Provider 向导。 */
export function OauthLoginStep({ flow, providerLabel, onBack }: OauthLoginStepProps) {
  const { t } = useI18n();
  const [promptValue, setPromptValue] = React.useState('');
  const prompt = flow.state.phase === 'running' ? flow.state.prompt : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: requestId 切换时必须清空上一条 OAuth prompt 的输入。
  React.useEffect(() => {
    setPromptValue('');
  }, [prompt?.requestId]);

  if (flow.state.phase === 'error') {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
          <div className="flex items-start gap-2 text-destructive">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('Authorization failed')}</p>
              <p className="mt-1 break-words text-xs">{flow.state.message}</p>
            </div>
          </div>
        </div>
        <div className="flex justify-between gap-2">
          {onBack ? (
            <Button variant="outline" size="sm" onClick={onBack}>
              {t('Back')}
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" onClick={flow.retry}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {t('Retry')}
          </Button>
        </div>
      </div>
    );
  }

  if (flow.state.phase !== 'running') return null;

  const submitPrompt = (value: string) => {
    const trimmed = value.trim();
    if (!prompt || !trimmed) return;
    flow.respond(prompt.requestId, trimmed);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-accent/30 px-4 py-3">
        <div className="flex items-start gap-3">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {t('Authorizing {{provider}}', { provider: providerLabel })}
            </p>
            {flow.state.progress && (
              <p className="mt-1 text-xs text-muted-foreground">{t(flow.state.progress)}</p>
            )}
          </div>
        </div>
      </div>

      {flow.state.userCode && (
        <div className="rounded-md border px-4 py-3 text-center">
          <p className="text-xs text-muted-foreground">{t('Enter this code in your browser')}</p>
          <p className="mt-2 select-all font-mono text-xl font-semibold tracking-[0.2em]">
            {flow.state.userCode}
          </p>
        </div>
      )}

      {flow.state.authUrl && (
        <Button variant="outline" size="sm" className="w-full" onClick={flow.reopen}>
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          {t('Open authorization page again')}
        </Button>
      )}

      {prompt && (
        <div className="space-y-2 rounded-md border px-4 py-3">
          <p className="text-sm font-medium">{t(prompt.message)}</p>
          {prompt.type === 'select' ? (
            <div className="grid gap-2">
              {prompt.options?.map((option) => (
                <Button
                  key={option.id}
                  variant="outline"
                  size="sm"
                  className="h-auto justify-start py-2 text-left"
                  onClick={() => flow.respond(prompt.requestId, option.id)}
                >
                  <span>
                    <span className="block text-sm">{option.label}</span>
                    {option.description && (
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                type={prompt.type === 'secret' ? 'password' : 'text'}
                value={promptValue}
                placeholder={prompt.placeholder}
                onChange={(event) => setPromptValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.key !== 'Enter') return;
                  event.preventDefault();
                  submitPrompt(promptValue);
                }}
              />
              <Button
                size="sm"
                disabled={!promptValue.trim()}
                onClick={() => submitPrompt(promptValue)}
              >
                {t('Submit')}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={flow.cancel}>
          <X className="mr-1.5 h-3.5 w-3.5" />
          {t('Cancel authorization')}
        </Button>
      </div>
    </div>
  );
}
