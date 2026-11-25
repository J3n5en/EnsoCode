import type { SshAuth, SshConnection, SshHostKeyChallenge } from '@shared/types';
import { Loader2, Plus, Terminal, Trash2 } from 'lucide-react';
import * as React from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { hostKeyFromSshFailure, SshHostKeyDialog } from '@/components/chat/SshHostKeyDialog';
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
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';
import {
  SettingsButton,
  SettingsEmptyState,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from './kit';
import { NewSessionBadge } from './NewSessionBadge';

const SSH_TIMEOUT_OPTIONS = [10, 15, 30, 60, 120, 300];

export function SshSettings() {
  const { t } = useI18n();
  const [connections, setConnections] = React.useState<SshConnection[]>([]);
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SshConnection | null>(null);
  const [name, setName] = React.useState('');
  const [host, setHost] = React.useState('');
  const [user, setUser] = React.useState('');
  const [port, setPort] = React.useState('');
  const [auth, setAuth] = React.useState<SshAuth>('key');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [testHint, setTestHint] = React.useState<string | null>(null);
  const [hostKey, setHostKey] = React.useState<{
    id: string;
    challenge: SshHostKeyChallenge;
  } | null>(null);
  const [trusting, setTrusting] = React.useState(false);
  const [pendingRemove, setPendingRemove] = React.useState<SshConnection | null>(null);

  const reload = React.useCallback(() => {
    void window.electronAPI.sshConnections.list().then(setConnections);
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setHost('');
    setUser('');
    setPort('');
    setAuth('key');
    setPassword('');
    setError(null);
    setOpen(true);
  };

  const openEdit = (connection: SshConnection) => {
    setEditing(connection);
    setName(connection.name);
    setHost(connection.host);
    setUser(connection.user ?? '');
    setPort(connection.port ? String(connection.port) : '');
    setAuth(connection.auth);
    setPassword('');
    setError(null);
    setOpen(true);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const parsedPort = port.trim() ? Number(port) : undefined;
    const result = await window.electronAPI.sshConnections.upsert({
      ...(editing ? { id: editing.id } : {}),
      name: name.trim(),
      host: host.trim(),
      ...(user.trim() ? { user: user.trim() } : {}),
      ...(parsedPort && Number.isInteger(parsedPort) ? { port: parsedPort } : {}),
      auth,
      ...(auth === 'password' && password ? { password } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    reload();
  };

  const remove = async (id: string) => {
    const result = await window.electronAPI.sshConnections.delete(id);
    if (!result.ok) {
      setTestHint(result.error);
      return;
    }
    setTestHint(null);
    reload();
  };

  const test = async (id: string, promptHostKey = true) => {
    setTestingId(id);
    setTestHint(null);
    const result = await window.electronAPI.sshConnections.test(id);
    setTestingId(null);
    if (!result.ok) {
      const connection = connections.find((row) => row.id === id);
      const challenge = hostKeyFromSshFailure(result, connection);
      if (challenge && promptHostKey) {
        setHostKey({ id, challenge });
        return;
      }
    }
    setTestHint(result.ok ? t('SSH connection succeeded') : result.error);
  };

  const trustHost = async () => {
    if (!hostKey) return;
    setTrusting(true);
    const id = hostKey.id;
    const trusted = await window.electronAPI.sshConnections.trustHost(id);
    setTrusting(false);
    setHostKey(null);
    if (!trusted.ok) {
      setTestHint(trusted.error || t('Could not save host key.'));
      return;
    }
    await test(id, false);
  };

  return (
    <SettingsPage
      rowId="ssh.root"
      title={
        <>
          {t('SSH')}
          <NewSessionBadge
            note={t(
              'The file panel and terminal use the change right away. Agents in open sessions keep the previous connection settings.'
            )}
          />
        </>
      }
      description={t('Saved hosts for remote projects. Passwords stay in the system keychain.')}
      actions={
        <SettingsButton variant="default" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          {t('Add connection')}
        </SettingsButton>
      }
    >
      {testHint && <p className="mt-3 text-[13px] text-muted-foreground">{testHint}</p>}
      <SettingsSection>
        {connections.length === 0 ? (
          <SettingsEmptyState
            compact
            icon={Terminal}
            title={t('No SSH connections yet')}
            actions={
              <SettingsButton variant="default" size="xs" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                {t('Add connection')}
              </SettingsButton>
            }
          />
        ) : (
          connections.map((connection) => (
            <div
              key={connection.id}
              className="flex flex-wrap items-center gap-2 px-4 py-2.5 max-sm:px-3"
              data-settings-row={`ssh.${connection.id}`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 py-1 text-left"
                onClick={() => openEdit(connection)}
              >
                <div className="truncate text-sm font-medium">{connection.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {connection.user ? `${connection.user}@` : ''}
                  {connection.host}
                  {connection.port ? `:${connection.port}` : ''} ·{' '}
                  {connection.auth === 'password' ? t('Password') : t('Key / agent')}
                </div>
              </button>
              <SettingsButton
                disabled={testingId === connection.id}
                onClick={() => void test(connection.id)}
              >
                {testingId === connection.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t('Test')
                )}
              </SettingsButton>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('Delete')}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setPendingRemove(connection)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
        <SshTimeoutRow />
      </SettingsSection>
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(openState) => {
          if (!openState) setPendingRemove(null);
        }}
        title={t('Delete SSH connection?')}
        description={
          pendingRemove
            ? t('This permanently deletes "{{name}}".', { name: pendingRemove.name })
            : undefined
        }
        confirmLabel={t('Delete')}
        onConfirm={() => {
          if (pendingRemove) void remove(pendingRemove.id);
        }}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <form onSubmit={(event) => void save(event)} className="flex flex-col">
            <DialogHeader>
              <DialogTitle>
                {editing ? t('Edit SSH connection') : t('Add SSH connection')}
              </DialogTitle>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <Field>
                <FieldLabel>{t('Name')}</FieldLabel>
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <Field>
                <FieldLabel>{t('Host')}</FieldLabel>
                <Input
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="example.com"
                  required
                />
              </Field>
              <Field>
                <FieldLabel>{t('User (optional)')}</FieldLabel>
                <Input value={user} onChange={(event) => setUser(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel>{t('Port (optional)')}</FieldLabel>
                <Input
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  placeholder="22"
                />
              </Field>
              <Field>
                <FieldLabel>{t('Authentication')}</FieldLabel>
                <Select
                  items={[
                    { value: 'key', label: t('Key / agent') },
                    { value: 'password', label: t('Password') },
                  ]}
                  value={auth}
                  onValueChange={(value) => setAuth(value as SshAuth)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                    <SelectItem value="key">{t('Key / agent')}</SelectItem>
                    <SelectItem value="password">{t('Password')}</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
              {auth === 'password' && (
                <Field>
                  <FieldLabel>
                    {editing?.hasPassword ? t('Password (leave blank to keep)') : t('Password')}
                  </FieldLabel>
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required={!editing?.hasPassword}
                  />
                </Field>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {t('Save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <SshHostKeyDialog
        challenge={hostKey?.challenge ?? null}
        busy={trusting}
        onTrust={() => void trustHost()}
        onDismiss={() => !trusting && setHostKey(null)}
      />
    </SettingsPage>
  );
}

function SshTimeoutRow() {
  const { t } = useI18n();
  const sshTimeoutSeconds = useSettingsStore((state) => state.sshTimeoutSeconds);
  const setSshTimeoutSeconds = useSettingsStore((state) => state.setSshTimeoutSeconds);
  return (
    <SettingsRow
      rowId="ssh.timeout"
      label={t('SSH timeout')}
      description={t(
        'Time limit for connection tests, loading remote AGENTS.md, remote folder browsing and file panel actions. Agent tool commands are not affected.'
      )}
    >
      <SettingsSelect
        value={String(sshTimeoutSeconds)}
        onValueChange={(value) => setSshTimeoutSeconds(Number(value))}
        options={SSH_TIMEOUT_OPTIONS.map((value) => ({
          value: String(value),
          label: `${value}s`,
        }))}
      />
    </SettingsRow>
  );
}
