import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsPage, SettingsRow, SettingsSection, SettingsSwitch } from './kit';

/** 实验功能开关集中在这里；功能自己的设置放各自的分页 */
export function ExperimentalSettings({ onOpenBots }: { onOpenBots: () => void }) {
  const { t } = useI18n();
  const botModeEnabled = useSettingsStore((s) => s.botModeEnabled);
  const setBotModeEnabled = useSettingsStore((s) => s.setBotModeEnabled);
  const scratchSessionsEnabled = useSettingsStore((s) => s.scratchSessionsEnabled);
  const setScratchSessionsEnabled = useSettingsStore((s) => s.setScratchSessionsEnabled);
  const dropShelfEnabled = useSettingsStore((s) => s.dropShelfEnabled);
  const setDropShelfEnabled = useSettingsStore((s) => s.setDropShelfEnabled);
  const secretaryEnabled = useSettingsStore((s) => s.secretaryEnabled);
  const setSecretaryEnabled = useSettingsStore((s) => s.setSecretaryEnabled);
  const isMac = window.electronAPI.env.platform === 'darwin' && !window.electronAPI.remote;
  return (
    <SettingsPage
      rowId="experimental.root"
      title={t('Experimental')}
      description={t('Features still being tested. They may change or be removed.')}
    >
      <SettingsSection>
        <SettingsRow
          rowId="experimental.botMode"
          label={t('Bot mode')}
          description={t(
            'Adds a Code | Bot switch to the sidebar. Create members with their own persona, model and tools, and chat with them alone or in groups.'
          )}
        >
          <SettingsSwitch checked={botModeEnabled} onCheckedChange={setBotModeEnabled} />
        </SettingsRow>
        {botModeEnabled && (
          <div className="px-4 py-2.5 max-sm:px-3">
            <Button variant="outline" size="sm" onClick={onOpenBots}>
              {t('Bot mode settings')}
            </Button>
          </div>
        )}
        <SettingsRow
          rowId="experimental.scratchSessions"
          label={t('Temporary chats')}
          description={t(
            'Chats that are not tied to a project. Tools follow your global settings.'
          )}
        >
          <SettingsSwitch
            checked={scratchSessionsEnabled}
            onCheckedChange={setScratchSessionsEnabled}
          />
        </SettingsRow>
        {isMac && (
          <SettingsRow
            rowId="experimental.dropShelf"
            label={t('Drop shelf')}
            description={t(
              'When you drag files in Finder, a small panel appears at the top right of the screen. Drop them on it to reference them in the current conversation, or drop folders to open them as projects, even when EnsoCode is minimized or in the tray.'
            )}
          >
            <SettingsSwitch checked={dropShelfEnabled} onCheckedChange={setDropShelfEnabled} />
          </SettingsRow>
        )}
        <SettingsRow
          rowId="experimental.secretary"
          label={t('Secretary')}
          description={t(
            'A global agent that watches your projects and sessions, creates sessions to do the work, and reports results back to you.'
          )}
        >
          <SettingsSwitch checked={secretaryEnabled} onCheckedChange={setSecretaryEnabled} />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
