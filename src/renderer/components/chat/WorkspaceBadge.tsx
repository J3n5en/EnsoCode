import type { OpenInApp } from '@shared/types';
import { Code2, Copy, Folder, FolderOpen, GitBranch, SquareTerminal } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import { openDirectoryFromMenu, openDirectoryLabel } from '@/components/chat/openDirectoryAction';
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import { useI18n } from '@/i18n';

const REVEAL =
  'group-hover:grid-cols-[1fr] group-hover:opacity-100 group-focus-visible:grid-cols-[1fr] group-focus-visible:opacity-100 group-data-popup-open:grid-cols-[1fr] group-data-popup-open:opacity-100';

/** 会话头部右侧的工作区徽标：平时只有文件夹图标和状态点，悬停展开项目/分支，点击打开「用…打开」菜单 */
export function WorkspaceBadge({
  project,
  conversationId,
  path,
  branch,
  openDisabled,
  children,
}: {
  project: { id: string; name: string; kind?: string };
  conversationId: string;
  path: string;
  branch?: string;
  openDisabled?: boolean;
  /** 状态点 */
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [apps, setApps] = useState<OpenInApp[]>([]);
  // 远端客户端：打开 / 用应用打开都发生在宿主机上，只留复制路径
  const local = project.kind !== 'ssh' && !window.electronAPI.remote;
  const scratch = project.kind === 'scratch';
  const label = scratch ? t('Temporary chats') : project.name;
  const refreshApps = useCallback(() => {
    if (!local) return;
    window.electronAPI.projects
      .openInApps()
      .then(setApps)
      .catch(() => undefined);
  }, [local]);
  const open = (appId?: string) =>
    void openDirectoryFromMenu(
      { projectId: project.id, conversationId, ...(appId ? { appId } : {}) },
      t
    );
  const editors = apps.filter((app) => app.kind === 'editor');
  const terminals = apps.filter((app) => app.kind === 'terminal');

  return (
    <Menu onOpenChange={(next) => next && refreshApps()}>
      <MenuTrigger
        className="group ml-1.5 flex h-6 min-w-0 shrink-0 items-center rounded-full border border-border/60 px-2 font-mono text-[11.5px] text-muted-foreground outline-none transition-colors duration-(--duration-quick) hover:border-border focus-visible:border-border data-popup-open:border-border"
        title={scratch ? label : path}
        aria-label={branch && !scratch ? `${label} / ${branch}` : label}
        onPointerEnter={refreshApps}
      >
        <Folder className="h-3 w-3 shrink-0" />
        <span
          className={`grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-(--duration-fast) ease-(--ease-smooth-out) ${REVEAL}`}
        >
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap pl-1.5">
            <span className="max-w-40 truncate">{label}</span>
            {branch && !scratch && (
              <>
                <span className="opacity-40">/</span>
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="max-w-40 truncate">{branch}</span>
              </>
            )}
          </span>
        </span>
        <span className="ml-1.5 flex shrink-0 items-center">{children}</span>
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-48">
        {local && (
          <>
            <MenuItem disabled={openDisabled} onClick={() => open()}>
              <FolderOpen />
              {t(openDirectoryLabel(window.electronAPI.env.platform))}
            </MenuItem>
            <AppGroup
              label={t('Editors')}
              apps={editors}
              fallback={<Code2 />}
              disabled={openDisabled}
              onOpen={open}
            />
            <AppGroup
              label={t('Terminals')}
              apps={terminals}
              fallback={<SquareTerminal />}
              disabled={openDisabled}
              onOpen={open}
            />
            <MenuSeparator />
          </>
        )}
        <MenuItem onClick={() => void navigator.clipboard.writeText(path)}>
          <Copy />
          {t('Copy Path')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function AppGroup({
  label,
  apps,
  fallback,
  disabled,
  onOpen,
}: {
  label: string;
  apps: OpenInApp[];
  fallback: ReactNode;
  disabled?: boolean;
  onOpen: (appId: string) => void;
}) {
  if (apps.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>{label}</MenuGroupLabel>
        {apps.map((app) => (
          <MenuItem key={app.id} disabled={disabled} onClick={() => onOpen(app.id)}>
            {app.icon ? (
              <img src={app.icon} alt="" className="-mx-0.5 size-4 shrink-0" />
            ) : (
              fallback
            )}
            {app.name}
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );
}
