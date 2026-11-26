import { GraduationCap } from 'lucide-react';
import { useI18n } from '@/i18n';
import { addSidePanelLearn } from '@/lib/sidePanelDock';

/**
 * composer 工具行的「复盘」按钮：开一个 learn 模式的 btw 旁路，
 * 从主会话分叉消息序列，由独立复盘者旁观复盘，提案经用户批准后沉淀。
 */
export function LearnButton({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      title={t('Review this session in a side conversation and distill lessons')}
      onClick={() => addSidePanelLearn(conversationId, { title: t('Learn') })}
      className="flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-md:h-[32px] max-md:min-w-[32px] max-md:justify-center"
    >
      <GraduationCap className="h-3 w-3 shrink-0" />
      <span className="hidden @min-[28rem]:inline">{t('Learn')}</span>
    </button>
  );
}
