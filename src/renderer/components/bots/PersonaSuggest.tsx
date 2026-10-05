import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { suggestErrorText } from './BotAbilities';

interface PersonaFields {
  name: string;
  title: string;
  scope: string;
  persona: string;
}

/** 按名称与头衔让模型写人设，职责为空时顺带补上；直接填进表单，可撤销，仍需保存 / 创建 */
export function PersonaSuggestButton({
  value,
  onApply,
}: {
  value: PersonaFields;
  onApply: (next: Partial<Pick<PersonaFields, 'scope' | 'persona'>>) => void;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!value.name.trim() || !value.title.trim()) {
      addToast({ type: 'warning', title: t('Fill in a name and title first.') });
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.bots.suggestPersona({
        name: value.name,
        title: value.title,
        scope: value.scope,
        persona: value.persona,
        language: locale === 'zh' ? 'zh' : 'en',
      });
      if (!result.ok) {
        addToast({
          type: 'error',
          title: suggestErrorText(result, t),
          ...(result.detail ? { description: result.detail } : {}),
        });
        return;
      }
      const { persona, scope } = result.suggestion;
      const previous = { persona: value.persona, scope: value.scope };
      onApply({ persona, ...(scope ? { scope } : {}) });
      addToast({
        type: 'success',
        title: scope ? t('Persona and responsibilities generated') : t('Persona generated'),
        timeout: 10_000,
        actions: [{ label: t('Undo'), onClick: () => onApply(previous) }],
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="xs"
      variant="ghost"
      className="-my-1 h-6 text-muted-foreground"
      disabled={busy}
      onClick={() => void run()}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
      {t('Generate with AI')}
    </Button>
  );
}
