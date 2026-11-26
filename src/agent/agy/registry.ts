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
  if (existing) void existing.session.then((session) => session.close()).catch(() => {});
  const session = open().catch((error: unknown) => {
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
