import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/i18n';
import { returnToSecretary, useSecretaryReturn } from '@/stores/secretaryReturn';
import { useSessionsStore } from '@/stores/sessions';

/** 从秘书界面跳进的会话：标题栏给一键回到发起跳转的那条秘书会话 */
export function SecretaryReturnButton({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const back = useSecretaryReturn((state) => state.back);
  const fromAlive = useSessionsStore((state) =>
    back ? Boolean(state.conversations[back.from]) : false
  );
  if (!back || back.to !== conversationId || !fromAlive) return null;
  return (
    <button
      type="button"
      data-enso="secretary-return"
      onClick={returnToSecretary}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      {t('Back to secretary')}
    </button>
  );
}
