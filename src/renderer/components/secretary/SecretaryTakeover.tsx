import type { SecretaryTakeoverView } from '@shared/types/secretary';
import { UserRoundCheck, X } from 'lucide-react';
import { useState } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { canOfferTakeover } from '@/lib/secretaryTakeover';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export function useTakeover(conversationId: string): SecretaryTakeoverView | undefined {
  return useSecretaryStore((state) =>
    state.secretary.takeovers.find((entry) => entry.conversationId === conversationId)
  );
}

/** 侧栏标识：与「由秘书派出」同款，用户一眼知道秘书在管它 */
export function SecretaryTakeoverBadge() {
  const { t } = useI18n();
  return (
    <span
      data-enso="secretary-takeover"
      className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary group-hover:hidden"
    >
      {t('Secretary managing')}
    </span>
  );
}

/** 会话顶栏：未接管时给「交给秘书接管」，接管中显示标识，点 × 收回 */
export function SecretaryTakeoverControl({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const takeover = useTakeover(conversationId);
  const secretary = useSecretaryStore((state) => state.secretary);
  const row = useSessionsStore((state) => state.conversations[conversationId]);
  const projectKind = useSettingsStore(
    (state) => state.projects.find((project) => project.id === row?.projectId)?.kind
  );
  const [busy, setBusy] = useState(false);
  const name = secretary.profile?.name ?? t('Secretary');

  const run = async (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok)
        addToast({ type: 'error', title: t('Takeover failed'), description: result.error });
    } finally {
      setBusy(false);
    }
  };

  if (takeover) {
    return (
      <span
        data-enso="secretary-takeover-chip"
        className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary/10 pr-0.5 pl-2 text-[11px] text-primary"
        title={t('{{name}} is managing this session: it may message and stop it.', { name })}
      >
        <UserRoundCheck className="size-3.5" />
        {t('Secretary managing')}
        <button
          type="button"
          data-enso="secretary-takeover-revoke"
          disabled={busy}
          aria-label={t('Take back from the secretary')}
          title={t('Take back from the secretary')}
          onClick={() =>
            void run(() => window.electronAPI.secretary.revokeTakeover(conversationId))
          }
          className="flex size-5 items-center justify-center rounded-full hover:bg-primary/15 disabled:opacity-50"
        >
          <X className="size-3" />
        </button>
      </span>
    );
  }
  if (!canOfferTakeover(row, projectKind, secretary)) return null;
  return (
    <button
      type="button"
      data-enso="secretary-takeover-grant"
      disabled={busy}
      onClick={() => void run(() => window.electronAPI.secretary.grantTakeover(conversationId))}
      className="flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      aria-label={t('Hand over to the secretary')}
      title={t(
        'Let {{name}} message and stop this session for you. You can take it back any time.',
        {
          name,
        }
      )}
    >
      <UserRoundCheck className="size-3.5" />
      {t('Hand over to the secretary')}
    </button>
  );
}
