import type { RendererAgentEvent } from '@shared/types/agent';

/** 手机在线，或桌面仍有任务在跑（手机切后台后 socket 常会断）。 */
export function shouldHoldPairPowerKeepAlive(
  anyPhoneOnline: boolean,
  runningTaskCount: number
): boolean {
  return anyPhoneOnline || runningTaskCount > 0;
}

export function applyPairPowerTaskEvent(
  runningTaskIds: ReadonlySet<string>,
  event: RendererAgentEvent
): Set<string> {
  const next = new Set(runningTaskIds);
  switch (event.type) {
    case 'status': {
      const id = event.identity.sessionId;
      if (event.status === 'running') next.add(id);
      else next.delete(id);
      return next;
    }
    case 'snapshot': {
      if (!event.partial) next.clear();
      for (const session of event.sessions) {
        const id = session.identity.sessionId;
        if (session.status === 'running') next.add(id);
        else next.delete(id);
      }
      return next;
    }
    case 'worker-exited':
      next.clear();
      return next;
    case 'parent-ended':
    case 'parent-rejected':
    case 'child-ended':
    case 'child-rejected':
      next.delete(event.identity.sessionId);
      return next;
    default:
      return next;
  }
}
