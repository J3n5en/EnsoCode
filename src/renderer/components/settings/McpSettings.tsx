import type { McpServerEntry } from '@shared/types';
import { HardDriveDownload, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { LocalAssetImportDialog } from './LocalAssetImportDialog';
import { McpEditDialog } from './McpEditDialog';

export function McpSettings() {
  const { t } = useI18n();
  const mcpServers = useSettingsStore((state) => state.mcpServers);
  const updateMcpServer = useSettingsStore((state) => state.updateMcpServer);
  const removeMcpServer = useSettingsStore((state) => state.removeMcpServer);
  const [importOpen, setImportOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<McpServerEntry | 'new' | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="font-medium text-lg">{t('MCP Servers')}</h3>
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
        <div className="space-y-1">
          {mcpServers.map((server) => (
            <div
              key={server.id}
              className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <div className="flex min-w-0 items-center gap-2">
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
                <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                  {server.url ?? [server.command, ...(server.args ?? [])].join(' ')}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
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
          ))}
        </div>
      )}

      <LocalAssetImportDialog kind="mcp" open={importOpen} onOpenChange={setImportOpen} />
      <McpEditDialog server={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
