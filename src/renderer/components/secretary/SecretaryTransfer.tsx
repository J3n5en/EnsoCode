import { ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';

const DEFAULT_SECRETARY_ID = 'default';

const TRANSFER_ERRORS: Record<string, string> = {
  'not-visible': 'The other secretary cannot see this project.',
  'no-secretary-conversation': 'The other secretary has no conversation yet: open it once first.',
  'not-managed': 'No secretary manages this session.',
};

/** 管理这个会话的秘书：先看各秘书的接管，再看会话上的派出归属（旧数据没有 id，就是 default） */
export function useManagingSecretary(conversationId: string): string | null {
  const origin = useSessionsStore((state) => state.conversations[conversationId]?.secretaryOrigin);
  return useSecretaryStore((state) => {
    for (const [id, secretary] of Object.entries(state.states)) {
      if (secretary.takeovers.some((entry) => entry.conversationId === conversationId)) return id;
    }
    if (!origin) return null;
    const id = origin.secretaryId ?? DEFAULT_SECRETARY_ID;
    return state.secretaries.some((entry) => entry.id === id) ? id : null;
  });
}

/** 会话顶栏：有多个秘书且这个会话归其中一个管时，可以转交给另一个秘书 */
export function SecretaryTransferControl({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const manager = useManagingSecretary(conversationId);
  const secretaries = useSecretaryStore((state) => state.secretaries);
  const states = useSecretaryStore((state) => state.states);
  const [busy, setBusy] = useState(false);

  const targets = secretaries.filter((entry) => entry.id !== manager);
  if (!manager || targets.length === 0) return null;
  const nameOf = (id: string) =>
    states[id]?.profile?.name ?? secretaries.find((entry) => entry.id === id)?.name ?? id;

  const transfer = async (toSecretaryId: string) => {
    setBusy(true);
    try {
      const result = await window.electronAPI.secretary.transfer(conversationId, toSecretaryId);
      if (result.ok) {
        addToast({
          type: 'success',
          title: t('Transferred to {{name}}', { name: nameOf(toSecretaryId) }),
        });
      } else {
        const known = TRANSFER_ERRORS[result.error];
        addToast({
          type: 'error',
          title: t('Transfer failed'),
          description: known ? t(known) : result.error,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu>
      <MenuTrigger
        data-enso="secretary-transfer"
        disabled={busy}
        aria-label={t('Transfer to…')}
        title={t('Transfer to…')}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50 data-popup-open:bg-muted"
      >
        <ArrowRightLeft className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {targets.map((entry) => (
          <MenuItem
            key={entry.id}
            data-enso="secretary-transfer-target"
            data-secretary={entry.id}
            onClick={() => void transfer(entry.id)}
          >
            {t('Transfer to {{name}}', { name: nameOf(entry.id) })}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
