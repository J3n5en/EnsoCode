import {
  type ContextMenuOpen,
  type ContextMenuOpenItem,
  contextMenuApplicationIdentity,
  isFileOpenApplicationPath,
} from '@shared/fileOpening';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

export function ContextMenuOpeningSettings() {
  const { t } = useI18n();
  const items = useSettingsStore((state) => state.contextMenuOpen);
  const setContextMenuOpen = useSettingsStore((state) => state.setContextMenuOpen);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameOf = (item: ContextMenuOpenItem): string => {
    if (item.target === 'reveal') return t('File manager');
    if (item.target === 'vscode') return t('VS Code');
    return (
      item.applicationPath.split(/[/\\]/).at(-1)?.replace(/\.(exe|app)$/i, '') ||
      item.applicationPath
    );
  };
  const enabledNames = items.filter((item) => item.enabled).map(nameOf);
  const summary = enabledNames.length
    ? `${enabledNames.slice(0, 2).join(', ')}${enabledNames.length > 2 ? ` +${enabledNames.length - 2}` : ''}`
    : t('No opening methods enabled');

  const saveItems = (next: ContextMenuOpen) => {
    if (next.length > 32) {
      addToast({
        type: 'error',
        title: t('Context menu opening'),
        description: t('You can configure up to 32 opening methods.'),
      });
      return;
    }
    setContextMenuOpen(next);
  };

  const setEnabled = (item: ContextMenuOpenItem, enabled: boolean) => {
    const current = useSettingsStore.getState().contextMenuOpen;
    setContextMenuOpen(
      current.map((entry) => (entry.id === item.id ? { ...entry, enabled } : entry))
    );
  };

  const chooseApplication = async () => {
    setBusy(true);
    try {
      const path = await window.electronAPI.dialog.selectFile();
      if (!path) return;
      if (!isFileOpenApplicationPath(path)) {
        addToast({
          type: 'error',
          title: t('Context menu opening'),
          description: t('The selected application path is invalid.'),
        });
        return;
      }
      const current = useSettingsStore.getState().contextMenuOpen;
      const identity = contextMenuApplicationIdentity(path);
      const existing = current.find(
        (item) =>
          item.target === 'application' &&
          contextMenuApplicationIdentity(item.applicationPath) === identity
      );
      if (existing) {
        saveItems(
          current.map((item) => (item.id === existing.id ? { ...item, enabled: true } : item))
        );
        return;
      }
      saveItems([
        ...current,
        {
          id: crypto.randomUUID(),
          target: 'application',
          applicationPath: path,
          enabled: true,
        },
      ]);
    } catch (cause: unknown) {
      addToast({
        type: 'error',
        title: t('Context menu opening'),
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-sm font-medium">{t('Context menu opening')}</h5>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t('Configure list')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'Select the opening methods shown in file link context menus. You can add multiple applications.'
        )}
      </p>
      <p className="truncate text-xs text-muted-foreground" title={enabledNames.join(', ')}>
        {summary}
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup zIndexLevel="nested">
          <DialogHeader>
            <DialogTitle>{t('Context menu opening')}</DialogTitle>
            <DialogDescription>
              {t(
                'Select the opening methods shown in file link context menus. You can add multiple applications.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            {items.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('No opening methods enabled')}
              </p>
            )}
            {items.map((item) => {
              const name = nameOf(item);
              return (
                <div key={item.id} className="flex items-center gap-3 rounded-md border p-3">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <Checkbox
                      checked={item.enabled}
                      disabled={busy}
                      aria-label={name}
                      onCheckedChange={(enabled) => setEnabled(item, enabled)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm" title={name}>
                        {name}
                      </span>
                      {item.target === 'application' && (
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={item.applicationPath}
                        >
                          {item.applicationPath}
                        </span>
                      )}
                    </span>
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setContextMenuOpen(
                        useSettingsStore.getState().contextMenuOpen.filter(
                          (entry) => entry.id !== item.id
                        )
                      )
                    }
                  >
                    {t('Delete')}
                  </Button>
                </div>
              );
            })}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => void chooseApplication()}>
              {t('Add application')}
            </Button>
            <Button onClick={() => setOpen(false)}>{t('Close')}</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
