import {
  type DiscoveredMcpServer,
  formatMcpHeaderLines,
  parseMcpHeaderLines,
  parseMcpImportJson,
} from '@shared/mcpConfig';
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  MAX_MCP_CALL_TIMEOUT_SEC,
  MAX_MCP_CONNECT_TIMEOUT_SEC,
  parseMcpTimeoutSec,
} from '@shared/mcpTimeout';
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
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';
import { CodeEditor } from './CodeEditor';

interface McpEditDialogProps {
  /** 'new' 表示手动新建 */
  server: McpServerEntry | 'new' | null;
  onClose: () => void;
}

type EditorMode = 'form' | 'json';

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

const specFromDiscovered = (entry: DiscoveredMcpServer): Record<string, unknown> => {
  const spec: Record<string, unknown> = { type: entry.transport };
  if (entry.command) spec.command = entry.command;
  if (entry.args && entry.args.length > 0) spec.args = entry.args;
  if (entry.env && Object.keys(entry.env).length > 0) spec.env = entry.env;
  if (entry.url) spec.url = entry.url;
  if (entry.headers && Object.keys(entry.headers).length > 0) spec.headers = entry.headers;
  return spec;
};

export function McpEditDialog({ server, onClose }: McpEditDialogProps) {
  const { t } = useI18n();
  const addMcpServers = useSettingsStore((state) => state.addMcpServers);
  const updateMcpServer = useSettingsStore((state) => state.updateMcpServer);
  const creating = server === 'new';

  const [mode, setMode] = React.useState<EditorMode>('form');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [oauthClientName, setOauthClientName] = React.useState('');
  const [oauthMetadataUrl, setOauthMetadataUrl] = React.useState('');
  const [transport, setTransport] = React.useState<McpTransport>('stdio');
  const [command, setCommand] = React.useState('');
  const [argsText, setArgsText] = React.useState('');
  const [envText, setEnvText] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [headersText, setHeadersText] = React.useState('');
  const [connectTimeout, setConnectTimeout] = React.useState('');
  const [callTimeout, setCallTimeout] = React.useState('');
  const [jsonText, setJsonText] = React.useState('');
  const [jsonEpoch, setJsonEpoch] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const serverOptions = () => ({
    description: description.trim() || undefined,
    oauthClientName: (transport !== 'stdio' && oauthClientName.trim()) || undefined,
    oauthMetadataUrl: (transport !== 'stdio' && oauthMetadataUrl.trim()) || undefined,
    connectTimeoutSec: parseMcpTimeoutSec(connectTimeout, MAX_MCP_CONNECT_TIMEOUT_SEC),
    callTimeoutSec: parseMcpTimeoutSec(callTimeout, MAX_MCP_CALL_TIMEOUT_SEC),
  });

  const applyDiscovered = (entry: DiscoveredMcpServer) => {
    setName(entry.name);
    setTransport(entry.transport);
    setCommand(entry.command ?? '');
    setArgsText((entry.args ?? []).join('\n'));
    setEnvText(formatEnv(entry.env && Object.keys(entry.env).length > 0 ? entry.env : undefined));
    setUrl(entry.url ?? '');
    setHeadersText(formatMcpHeaderLines(entry.headers));
  };

  const formToJson = (): string => {
    const spec: Record<string, unknown> = { type: transport };
    if (transport === 'stdio') {
      spec.command = command.trim();
      const args = parseLines(argsText);
      if (args) spec.args = args;
      const env = parseEnv(envText);
      if (env) spec.env = env;
    } else {
      spec.url = url.trim();
      const headers = parseMcpHeaderLines(headersText);
      if (headers) spec.headers = headers;
    }
    return JSON.stringify(spec, null, 2);
  };

  const toPayload = (entry: DiscoveredMcpServer, nameOverride?: string) => {
    const nextName = (nameOverride ?? entry.name).trim();
    const env = entry.env && Object.keys(entry.env).length > 0 ? entry.env : undefined;
    const args = entry.args && entry.args.length > 0 ? entry.args : undefined;
    return entry.transport === 'stdio'
      ? {
          name: nextName,
          transport: entry.transport,
          command: (entry.command ?? '').trim(),
          args,
          env,
          url: undefined,
          headers: undefined,
          ...serverOptions(),
        }
      : {
          name: nextName,
          transport: entry.transport,
          url: (entry.url ?? '').trim(),
          headers:
            entry.headers && Object.keys(entry.headers).length > 0 ? entry.headers : undefined,
          command: undefined,
          args: undefined,
          env: undefined,
          ...serverOptions(),
        };
  };

  React.useEffect(() => {
    if (!server) return;
    const base = server === 'new' ? null : server;
    setMode('form');
    setName(base?.name ?? '');
    setDescription(base?.description ?? '');
    setOauthClientName(base?.oauthClientName ?? '');
    setOauthMetadataUrl(base?.oauthMetadataUrl ?? '');
    setTransport(base?.transport ?? 'stdio');
    setCommand(base?.command ?? '');
    setArgsText((base?.args ?? []).join('\n'));
    setEnvText(formatEnv(base?.env));
    setUrl(base?.url ?? '');
    setHeadersText(formatMcpHeaderLines(base?.headers));
    setConnectTimeout(base?.connectTimeoutSec?.toString() ?? '');
    setCallTimeout(base?.callTimeoutSec?.toString() ?? '');
    setJsonText('');
    setJsonEpoch((n) => n + 1);
    setError(null);
  }, [server]);

  const importError = (kind: 'invalid-json' | 'empty') =>
    kind === 'invalid-json' ? t('Invalid JSON') : t('No MCP servers found in JSON');

  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    if (next === 'json') {
      setJsonText(formToJson());
      setJsonEpoch((n) => n + 1);
      setError(null);
      setMode('json');
      return;
    }
    const parsed = parseMcpImportJson(jsonText);
    if (!parsed.ok) {
      if (parsed.error === 'invalid-json' && jsonText.trim()) {
        setError(importError(parsed.error));
        return;
      }
      setError(null);
      setMode('form');
      return;
    }
    if (parsed.servers.length !== 1) {
      setError(t('JSON must describe a single MCP server to switch to the form'));
      return;
    }
    const entry = parsed.servers[0];
    applyDiscovered({ ...entry, name: name.trim() || entry.name });
    setError(null);
    setMode('form');
  };

  const formatJson = () => {
    const parsed = parseMcpImportJson(jsonText);
    if (!parsed.ok) {
      setError(importError(parsed.error));
      return;
    }
    if (parsed.servers.length === 1) {
      const [entry] = parsed.servers;
      setJsonText(JSON.stringify(specFromDiscovered(entry), null, 2));
      setJsonEpoch((n) => n + 1);
      if (!name.trim()) setName(entry.name);
    } else {
      setJsonText(
        JSON.stringify(
          {
            mcpServers: Object.fromEntries(
              parsed.servers.map((entry) => [entry.name, specFromDiscovered(entry)])
            ),
          },
          null,
          2
        )
      );
      setJsonEpoch((n) => n + 1);
    }
    setError(null);
  };

  const formCanSave =
    Boolean(name.trim()) && (transport === 'stdio' ? Boolean(command.trim()) : Boolean(url.trim()));
  const canSave = mode === 'json' ? Boolean(jsonText.trim()) : formCanSave;

  const handleSave = () => {
    if (!server || !canSave) return;

    if (mode === 'json') {
      const parsed = parseMcpImportJson(jsonText);
      if (!parsed.ok) {
        setError(importError(parsed.error));
        return;
      }
      if (!creating && parsed.servers.length !== 1) {
        setError(t('JSON must describe a single MCP server'));
        return;
      }
      if (creating) {
        const single = parsed.servers.length === 1;
        const added = addMcpServers(
          parsed.servers.map((entry) => ({
            ...toPayload(entry, single && name.trim() ? name : entry.name),
            ...(single ? {} : { description: undefined }),
            id: crypto.randomUUID(),
            source: 'Manual',
            enabled: true,
          }))
        );
        if (added === 0) {
          setError(t('This MCP server already exists'));
          return;
        }
      } else {
        updateMcpServer(
          server.id,
          toPayload(parsed.servers[0], name.trim() || parsed.servers[0].name)
        );
      }
      onClose();
      return;
    }

    const data =
      transport === 'stdio'
        ? {
            name: name.trim(),
            transport,
            command: command.trim(),
            args: parseLines(argsText),
            env: parseEnv(envText),
            url: undefined,
            headers: undefined,
            ...serverOptions(),
          }
        : {
            name: name.trim(),
            transport,
            url: url.trim(),
            headers: parseMcpHeaderLines(headersText),
            command: undefined,
            args: undefined,
            env: undefined,
            ...serverOptions(),
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
          <Tabs value={mode} onValueChange={(value) => switchMode(value as EditorMode)}>
            <TabsList>
              <TabsTab value="form">{t('Form')}</TabsTab>
              <TabsTab value="json">{t('JSON')}</TabsTab>
            </TabsList>
          </Tabs>

          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>{t('Description (optional)')}</FieldLabel>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('One line telling the model what this server is for')}
            />
          </Field>

          {mode === 'json' ? (
            <Field>
              <div className="flex w-full items-center justify-between">
                <FieldLabel>{t('JSON configuration')}</FieldLabel>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={formatJson}>
                  {t('Format')}
                </Button>
              </div>
              <CodeEditor
                fileName="mcp.json"
                value={jsonText}
                epoch={jsonEpoch}
                onChange={setJsonText}
              />
              <p className="text-muted-foreground text-xs">
                {t('Paste a server object or mcpServers JSON from Cursor / Claude Desktop')}
              </p>
            </Field>
          ) : (
            <>
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
                <>
                  <Field>
                    <FieldLabel>{t('URL')}</FieldLabel>
                    <Input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://..."
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t('Headers (Name: value, one per line)')}</FieldLabel>
                    <Textarea
                      value={headersText}
                      onChange={(e) => setHeadersText(e.target.value)}
                      rows={2}
                      placeholder="Authorization: Bearer <token>"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{t('OAuth client name (optional)')}</FieldLabel>
                    <Input
                      value={oauthClientName}
                      onChange={(e) => setOauthClientName(e.target.value)}
                      placeholder={t('For servers that only accept known OAuth clients')}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>
                      {t('OAuth authorization server metadata URL (optional)')}
                    </FieldLabel>
                    <Input
                      value={oauthMetadataUrl}
                      onChange={(e) => setOauthMetadataUrl(e.target.value)}
                      placeholder={t(
                        'Use when the server advertises a wrong authorization server or none'
                      )}
                      className="font-mono text-xs"
                    />
                  </Field>
                </>
              )}

              <Field>
                <FieldLabel>{t('Connection timeout (seconds)')}</FieldLabel>
                <Input
                  inputMode="numeric"
                  value={connectTimeout}
                  onChange={(e) => setConnectTimeout(e.target.value)}
                  placeholder={String(DEFAULT_MCP_CONNECT_TIMEOUT_MS / 1000)}
                />
              </Field>
              <Field>
                <FieldLabel>{t('Tool call timeout (seconds)')}</FieldLabel>
                <Input
                  inputMode="numeric"
                  value={callTimeout}
                  onChange={(e) => setCallTimeout(e.target.value)}
                  placeholder={String(DEFAULT_MCP_CALL_TIMEOUT_MS / 1000)}
                />
              </Field>
            </>
          )}

          {error && (
            <p key={error} className="t-shake-in text-destructive text-xs">
              {error}
            </p>
          )}
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
