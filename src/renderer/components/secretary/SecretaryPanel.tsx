import type { SecretaryScheduleView } from '@shared/types/secretary';
import { Settings } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { openSecretarySettings } from '@/lib/secretarySettingsLink';
import { cn } from '@/lib/utils';
import { secretaryIdOfProject, useSecretaryStore } from '@/stores/secretary';
import { SecretaryAvatar } from './SecretaryAvatar';
import { SecretaryContactPanel } from './SecretaryContactPanel';
import { SecretaryDailyBoard } from './SecretaryDailyBoard';
import { SecretaryMemoryPanel } from './SecretaryMemoryPanel';
import { SecretaryRunningList } from './SecretaryRunningList';
import { SecretarySchedulePanel } from './SecretarySchedulePanel';
import { SecretarySkillsPanel } from './SecretarySkillsPanel';
import { SecretaryWorkbench } from './SecretaryWorkbench';
import { SecretarySummary, secretarySectionView } from './secretaryView';

type Tab = 'workbench' | 'daily' | 'memory' | 'schedules' | 'contact' | 'skills';

const TABS: { key: Tab; label: string }[] = [
  { key: 'workbench', label: 'Workbench' },
  { key: 'daily', label: 'Daily board' },
  { key: 'memory', label: 'Memory' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'contact', label: 'Contacts' },
  { key: 'skills', label: 'Skills' },
];

/** 秘书面板：身份行 + 工作台 / 记忆 / 定时三个标签，替代原来的两块独立面板 */
export function SecretaryPanel({ projectId }: { projectId?: string } = {}) {
  const { t } = useI18n();
  // 面板属于打开它的那个秘书会话，不跟着侧栏当前聚焦的秘书走
  const secretaryId = secretaryIdOfProject(projectId) ?? undefined;
  const secretary = useSecretaryStore((state) =>
    secretaryId
      ? (state.states[secretaryId] ??
        (state.focusedId === secretaryId ? state.secretary : undefined) ??
        state.secretary)
      : state.secretary
  );
  const focusProposal = useSecretaryStore((state) => state.focusProposal);
  const reload = useSecretaryStore((state) => state.reload);
  const [tab, setTab] = useState<Tab>('workbench');
  const [runningOpen, setRunningOpen] = useState(false);
  const [schedules, setSchedules] = useState<SecretaryScheduleView[]>([]);
  const loadSchedules = useCallback(() => {
    void window.electronAPI.secretary.listSchedules(secretaryId).then((result) => {
      if (result.ok) setSchedules(result.schedules);
    });
  }, [secretaryId]);
  // 定时由 Main 派生：打开时读一次，之后每次状态推送都重读
  useEffect(() => {
    loadSchedules();
    return window.electronAPI.secretary.onStateChanged(loadSchedules);
  }, [loadSchedules]);
  // 深链或手机按钮要定位某张卡：切回工作台，卡片由工作台滚过去并高亮
  useEffect(() => {
    if (focusProposal) setTab('workbench');
  }, [focusProposal]);

  const view = secretarySectionView(secretary, t);
  if (!view) return <SecretaryPanelPending onReload={() => void reload(secretaryId)} />;

  const badge: Record<Tab, number> = {
    workbench: view.needsYou,
    daily: 0,
    memory: 0,
    schedules: schedules.length,
    contact: 0,
    skills: 0,
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
            <SecretarySummary
              view={view}
              runningExpanded={runningOpen}
              onToggleRunning={() => setRunningOpen((value) => !value)}
            />
          </p>
        </div>
        <button
          type="button"
          data-enso="secretary-panel-settings"
          onClick={() => openSecretarySettings(secretaryId)}
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
      <div
        data-enso="secretary-panel-scroll"
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {runningOpen && <SecretaryRunningList secretaryId={secretaryId} />}
        {tab === 'workbench' && <SecretaryWorkbench name={view.name} secretaryId={secretaryId} />}
        {tab === 'daily' && <SecretaryDailyBoard secretaryId={secretaryId} />}
        {tab === 'memory' && <SecretaryMemoryPanel secretaryId={secretaryId} />}
        {tab === 'contact' && <SecretaryContactPanel secretaryId={secretaryId} />}
        {tab === 'skills' && <SecretarySkillsPanel secretaryId={secretaryId} />}
        {tab === 'schedules' && (
          <SecretarySchedulePanel
            schedules={schedules}
            name={view.name}
            onReload={loadSchedules}
            secretaryId={secretaryId}
          />
        )}
      </div>
    </div>
  );
}

/** 面板拿到的秘书状态还没启用（未读到或读到旧的）：给出提示并主动重读，不留一整块白 */
function SecretaryPanelPending({ onReload }: { onReload: () => void }) {
  const { t } = useI18n();
  const reloadRef = useRef(onReload);
  reloadRef.current = onReload;
  useEffect(() => {
    reloadRef.current();
  }, []);
  return (
    <div
      data-enso="secretary-panel-pending"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <p className="text-[12.5px] text-muted-foreground">{t('Loading secretary…')}</p>
      <button
        type="button"
        data-enso="secretary-panel-reload"
        onClick={onReload}
        className="rounded-md border border-border px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground"
      >
        {t('Retry')}
      </button>
    </div>
  );
}
