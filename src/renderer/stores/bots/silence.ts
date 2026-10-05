import type { BotSilence } from '@shared/types/botIpc';

export const silenceOf = (
  silences: readonly BotSilence[],
  conversationId: string | undefined
): BotSilence | undefined =>
  conversationId ? silences.find((item) => item.conversationId === conversationId) : undefined;

export const quietSeconds = (since: number, now: number): number =>
  Math.max(0, Math.floor((now - since) / 1000));
