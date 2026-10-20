import {
  type FileOpenRule,
  fileOpenViewer,
  isExternalFileOpenBlocked,
  isFileOpenApplicationPath,
  normalizeFileOpenRules,
  parseFileOpenRules,
} from '@shared/fileOpening';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { ContextMenuOpeningSettings } from './ContextMenuOpeningSettings';

type Target = FileOpenRule['target'];
const TARGETS: Target[] = ['internal', 'reveal', 'system', 'application'];

function TargetPicker({
  extension,
  value,
  disabled,
  onChange,
}: {
  extension: string;
  value: Target;
  disabled: boolean;
  onChange: (value: Target) => void;
}) {
  const { t } = useI18n();
  const labels: Record<Target, string> = {
    internal: t('Open inside EnsoCode'),
    reveal: t('Reveal in file manager'),
    system: t('System default application'),
    application: t('Selected application'),
  };
  const blocked = isExternalFileOpenBlocked(`file${extension}`);
  const supported = fileOpenViewer(`file${extension}`) !== null;
  const targets = blocked
    ? ((supported ? ['internal', 'reveal'] : ['reveal']) as Target[])
    : TARGETS;
  const effectiveTarget =
    blocked && (!supported || value === 'system' || value === 'application') ? 'reveal' : value;
  return (
    <Select
      items={Object.fromEntries(targets.map((target) => [target, labels[target]]))}
      value={effectiveTarget}
      disabled={disabled}
      onValueChange={(target) => {
        if (TARGETS.includes(target as Target)) onChange(target as Target);
      }}
    >
      <SelectTrigger className="w-52" aria-label={t('File opening')}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {targets.map((target) => (
          <SelectItem key={target} value={target} disabled={target === 'internal' && !supported}>
            {labels[target]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * 按扩展名编辑打开规则；应用路径只来自系统选择器，候选整组校验失败时保留已保存配置。
 *
 * Edit opening rules by extension; application paths come only from the system picker, and invalid candidate sets preserve saved settings.
 */
export function FileOpeningSettings() {
  const { t } = useI18n();
  const rules = useSettingsStore((state) => state.fileOpenRules);
  const setRules = useSettingsStore((state) => state.setFileOpenRules);
  const [extension, setExtension] = useState('');
  const [target, setTarget] = useState<Target>('internal');
  const [applicationPath, setApplicationPath] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const normalizedExtension = normalizeFileOpenRules([{ extension, target: 'reveal' }])[0]
    ?.extension;

  const fail = (description: string) => {
    addToast({ type: 'error', title: t('File opening'), description });
  };
  const chooseApplication = async (onPick: (path: string) => void) => {
    setBusy(true);
    try {
      const path = await window.electronAPI.dialog.selectFile();
      if (path) {
        if (!isFileOpenApplicationPath(path)) {
          fail(t('The selected application path is invalid.'));
          return;
        }
        onPick(path);
      }
    } catch (cause: unknown) {
      fail(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const commit = (candidate: FileOpenRule[]): boolean => {
    const parsed = parseFileOpenRules(candidate);
    if (!parsed) {
      fail(t('Could not complete the file action.'));
      return false;
    }
    setRules(parsed);
    return true;
  };

  const update = (rule: FileOpenRule, next: Target, path?: string) => {
    if (next === 'internal' && !fileOpenViewer(`file${rule.extension}`)) {
      fail(t('This extension does not support internal preview.'));
      return;
    }
    commit(
      rules.map((item) =>
        item.extension === rule.extension
          ? {
              extension: rule.extension,
              target: next,
              ...(next === 'application' ? { applicationPath: path } : {}),
            }
          : item
      )
    );
  };

  const add = () => {
    if (!normalizedExtension) {
      setError(t('Enter a valid file extension, for example .md.'));
      return;
    }
    if (rules.some((rule) => rule.extension === normalizedExtension)) {
      setError(t('This extension already has an opening rule.'));
      return;
    }
    const blocked = isExternalFileOpenBlocked(`file${normalizedExtension}`);
    const supported = fileOpenViewer(`file${normalizedExtension}`) !== null;
    const nextTarget =
      blocked && (!supported || target === 'system' || target === 'application')
        ? 'reveal'
        : target;
    if (nextTarget === 'internal' && !fileOpenViewer(`file${normalizedExtension}`)) {
      fail(t('This extension does not support internal preview.'));
      return;
    }
    if (nextTarget === 'application' && !applicationPath) {
      setError(t('Choose an application before saving this rule.'));
      return;
    }
    if (
      !commit([
        ...rules,
        {
          extension: normalizedExtension,
          target: nextTarget,
          ...(nextTarget === 'application' ? { applicationPath } : {}),
        },
      ])
    )
      return;
    setExtension('');
    setApplicationPath(undefined);
    setError(null);
  };

  return (
    <section className="space-y-3" data-settings-row="general.fileOpening">
      <div>
        <h4 className="text-sm font-medium">{t('File opening')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('Configure how local workspace file links open by extension.')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            'By default, supported files open inside EnsoCode; other files are revealed in the file manager.'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('Executable and installer files are always revealed in the file manager.')}
        </p>
      </div>
      <ContextMenuOpeningSettings />
      {rules.map((rule) => (
        <div
          key={rule.extension}
          className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
        >
          <span className="w-20 shrink-0 font-mono text-sm">{rule.extension}</span>
          <TargetPicker
            extension={rule.extension}
            value={rule.target}
            disabled={busy}
            onChange={(next) => {
              if (next === 'application') {
                void chooseApplication((path) => update(rule, next, path));
              } else update(rule, next);
            }}
          />
          {rule.target === 'application' && !isExternalFileOpenBlocked(`file${rule.extension}`) && (
            <>
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={rule.applicationPath}
              >
                {rule.applicationPath}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void chooseApplication((path) => update(rule, 'application', path))}
              >
                {t('Choose application')}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => commit(rules.filter((item) => item.extension !== rule.extension))}
          >
            {t('Delete')}
          </Button>
        </div>
      ))}
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-24"
            value={extension}
            placeholder=".md"
            aria-label={t('File extension')}
            disabled={busy}
            onChange={(event) => {
              setExtension(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add();
            }}
          />
          <TargetPicker
            extension={normalizedExtension ?? '.md'}
            value={target}
            disabled={busy}
            onChange={(next) => {
              setTarget(next);
              setError(null);
            }}
          />
          <Button variant="outline" size="sm" disabled={busy} onClick={add}>
            {t('Add')}
          </Button>
        </div>
        {target === 'application' &&
          !isExternalFileOpenBlocked(`file${normalizedExtension ?? '.md'}`) && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void chooseApplication((path) => {
                    setApplicationPath(path);
                    setError(null);
                  })
                }
              >
                {t('Choose application')}
              </Button>
              <span
                className="min-w-0 truncate text-xs text-muted-foreground"
                title={applicationPath}
              >
                {applicationPath}
              </span>
            </div>
          )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
