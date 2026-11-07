export interface InterruptedConversation {
  started?: boolean;
  spawning?: boolean;
  status?: string;
  archived?: boolean;
}

export interface ResumeInterruptedDeps {
  conversation(id: string): InterruptedConversation | undefined;
  resume(id: string): Promise<void>;
  /** 只续跑未完成的回合：最后一条 assistant 已正常完成时 worker 回执 nothing-to-retry */
  retry(id: string): Promise<{ ok: boolean }>;
  waitUntil(check: () => boolean): Promise<boolean>;
}

/** 更新重启打断的会话：唤醒后从断点续跑，返回已发出续跑的 id */
export async function resumeInterruptedSessions(
  ids: readonly string[],
  deps: ResumeInterruptedDeps
): Promise<string[]> {
  const resumed: string[] = [];
  for (const id of ids) {
    const initial = deps.conversation(id);
    if (!initial || initial.archived) continue;
    if (!initial.started && !initial.spawning) await deps.resume(id);
    const ready = await deps.waitUntil(() => {
      const current = deps.conversation(id);
      return Boolean(current?.started && !current.spawning);
    });
    if (!ready || deps.conversation(id)?.status === 'running') continue;
    if ((await deps.retry(id)).ok) resumed.push(id);
  }
  return resumed;
}
