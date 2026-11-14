import type { SecretaryTakeoverView } from '@shared/types/secretary';
import { UserRoundCheck, X } from 'lucide-react';
import { useState } from 'react';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useSecretaryStore } from '@/stores/secretary';
import { useSecretaryName } from './useSecretaryFace';

export function useTakeover(conversationId: string): SecretaryTakeoverView | undefined {
  return useSecretaryStore((state) =>
    state.secretary.takeovers.find((entry) => entry.conversationId === conversationId)
  );
}

/** 侧栏标识：与「由秘书派出」同款，用户一眼知道秘书在管它 */
export function SecretaryTakeoverBadge() {
  const { t } = useI18n();
  const name = useSecretaryName();
  return (
    <span
      data-enso="secretary-takeover"
      className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary group-hover:hidden"
    >
      {t('Managed by {{name}}', { name })}
    </span>
  );
}

/**
 * 会话顶栏：接管中显示标识，点 × 收回。
 * 逐个授权只走秘书提出的确认卡，这里不再给「交给秘书接管」按钮。
 */
export function SecretaryTakeoverControl({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const takeover = useTakeover(conversationId);
  const [busy, setBusy] = useState(false);
  const name = useSecretaryName();

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

  if (!takeover) return null;
  return (
    <span
      data-enso="secretary-takeover-chip"
      className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary/10 pr-0.5 pl-2 text-[11px] text-primary"
      title={t('{{name}} is managing this session: it may message and stop it.', { name })}
    >
      <UserRoundCheck className="size-3.5" />
      {t('Managed by {{name}}', { name })}
      <button
        type="button"
        data-enso="secretary-takeover-revoke"
        disabled={busy}
        aria-label={t('Take back from {{name}}', { name })}
        title={t('Take back from {{name}}', { name })}
        onClick={() => void run(() => window.electronAPI.secretary.revokeTakeover(conversationId))}
        className="flex size-5 items-center justify-center rounded-full hover:bg-primary/15 disabled:opacity-50"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
