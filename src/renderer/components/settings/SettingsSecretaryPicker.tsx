import type { SecretarySummary } from '@shared/types/secretary';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { SETTINGS_SECRETARY_KEY } from '@/lib/secretarySettingsLink';
import { cn } from '@/lib/utils';

function readSelected(): string | undefined {
  try {
    return localStorage.getItem(SETTINGS_SECRETARY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 设置里各秘书相关分区共用「正在编辑哪个秘书」：选中记在 SETTINGS_SECRETARY_KEY，主窗口改了跟着切 */
export function useSettingsSecretaries() {
  const [secretaries, setSecretaries] = React.useState<SecretarySummary[]>([]);
  const [selected, setSelected] = React.useState<string | undefined>(readSelected);

  const reload = React.useCallback(async () => {
    setSecretaries(await window.electronAPI.secretary.list());
  }, []);

  React.useEffect(() => {
    void reload();
    return window.electronAPI.secretary.onListChanged(setSecretaries);
  }, [reload]);

  React.useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key === SETTINGS_SECRETARY_KEY && event.newValue) setSelected(event.newValue);
    };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);

  const select = React.useCallback((id: string | undefined) => {
    setSelected(id);
    try {
      if (id) localStorage.setItem(SETTINGS_SECRETARY_KEY, id);
    } catch {
      // 存不下只影响下次进来时默认选哪个
    }
  }, []);

  const current =
    secretaries.find((entry) => entry.id === selected)?.id ?? secretaries[0]?.id ?? undefined;
  return {
    secretaries,
    setSecretaries,
    current,
    multiple: secretaries.length > 1,
    select,
    reload,
  };
}

export function SettingsSecretaryChips({
  secretaries,
  current,
  onSelect,
}: {
  secretaries: SecretarySummary[];
  current: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  return secretaries.map((entry) => (
    <button
      key={entry.id}
      type="button"
      data-enso="secretary-settings-pick"
      data-secretary-id={entry.id}
      data-selected={entry.id === current || undefined}
      onClick={() => onSelect(entry.id)}
      className={cn(
        'relative rounded-full px-2.5 py-1 text-xs ring-1 transition-colors',
        entry.id === current
          ? 'bg-foreground/5 text-foreground ring-foreground/40'
          : 'text-muted-foreground ring-border hover:text-foreground'
      )}
    >
      {entry.name ?? t('Secretary')}
    </button>
  ));
}
