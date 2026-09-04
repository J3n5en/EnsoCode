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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type McpServerStatus, useMcpStatusStore } from '@/stores/mcpStatus';
import { useSettingsStore } from '@/stores/settings';
import { ListFilterBar, matchesFilter, useVisibleSelection } from './ListFilterBar';
import { LocalAssetImportDialog } from './LocalAssetImportDialog';
import { McpEditDialog } from './McpEditDialog';
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
  // 已运行会话的工具集在 spawn 时定格，授权只影响新会话：成功后明示一句
  const [authorizedHint, setAuthorizedHint] = React.useState<string | null>(null);
  const runAuthorize = async (serverId: string) => {
    await authorize(serverId);
    setAuthorizedHint(useMcpStatusStore.getState().authorized[serverId] === true ? serverId : null);
  };
  const [editing, setEditing] = React.useState<McpServerEntry | 'new' | null>(null);
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
  const enabledTokens = enabledOccupancyTotal(enabledIds, occupancy.rows);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4" data-settings-row="mcp.root">
        <div>
          <h3 className="font-medium text-lg">
            {t('MCP Servers')}
            {mcpServers.length > 0 && (
              <span className="ml-2 font-normal text-muted-foreground text-xs">
                {t('{{enabled}}/{{total}} enabled', {
                  enabled: enabledCount,
                  total: mcpServers.length,
                })}
                <OccupancyEnabledTotal tokens={enabledTokens} />
              </span>
            )}
          </h3>
          <p className="text-muted-foreground text-sm">
            {t('Model Context Protocol servers available to this app')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <HardDriveDownload className="mr-1.5 h-4 w-4" />
            {t('Import from local apps')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('Add MCP server')}
          </Button>
        </div>
      </div>

      {mcpServers.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-8 text-center">
          <Plug className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 font-medium text-sm">{t('No MCP servers yet')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t('Import MCP servers from local apps or add one manually to get started')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
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
            <p className="px-3 py-6 text-center text-muted-foreground text-xs">{t('No results')}</p>
          ) : (
            <div className="space-y-1">
              {visible.map((server) => {
                // 事件可能缺 serverId（旧配置），按名字兜底
                const status = statuses[server.id] ?? statuses[server.name];
                const authorizing = pending[server.id] === true;
                // 授权入口不能依赖 unauthorized 状态：discovery/DCR 失败会归为 error，用户会无路可走
                const canAuthorize =
                  server.transport !== 'stdio' && authorizedMap[server.id] !== true;
                return (
                  <div key={server.id} className="space-y-1">
                    <div
                      className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
                      data-settings-row={`mcp.${server.id}`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Checkbox
                          checked={selection.isSelected(server.id)}
                          onCheckedChange={(checked) => selection.toggleOne(server.id, checked)}
                        />
                        <span
                          className={cn(
                            'shrink-0 font-medium text-sm',
                            !server.enabled && 'text-muted-foreground line-through'
                          )}
                        >
                          {server.name}
                        </span>
                        <Badge variant="outline" className="shrink-0 text-[11px]">
                          {server.transport}
                        </Badge>
                        <Badge variant="secondary" className="shrink-0 text-[11px]">
                          {server.source}
                        </Badge>
                        {status && <McpStatusBadge status={status} />}
                        <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                          {server.url ?? [server.command, ...(server.args ?? [])].join(' ')}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {(canAuthorize || status?.state === 'unauthorized') && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={authorizing}
                            onClick={() => void runAuthorize(server.id)}
                          >
                            {authorizing ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            {authorizing ? t('Authorizing') : t('Authorize')}
                          </Button>
                        )}
                        {authorizedMap[server.id] === true && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t('Revoke authorization')}
                            className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={() => void revoke(server.id)}
                          >
                            <ShieldOff className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <OccupancyMark
                          row={occupancy.rows[server.id]}
                          pending={server.enabled && occupancy.pending && !occupancy.rows[server.id]}
                        />
                        <Switch
                          checked={server.enabled}
                          onCheckedChange={(enabled) => updateMcpServer(server.id, { enabled })}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => setEditing(server)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                          onClick={() => removeMcpServer(server.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    {authorizedHint === server.id && (
                      <p className="px-3 text-muted-foreground text-xs">
                        {t('Authorized. Takes effect in new conversations.')}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <LocalAssetImportDialog kind="mcp" open={importOpen} onOpenChange={setImportOpen} />
      <McpEditDialog server={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
