import type { ModelApiKind, ModelProvider } from '@shared/types';
import { BadgeCheck, HardDriveDownload, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { LocalImportDialog } from './LocalImportDialog';
import { OauthProvidersDialog } from './OauthProvidersDialog';
import { ProviderEditDialog } from './ProviderEditDialog';

const API_LABELS: Record<ModelApiKind, string> = {
  'openai-completions': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic',
  'google-generative-ai': 'Gemini',
  ollama: 'Ollama',
};

export function ProvidersSettings() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const updateProvider = useSettingsStore((state) => state.updateProvider);
  const removeProvider = useSettingsStore((state) => state.removeProvider);
  const [importOpen, setImportOpen] = React.useState(false);
  const [oauthOpen, setOauthOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ModelProvider | 'new' | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-lg font-medium">{t('Model Providers')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('Manage model API providers for this app')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <HardDriveDownload className="h-4 w-4 mr-1.5" />
            {t('Import from local apps')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOauthOpen(true)}>
            <BadgeCheck className="h-4 w-4 mr-1.5" />
            {t('Subscription login')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4 mr-1.5" />
            {t('Add provider')}
          </Button>
        </div>
      </div>

      {providers.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-8 text-center">
          <Server className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">{t('No providers yet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Import providers from local apps or add one manually to get started')}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'text-sm font-medium',
                    !provider.enabled && 'text-muted-foreground line-through'
                  )}
                >
                  {provider.name}
                </span>
                <Badge variant="outline" className="shrink-0 text-[11px]">
                  {provider.oauthProviderId
                    ? t('Subscription')
                    : (API_LABELS[provider.api] ?? provider.api)}
                </Badge>
                {provider.importedFrom && (
                  <Badge variant="secondary" className="shrink-0 text-[11px]">
                    {provider.importedFrom}
                  </Badge>
                )}
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {[
                    provider.baseUrl,
                    provider.models.length > 0
                      ? t('{{count}} models', { count: provider.models.length })
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  checked={provider.enabled}
                  onCheckedChange={(enabled) => updateProvider(provider.id, { enabled })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => setEditing(provider)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => removeProvider(provider.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <LocalImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <OauthProvidersDialog open={oauthOpen} onOpenChange={setOauthOpen} />
      <ProviderEditDialog provider={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
