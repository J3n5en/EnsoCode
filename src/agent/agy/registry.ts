import type { AgySession } from './session';

interface Entry {
  key: string;
  session: Promise<AgySession>;
}

const sessions = new Map<string, Entry>();

export function agySessionFor(
  ensoSessionId: string,
  configKey: string,
  open: () => Promise<AgySession>
): Promise<AgySession> {
  const existing = sessions.get(ensoSessionId);
  if (existing?.key === configKey) return existing.session;
  // 换配置先关旧进程再开新的：新进程会 resume 同一个 agy sessionId，两个进程不能同时占着它
  const closed = existing
    ? existing.session.then((session) => session.close()).catch(() => {})
    : Promise.resolve();
  const session = closed.then(open).catch((error: unknown) => {
    if (sessions.get(ensoSessionId)?.session === session) sessions.delete(ensoSessionId);
    throw error;
  });
  sessions.set(ensoSessionId, { key: configKey, session });
  return session;
}

export async function closeAgySession(ensoSessionId: string): Promise<void> {
  const existing = sessions.get(ensoSessionId);
  sessions.delete(ensoSessionId);
  if (!existing) return;
  await existing.session.then((session) => session.close()).catch(() => {});
}

export async function closeAllAgySessions(): Promise<void> {
  const pending = [...sessions.values()];
  sessions.clear();
  await Promise.all(
    pending.map((entry) => entry.session.then((session) => session.close()).catch(() => {}))
  );
}
