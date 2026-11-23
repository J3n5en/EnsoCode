// 断点的纯类型：shared/types 会被插件类型声明带进没有 node 类型的环境，这里不能 import node 模块
export type RestartNextStep = 'model-request' | 'await-user';
/** session-starting：会话还在打开（spawn 没落定），落断点要等它，否则新进程里没有它 */
export type RestartDeferReason = 'tool-in-flight' | 'turn-in-progress' | 'session-starting';

export interface RestartCheckpointEntry {
  sessionId: string;
  generation: string;
  sessionFile: string;
  /** 旧进程最后一个事件序号：新进程从这里接着编号 */
  seq: number;
  nextStep: RestartNextStep;
  /** nextStep=model-request 时是被挂起的那一轮；await-user 为 null */
  turnId: string | null;
  lastCompletedToolCallId: string | null;
  /** 落盘时上下文里的消息条数 */
  messageCount: number;
  toolsInFlight: string[];
}

export interface RestartCheckpoint {
  version: 1;
  pid: number;
  writtenAt: number;
  sessions: RestartCheckpointEntry[];
}
