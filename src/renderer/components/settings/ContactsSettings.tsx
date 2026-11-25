import { SecretaryContactPanel } from '@/components/secretary/SecretaryContactPanel';
import { useI18n } from '@/i18n';
import { SettingsPage, SettingsSection } from './kit';
import { SettingsSecretaryChips, useSettingsSecretaries } from './SettingsSecretaryPicker';

export function ContactsSettings() {
  const { t } = useI18n();
  const { secretaries, current, multiple, select } = useSettingsSecretaries();
  return (
    <SettingsPage
      rowId="contacts.root"
      title={t('Contacts & owner')}
      description={t(
        'Reach the secretary from your phone. Milestones go out; your replies come back.'
      )}
    >
      {multiple && (
        <div className="mt-4 flex max-w-full flex-wrap items-center gap-1.5">
          <SettingsSecretaryChips secretaries={secretaries} current={current} onSelect={select} />
        </div>
      )}
      <SecretaryContactPanel
        key={current ?? 'single'}
        secretaryId={current}
        frames={{
          owner: (node) => (
            <SettingsSection
              title={t('Owner identity')}
              description={t('GitHub accounts that count as you.')}
              rowId="contacts.owner"
            >
              {node}
            </SettingsSection>
          ),
          channels: (node) => (
            <SettingsSection title={t('Contact channels')} rowId="contacts.channels">
              {node}
            </SettingsSection>
          ),
        }}
      />
    </SettingsPage>
  );
}
