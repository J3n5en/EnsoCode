import type { McpServerEntry, McpTransport } from '@shared/types';
import { MCP_TRANSPORTS } from '@shared/types';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';

interface McpEditDialogProps {
  /** 'new' 表示手动新建 */
  server: McpServerEntry | 'new' | null;
  onClose: () => void;
}

const parseLines = (text: string): string[] | undefined => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
};

const parseEnv = (text: string): Record<string, string> | undefined => {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
};

const formatEnv = (env?: Record<string, string>): string =>
  env
    ? Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    : '';

export function McpEditDialog({ server, onClose }: McpEditDialogProps) {
  const { t } = useI18n();
  const addMcpServers = useSettingsStore((state) => state.addMcpServers);
  const updateMcpServer = useSettingsStore((state) => state.updateMcpServer);
  const creating = server === 'new';

  const [name, setName] = React.useState('');
  const [transport, setTransport] = React.useState<McpTransport>('stdio');
  const [command, setCommand] = React.useState('');
  const [argsText, setArgsText] = React.useState('');
  const [envText, setEnvText] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!server) return;
    const base = server === 'new' ? null : server;
    setName(base?.name ?? '');
    setTransport(base?.transport ?? 'stdio');
    setCommand(base?.command ?? '');
    setArgsText((base?.args ?? []).join('\n'));
    setEnvText(formatEnv(base?.env));
    setUrl(base?.url ?? '');
    setError(null);
  }, [server]);

  const canSave =
    Boolean(name.trim()) && (transport === 'stdio' ? Boolean(command.trim()) : Boolean(url.trim()));

  const handleSave = () => {
    if (!server || !canSave) return;
    const data =
      transport === 'stdio'
        ? {
            name: name.trim(),
            transport,
            command: command.trim(),
            args: parseLines(argsText),
            env: parseEnv(envText),
            url: undefined,
          }
        : {
            name: name.trim(),
            transport,
            url: url.trim(),
            command: undefined,
            args: undefined,
            env: undefined,
          };

    if (creating) {
      const added = addMcpServers([
        { ...data, id: crypto.randomUUID(), source: 'Manual', enabled: true },
      ]);
      if (added === 0) {
        setError(t('This MCP server already exists'));
        return;
      }
    } else {
      updateMcpServer(server.id, data);
    }
    onClose();
  };

  return (
    <Dialog open={server !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{creating ? t('Add MCP Server') : t('Edit MCP Server')}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field>
            <FieldLabel>{t('Transport')}</FieldLabel>
            <Select
              items={MCP_TRANSPORTS.map((kind) => ({ value: kind, label: kind }))}
              value={transport}
              onValueChange={(v) => setTransport(v as McpTransport)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {MCP_TRANSPORTS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          {transport === 'stdio' ? (
            <>
              <Field>
                <FieldLabel>{t('Command')}</FieldLabel>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="font-mono text-xs"
                />
              </Field>
              <Field>
                <FieldLabel>{t('Arguments (one per line)')}</FieldLabel>
                <Textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                />
              </Field>
              <Field>
                <FieldLabel>{t('Environment variables (KEY=VALUE, one per line)')}</FieldLabel>
                <Textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                />
              </Field>
            </>
          ) : (
            <Field>
              <FieldLabel>{t('URL')}</FieldLabel>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://..."
                className="font-mono text-xs"
              />
            </Field>
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={handleSave}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
