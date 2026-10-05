import { parseAgentTypeRegistrySnapshot } from '@shared/builtinAgents';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';

/** `bot:<id>` 的成员名：先查 bots store，再查 agent 注册表；都没有（如 Bot 模式关闭）回退「成员」 */
export function useMemberName(agentType: string | undefined): string | undefined {
  const { t } = useI18n();
  const botId = agentType?.startsWith('bot:') ? agentType.slice('bot:'.length) : undefined;
  const stored = useBotsStore((s) =>
    botId ? s.bots.find((bot) => bot.id === botId)?.name : undefined
  );
  const [registered, setRegistered] = useState<string | undefined>();

  useEffect(() => {
    setRegistered(undefined);
    if (!agentType || !botId || stored) return;
    let alive = true;
    void window.electronAPI.agentRegistry
      .list()
      .then((value) => {
        const candidate = parseAgentTypeRegistrySnapshot(value)?.candidates.find(
          (item) => item.typeKey === agentType
        );
        if (alive) setRegistered(candidate?.displayName);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentType, botId, stored]);

  if (!botId) return undefined;
  return stored ?? registered ?? t('Member');
}
