export type AgentCommandDispatch = 'post' | 'queue' | 'restart-then-queue';

/** worker 未就绪时的命令去向：冷启动入队，崩过才重建。 */
export function agentCommandDispatch(input: {
  hasWorker: boolean;
  workerReady: boolean;
  workerExited: boolean;
}): AgentCommandDispatch {
  if (input.hasWorker) return input.workerReady ? 'post' : 'queue';
  return input.workerExited ? 'restart-then-queue' : 'queue';
}
