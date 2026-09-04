import type { ModelProvider } from '@shared/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { ProviderApiForm } from './ProviderApiForm';

interface ProviderEditDialogProps {
  provider: ModelProvider | null;
  onClose: () => void;
}

/** 只编辑已存在条目；所有新建路径统一进入 ProviderSetupWizard。 */
export function ProviderEditDialog({ provider, onClose }: ProviderEditDialogProps) {
  const { t } = useI18n();
  const updateProvider = useSettingsStore((state) => state.updateProvider);

  return (
    <Dialog open={provider !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Edit Provider')}</DialogTitle>
        </DialogHeader>
        {provider && (
          <ProviderApiForm
            key={provider.id}
            initialValue={{
              name: provider.name,
              api: provider.api,
              apiKey: provider.apiKey,
              baseUrl: provider.baseUrl,
              models: provider.models,
            }}
            oauth={Boolean(provider.oauthAccountKey)}
            oauthAccountKey={provider.oauthAccountKey}
            onCancel={onClose}
            onSave={(value) => {
              updateProvider(
                provider.id,
                provider.oauthAccountKey ? { name: value.name, models: value.models } : value
              );
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
