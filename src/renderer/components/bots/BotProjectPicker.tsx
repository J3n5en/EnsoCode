import { projectNameFromPath } from '@shared/projectName';
import type { RecentProject } from '@shared/types';
import { useEffect, useMemo, useState } from 'react';
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from '@/components/ui/autocomplete';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';
import { localProjects } from './botText';

interface PickItem {
  path: string;
  label: string;
  detail: string;
  projectId?: string;
}

/** 群工作区的 Code 项目选择：可搜索已有项目，也可从最近目录或「浏览」新增为 Code 项目 */
export function BotProjectPicker({
  projectId,
  onChange,
}: {
  projectId: string;
  onChange: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const allProjects = useSettingsStore((s) => s.projects);
  const addProject = useSettingsStore((s) => s.addProject);
  const projects = useMemo(() => localProjects(allProjects), [allProjects]);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [query, setQuery] = useState(
    () => projects.find((project) => project.id === projectId)?.path ?? ''
  );

  useEffect(() => {
    window.electronAPI.projects
      .getRecent()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  // 外部改了选中项（如对话框重置为默认项目）时同步输入框
  useEffect(() => {
    const path = projects.find((project) => project.id === projectId)?.path;
    if (path) setQuery(path);
  }, [projectId, projects]);

  const items = useMemo<PickItem[]>(() => {
    const known = new Set(projects.map((project) => project.path));
    return [
      ...projects.map((project) => ({
        path: project.path,
        label: project.alias || project.name,
        detail: project.path,
        projectId: project.id,
      })),
      ...recent
        .filter((item) => !known.has(item.path))
        .map((item) => ({
          path: item.path,
          label: projectNameFromPath(item.path),
          detail: `${item.displayPath} · ${item.sourceName}`,
        })),
    ];
  }, [projects, recent]);

  const pickPath = async (path: string) => {
    setQuery(path);
    const existing = projects.find((project) => project.path === path);
    if (existing) return onChange(existing.id);
    try {
      const added = await addProject(path);
      if (!added) throw new Error();
      onChange(added.id);
    } catch (error) {
      addToast({
        type: 'error',
        title: t('Failed to add project'),
        description: (error instanceof Error && error.message) || undefined,
      });
    }
  };

  return (
    <Autocomplete
      value={query}
      onValueChange={(value, details) => {
        setQuery(value ?? '');
        if (details.reason === 'item-press' && value) void pickPath(value);
        else if (projectId) onChange('');
      }}
      items={items}
      filter={(item: PickItem, needle: string) => {
        if (!needle) return true;
        const lower = needle.toLowerCase();
        return [item.label, item.path, item.detail].some((text) =>
          text.toLowerCase().includes(lower)
        );
      }}
      itemToStringValue={(item: PickItem) => item.path}
    >
      <div className="mt-2 flex w-full gap-2">
        <div className="min-w-0 flex-1">
          <AutocompleteInput
            placeholder={t('Search Code projects or recent folders...')}
            showClear={!!query}
            showTrigger
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void window.electronAPI.dialog.selectDirectory().then((path) => {
              if (path) void pickPath(path);
            })
          }
        >
          {t('Browse')}
        </Button>
      </div>
      <AutocompletePopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
        <AutocompleteEmpty>{t('No matching projects found')}</AutocompleteEmpty>
        <AutocompleteList>
          {(item: PickItem) => (
            <AutocompleteItem key={item.path} value={item} className="gap-2">
              <span className="shrink-0">{item.label}</span>
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground text-xs"
                title={item.path}
              >
                {item.detail}
              </span>
              {!item.projectId && (
                <span className="shrink-0 text-muted-foreground text-xs">{t('Add')}</span>
              )}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  );
}
