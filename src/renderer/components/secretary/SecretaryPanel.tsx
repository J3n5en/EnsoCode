import type { SecretaryScheduleView } from '@shared/types/secretary';
import { Settings } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { SecretaryAvatar } from './SecretaryAvatar';
import { SecretaryMemoryPanel } from './SecretaryMemoryPanel';
import { SecretarySchedulePanel } from './SecretarySchedulePanel';
import { SecretaryWorkbench } from './SecretaryWorkbench';
import { SecretarySummary, secretarySectionView } from './secretaryView';

type Tab = 'workbench' | 'memory' | 'schedules';

const TABS: { key: Tab; label: string }[] = [
  { key: 'workbench', label: 'Workbench' },
  { key: 'memory', label: 'Memory' },
  { key: 'schedules', label: 'Schedules' },
];

/** 秘书面板：身份行 + 工作台 / 记忆 / 定时三个标签，替代原来的两块独立面板 */
export function SecretaryPanel() {
  const { t } = useI18n();
  const secretary = useSecretaryStore((state) => state.secretary);
  const [tab, setTab] = useState<Tab>('workbench');
  const [schedules, setSchedules] = useState<SecretaryScheduleView[]>([]);
  const loadSchedules = useCallback(() => {
    void window.electronAPI.secretary.listSchedules().then((result) => {
      if (result.ok) setSchedules(result.schedules);
    });
  }, []);
  // 定时由 Main 派生：打开时读一次，之后每次状态推送都重读
  useEffect(() => {
    loadSchedules();
    return window.electronAPI.secretary.onStateChanged(loadSchedules);
  }, [loadSchedules]);

  const view = secretarySectionView(secretary, t);
  if (!view) return null;

  const badge: Record<Tab, number> = {
    workbench: view.needsYou,
    memory: 0,
    schedules: schedules.length,
  };

  return (
    <div data-enso="secretary-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 px-3 pt-3">
        <SecretaryAvatar
          name={view.name}
          color={view.color}
          image={view.image}
          needsYou={view.needsYou}
          running={view.running}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold">{view.name}</p>
          <p
            data-enso="secretary-summary"
            className="flex min-w-0 items-center truncate text-[11.5px] text-muted-foreground"
          >
            <SecretarySummary view={view} />
          </p>
        </div>
        <button
          type="button"
          data-enso="secretary-panel-settings"
          onClick={() =>
            void window.electronAPI.window.openSettings({
              category: 'secretary',
              rowId: 'secretary.root',
            })
          }
          title={t('Secretary settings')}
          aria-label={t('Secretary settings')}
          className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Settings className="size-4" />
        </button>
      </div>
      <div className="mt-2 flex shrink-0 gap-0.5 border-b border-border px-1.5">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            data-enso="secretary-panel-tab"
            data-tab={key}
            data-active={tab === key || undefined}
            onClick={() => setTab(key)}
            className={cn(
              'relative px-2 pt-1 pb-1.5 text-[12.5px] transition-colors',
              tab === key
                ? 'font-medium text-foreground'
                : 'text-subtle-foreground hover:text-foreground'
            )}
          >
            {t(label)}
            {badge[key] > 0 && (
              <span
                className={cn(
                  'ml-1 text-[11px] tabular-nums',
                  key === 'workbench' ? 'text-warning' : 'text-subtle-foreground'
                )}
              >
                {badge[key]}
              </span>
            )}
            {tab === key && (
              <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-foreground" />
            )}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === 'workbench' && <SecretaryWorkbench name={view.name} />}
        {tab === 'memory' && <SecretaryMemoryPanel />}
        {tab === 'schedules' && (
          <SecretarySchedulePanel schedules={schedules} name={view.name} onReload={loadSchedules} />
        )}
      </div>
    </div>
  );
}
