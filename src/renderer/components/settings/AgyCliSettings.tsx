import { parseAgyAuthStatus } from '@shared/agy/catalog';
import { parseAgySettings } from '@shared/agy/settings';
import type { AgyAuthStatus } from '@shared/agy/types';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { useAgyAuthStore } from '@/stores/agyAuth';
import { useSettingsStore } from '@/stores/settings';
import { SettingsInput, SettingsRow, SettingsSubRow, SettingsSwitch } from './kit';

function statusText(status: AgyAuthStatus, t: (key: string) => string): string {
  switch (status.status) {
    case 'signed-in':
      return t('Signed in');
    case 'signed-out':
      return t('Not signed in');
    case 'not-installed':
      return t('agy is not installed');
    case 'too-old':
      return t('agy is older than 1.5.1');
    default:
      return t('Status unknown');
  }
}

export function AgyCliSettings() {
  const { t } = useI18n();
  const agy = useSettingsStore((state) => state.agy);
  const setAgy = useSettingsStore((state) => state.setAgy);
  const status = useAgyAuthStore((state) => state.status);
  const setStatus = useAgyAuthStore((state) => state.setStatus);
  const [checking, setChecking] = React.useState(false);

  const detect = React.useCallback(
    async (refresh: boolean) => {
      setChecking(true);
      try {
        if (!window.electronAPI?.agy) return;
        setStatus(parseAgyAuthStatus(await window.electronAPI.agy.authStatus(refresh)));
      } finally {
        setChecking(false);
      }
    },
    [setStatus]
  );

  React.useEffect(() => {
    void detect(false);
  }, [detect]);

  const settings = parseAgySettings(agy);
  return (
    <SettingsRow
      rowId="providers.agy-cli"
      label={t('agy cli (experimental)')}
      description={t(
        'Runs sessions through the local agy acp command. EnsoCode does not sign in for you.'
      )}
    >
      <div className="flex w-full max-w-xl flex-col gap-2">
        <SettingsSubRow
          rowId="providers.agy-binary-path"
          label={t('Binary path')}
          description={t('Leave empty to find agy on PATH or in ~/.local/bin.')}
        >
          <SettingsInput
            value={settings.binaryPath}
            placeholder="agy"
            onCommit={(binaryPath) => setAgy({ ...settings, binaryPath })}
          />
        </SettingsSubRow>
        <SettingsSubRow
          rowId="providers.agy-skip-permissions"
          label={t('Skip permissions')}
          description={t(
            'Passes --dangerously-skip-permissions. agy will not ask before commands or edits.'
          )}
        >
          <SettingsSwitch
            checked={settings.skipPermissions}
            onCheckedChange={(skipPermissions) => setAgy({ ...settings, skipPermissions })}
          />
        </SettingsSubRow>
        <div className="flex items-center gap-2 text-xs">
          <span>{statusText(status, t)}</span>
          {status.status === 'signed-in' ? <span>{status.version}</span> : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={() => void detect(true)}
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('Detect again')}
          </Button>
        </div>
        {status.status === 'signed-out' || status.status === 'not-installed' ? (
          <p className="text-xs text-muted-foreground">
            {t('Run agy in a terminal to sign in, then detect again.')}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
