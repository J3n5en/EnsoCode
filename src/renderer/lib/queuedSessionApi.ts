import type { AttachedImage } from '@shared/types/agent';

type Result = { ok: true } | { ok: false; error: string };
type FollowUp = { text: string; images?: AttachedImage[] };

interface QueueApi {
  startQueued(conversationId: string, followUp?: FollowUp): Promise<Result>;
  cancelQueued(conversationId: string): Promise<Result>;
}

function api(): Partial<QueueApi> {
  return window.electronAPI.secretary as Partial<QueueApi>;
}

export function startQueuedSession(conversationId: string, followUp?: FollowUp): Promise<Result> {
  const start = api().startQueued;
  if (!start) return Promise.resolve({ ok: false, error: 'Queued start is unavailable' });
  return start(conversationId, followUp);
}

export function cancelQueuedSession(conversationId: string): Promise<Result> {
  const cancel = api().cancelQueued;
  if (!cancel) return Promise.resolve({ ok: false, error: 'Queued start is unavailable' });
  return cancel(conversationId);
}
