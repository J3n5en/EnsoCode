import type { SshAuth, SshConnection } from '@shared/types';
import { Loader2, Plus, Trash2 } from 'lucide-react';
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
import { useI18n } from '@/i18n';

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

  const test = async (id: string) => {
    setTestingId(id);
    setTestHint(null);
    const result = await window.electronAPI.sshConnections.test(id);
    setTestingId(null);
    setTestHint(result.ok ? t('SSH connection succeeded') : result.error);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4" data-settings-row="ssh.root">
        <div>
          <h2 className="text-lg font-medium">{t('SSH')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Saved hosts for remote projects. Passwords stay in the system keychain.')}
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          {t('Add connection')}
        </Button>
      </div>
      {testHint && <p className="text-sm text-muted-foreground">{testHint}</p>}
      <ul className="divide-y rounded-lg border">
        {connections.length === 0 && (
          <li className="px-3 py-6 text-sm text-muted-foreground">{t('No SSH connections yet')}</li>
        )}
        {connections.map((connection) => (
          <li
            key={connection.id}
            className="flex items-center gap-2 px-3 py-2"
            data-settings-row={`ssh.${connection.id}`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
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
            <Button
              size="sm"
              variant="outline"
              disabled={testingId === connection.id}
              onClick={() => void test(connection.id)}
            >
              {testingId === connection.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t('Test')
              )}
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => void remove(connection.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>

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
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={auth}
                  onChange={(event) => setAuth(event.target.value as SshAuth)}
                >
                  <option value="key">{t('Key / agent')}</option>
                  <option value="password">{t('Password')}</option>
                </select>
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
    </div>
  );
}
