import type { McpServerEntry } from '@shared/types';
import {
  HardDriveDownload,
  Loader2,
  Pencil,
  Plug,
  Plus,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from 'lucide-react';
import * as React from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type McpServerStatus, useMcpStatusStore } from '@/stores/mcpStatus';
import { useSettingsStore } from '@/stores/settings';
import {
  SettingsButton,
  SettingsEmptyState,
  SettingsExpandableRow,
  SettingsPage,
  SettingsSection,
  SettingsSegmented,
  SettingsSubRow,
  SettingsSwitch,
} from './kit';
import { ListFilterBar, matchesFilter, useVisibleSelection } from './ListFilterBar';
import { LocalAssetImportDialog } from './LocalAssetImportDialog';
import { McpEditDialog } from './McpEditDialog';
import { NewSessionBadge } from './NewSessionBadge';
import {
  enabledOccupancyTotal,
  OccupancyEnabledTotal,
  OccupancyMark,
  useOccupancyRows,
} from './OccupancyMark';

function McpStatusBadge({ status }: { status: McpServerStatus }) {
  const { t } = useI18n();
  if (status.state === 'connecting') {
    return (
      <Badge variant="outline" className="shrink-0 animate-pulse text-[11px] text-muted-foreground">
        {t('Connecting')}
      </Badge>
    );
  }
  if (status.state === 'ready') {
    return (
      <Badge variant="success" className="shrink-0 text-[11px]">
        {t('{{count}} tools', { count: status.toolCount ?? 0 })}
      </Badge>
    );
  }
  if (status.state === 'unauthorized') {
    return (
      <Badge variant="warning" className="shrink-0 text-[11px]">
        {t('Not authorized')}
      </Badge>
    );
  }
  if (status.state === 'idle') {
    return (
      <Badge variant="outline" className="shrink-0 text-[11px] text-muted-foreground">
        {t('Authorized, pending connection')}
      </Badge>
    );
  }
  return (
    <Badge variant="error" className="shrink-0 text-[11px]" title={status.error}>
      {t('Connection failed')}
    </Badge>
  );
}

export function McpSettings() {
  const { t } = useI18n();
  const mcpServers = useSettingsStore((state) => state.mcpServers);
  const updateMcpServer = useSettingsStore((state) => state.updateMcpServer);
  const setMcpServersEnabled = useSettingsStore((state) => state.setMcpServersEnabled);
  const removeMcpServer = useSettingsStore((state) => state.removeMcpServer);
  const statuses = useMcpStatusStore((state) => state.statuses);
  const authorizedMap = useMcpStatusStore((state) => state.authorized);
  const pending = useMcpStatusStore((state) => state.pending);
  const authorize = useMcpStatusStore((state) => state.authorize);
  const revoke = useMcpStatusStore((state) => state.revoke);
  React.useEffect(() => useMcpStatusStore.getState().bind(), []);
  const [importOpen, setImportOpen] = React.useState(false);
  // 授权会补进已经选了该服务器的会话；没选过的（刚启用）仍要新会话
  const [authorizedHint, setAuthorizedHint] = React.useState<string | null>(null);
  const runAuthorize = async (serverId: string) => {
    await authorize(serverId);
    setAuthorizedHint(useMcpStatusStore.getState().authorized[serverId] === true ? serverId : null);
  };
  const [editing, setEditing] = React.useState<McpServerEntry | 'new' | null>(null);
  const [pendingRemove, setPendingRemove] = React.useState<McpServerEntry | null>(null);
  const [query, setQuery] = React.useState('');
  const visible = mcpServers.filter((server) =>
    matchesFilter(query, [
      server.name,
      server.source,
      server.transport,
      server.url,
      server.command,
      ...(server.args ?? []),
    ])
  );
  const visibleIds = visible.map((server) => server.id);
  const selection = useVisibleSelection(visibleIds);
  const enabledCount = mcpServers.filter((server) => server.enabled).length;
  const enabledIds = mcpServers.filter((server) => server.enabled).map((server) => server.id);
  const occupancy = useOccupancyRows(enabledIds, (ids) =>
    window.electronAPI.assets.mcpOccupancy(ids)
  );
  const directIds = mcpServers
    .filter((server) => server.enabled && server.loadMode !== 'deferred')
    .map((server) => server.id);
  const enabledTokens = enabledOccupancyTotal(directIds, occupancy.rows);

  return (
    <SettingsPage
      rowId="mcp.root"
      title={
        <>
          {t('MCP Servers')}
          {mcpServers.length > 0 && (
            <span className="font-normal text-muted-foreground text-xs">
              {t('{{enabled}}/{{total}} enabled', {
                enabled: enabledCount,
                total: mcpServers.length,
              })}
              <OccupancyEnabledTotal tokens={enabledTokens} />
            </span>
          )}
        </>
      }
      badge={<NewSessionBadge />}
      description={t('Model Context Protocol servers available to this app')}
      actions={
        <>
          <SettingsButton onClick={() => setImportOpen(true)}>
            <HardDriveDownload className="h-4 w-4" />
            {t('Import from local apps')}
          </SettingsButton>
          <SettingsButton variant="default" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" />
            {t('Add MCP server')}
          </SettingsButton>
        </>
      }
    >
      <SettingsSection>
        {mcpServers.length === 0 ? (
          <SettingsEmptyState
            icon={Plug}
            title={t('No MCP servers yet')}
            description={t('Import MCP servers from local apps or add one manually to get started')}
            actions={
              <>
                <SettingsButton variant="default" onClick={() => setEditing('new')}>
                  <Plus className="h-4 w-4" />
                  {t('Add MCP server')}
                </SettingsButton>
                <SettingsButton onClick={() => setImportOpen(true)}>
                  <HardDriveDownload className="h-4 w-4" />
                  {t('Import from local apps')}
                </SettingsButton>
              </>
            }
          />
        ) : (
          <>
            <ListFilterBar
              query={query}
              onQueryChange={setQuery}
              placeholder={t('Filter MCP servers...')}
              allSelected={selection.allSelected}
              someSelected={selection.someSelected}
              onToggleSelectAll={selection.toggleAll}
              onEnable={() => setMcpServersEnabled(selection.selectedIds, true)}
              onDisable={() => setMcpServersEnabled(selection.selectedIds, false)}
              selectDisabled={visible.length === 0}
              actionDisabled={selection.selectedIds.length === 0}
            />
            {visible.length === 0 ? (
              <SettingsEmptyState
                compact
                title={t('No results')}
                actions={
                  <SettingsButton variant="ghost" size="xs" onClick={() => setQuery('')}>
                    {t('Clear filter')}
                  </SettingsButton>
                }
              />
            ) : (
              visible.map((server) => {
                // 事件可能缺 serverId（旧配置），按名字兜底
                const status = statuses[server.id] ?? statuses[server.name];
                const authorizing = pending[server.id] === true;
                // 授权入口不能依赖 unauthorized 状态：discovery/DCR 失败会归为 error，用户会无路可走
                const canAuthorize =
                  server.transport !== 'stdio' && authorizedMap[server.id] !== true;
                const deferred = server.loadMode === 'deferred';
                return (
                  <SettingsExpandableRow
                    key={server.id}
                    rowId={`mcp.${server.id}`}
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        {/* 勾选框在行标签里：拦住点击，避免顺带拨动右侧开关 */}
                        <span
                          className="inline-flex"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Checkbox
                            checked={selection.isSelected(server.id)}
                            onCheckedChange={(checked) => selection.toggleOne(server.id, checked)}
                          />
                        </span>
                        <span
                          className={cn(
                            'truncate',
                            !server.enabled && 'text-muted-foreground line-through'
                          )}
                        >
                          {server.name}
                        </span>
                      </span>
                    }
                    description={
                      <span className="block truncate font-mono">
                        {server.url ?? [server.command, ...(server.args ?? [])].join(' ')}
                      </span>
                    }
                    status={
                      <>
                        <Badge variant="outline" className="shrink-0 text-[11px]">
                          {server.transport}
                        </Badge>
                        <Badge variant="secondary" className="shrink-0 text-[11px]">
                          {server.source}
                        </Badge>
                        {status && <McpStatusBadge status={status} />}
                        <OccupancyMark
                          row={occupancy.rows[server.id]}
                          pending={
                            server.enabled && occupancy.pending && !occupancy.rows[server.id]
                          }
                        />
                      </>
                    }
                    control={
                      <SettingsSwitch
                        checked={server.enabled}
                        onCheckedChange={(enabled) => updateMcpServer(server.id, { enabled })}
                      />
                    }
                  >
                    <SettingsSubRow
                      rowId="mcp.load-mode"
                      label={t('Load mode')}
                      description={t(
                        'On demand: tool descriptions are not preloaded into context; the model connects through the mcp tool when needed. Suits servers with many or rarely used tools. Takes effect in new conversations.'
                      )}
                    >
                      <SettingsSegmented
                        aria-label={t('Load mode')}
                        value={deferred ? 'deferred' : 'direct'}
                        options={[
                          { value: 'direct', label: t('Always loaded') },
                          { value: 'deferred', label: t('On demand') },
                        ]}
                        onValueChange={(value) =>
                          updateMcpServer(server.id, {
                            loadMode: value === 'deferred' ? 'deferred' : 'direct',
                          })
                        }
                      />
                    </SettingsSubRow>
                    {(canAuthorize || status?.state === 'unauthorized') && (
                      <SettingsSubRow rowId="mcp.authorize" label={t('Authorize')}>
                        <SettingsButton
                          disabled={authorizing}
                          onClick={() => void runAuthorize(server.id)}
                        >
                          {authorizing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          )}
                          {authorizing ? t('Authorizing') : t('Authorize')}
                        </SettingsButton>
                      </SettingsSubRow>
                    )}
                    {authorizedMap[server.id] === true && (
                      <SettingsSubRow
                        rowId="mcp.revoke-authorization"
                        label={t('Revoke authorization')}
                      >
                        <SettingsButton onClick={() => void revoke(server.id)}>
                          <ShieldOff className="h-3.5 w-3.5" />
                          {t('Revoke authorization')}
                        </SettingsButton>
                      </SettingsSubRow>
                    )}
                    {status?.state === 'error' && status.error && (
                      <SettingsSubRow
                        label={<span className="text-destructive-text">{status.error}</span>}
                      >
                        <SettingsButton onClick={() => setEditing(server)}>
                          <Pencil className="h-3.5 w-3.5" />
                          {t('Edit')}
                        </SettingsButton>
                      </SettingsSubRow>
                    )}
                    <SettingsSubRow rowId="mcp.edit" label={t('Edit')}>
                      <SettingsButton onClick={() => setEditing(server)}>
                        <Pencil className="h-3.5 w-3.5" />
                        {t('Edit')}
                      </SettingsButton>
                    </SettingsSubRow>
                    <SettingsSubRow rowId="mcp.delete" label={t('Delete')}>
                      <SettingsButton
                        variant="destructive-outline"
                        className="border-destructive-text/45 text-destructive-text"
                        onClick={() => setPendingRemove(server)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('Delete')}
                      </SettingsButton>
                    </SettingsSubRow>
                    {authorizedHint === server.id && (
                      <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pl-7">
                        {t(
                          'Authorized. Conversations that already include this server can use it on the next message.'
                        )}
                      </p>
                    )}
                  </SettingsExpandableRow>
                );
              })
            )}
          </>
        )}
      </SettingsSection>

      <LocalAssetImportDialog kind="mcp" open={importOpen} onOpenChange={setImportOpen} />
      <McpEditDialog server={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={t('Delete MCP server?')}
        description={
          pendingRemove
            ? t('This permanently deletes the "{{name}}" MCP server configuration.', {
                name: pendingRemove.name,
              })
            : undefined
        }
        confirmLabel={t('Delete')}
        onConfirm={() => {
          if (pendingRemove) removeMcpServer(pendingRemove.id);
        }}
      />
    </SettingsPage>
  );
}
