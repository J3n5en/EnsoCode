import type { HostToPhone } from '@enso/pair';
import * as React from 'react';
import {
  type CreateDir,
  DirBrowser,
  type DirPage,
  type ListDirs,
} from '@/components/chat/AddProjectDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { requestNode } from '@/stores/remoteNodes/request';

interface Props {
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type DirsReply = Extract<HostToPhone, { type: 'host-dirs-result' }>;

/** 在远程节点上添加项目：目录由对方 main 列出/新建/登记，项目列表随 projects 帧回来 */
export function AddRemoteProjectDialog({ nodeId, open, onOpenChange }: Props) {
  const { t } = useI18n();
  const [pathValue, setPathValue] = React.useState('');
  const [browserOpen, setBrowserOpen] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setPathValue('');
    setBrowserOpen(true);
    setBusy(false);
    setError('');
  }, [open]);

  const errorText = React.useCallback(
    (code: string) =>
      code === 'timeout'
        ? t('The remote desktop did not respond. It may need to be updated.')
        : t(code),
    [t]
  );

  const toPage = React.useCallback(
    (reply: DirsReply): DirPage | { error: string } =>
      reply.error !== undefined || reply.path === undefined
        ? { error: errorText(reply.error ?? 'Failed to list remote directory.') }
        : { path: reply.path, parent: reply.parent ?? null, dirs: reply.dirs ?? [] },
    [errorText]
  );

  const listDirs = React.useCallback<ListDirs>(
    (target) =>
      requestNode(nodeId, { type: 'host-dirs', ...(target ? { path: target } : {}) }).then(toPage),
    [nodeId, toPage]
  );

  const createDir = React.useCallback<CreateDir>(
    (parent, name) =>
      requestNode(nodeId, { type: 'host-dirs', path: parent, create: name }).then(toPage),
    [nodeId, toPage]
  );

  const path = pathValue.trim();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!path || busy) return;
    setBusy(true);
    setError('');
    const reply = await requestNode(nodeId, { type: 'project-add', path });
    setBusy(false);
    if (reply.error !== undefined) {
      setError(errorText(reply.error));
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={(event) => void submit(event)} className="flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('Add project')}</DialogTitle>
            <DialogDescription>
              {t('Add a directory on the remote computer as a project.')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <Field className="w-full">
              <FieldLabel>{t('Working directory')}</FieldLabel>
              <div className="flex w-full gap-2">
                <Input
                  value={pathValue}
                  onChange={(event) => setPathValue(event.target.value)}
                  placeholder="/home/user/project"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="min-w-0 flex-1"
                />
                <Button type="button" variant="outline" onClick={() => setBrowserOpen((v) => !v)}>
                  {t('Browse')}
                </Button>
              </div>
              {browserOpen && (
                <DirBrowser
                  list={listDirs}
                  create={createDir}
                  initialPath={path || undefined}
                  onSelect={(selected) => {
                    setPathValue(selected);
                    setBrowserOpen(false);
                  }}
                  onClose={() => setBrowserOpen(false)}
                />
              )}
            </Field>
            {error && <p className="text-destructive text-xs">{error}</p>}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!path || busy}>
              {t('Add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
