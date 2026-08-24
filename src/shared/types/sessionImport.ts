/** 外部应用的会话条目（列表展示用） */
export interface ExternalSession {
  /** 会话文件绝对路径，作为唯一标识 */
  path: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface ExternalSessionSource {
  sourceId: 'claude-code' | 'codex';
  sourceName: string;
  sessions: ExternalSession[];
}

/** 预览与导入用的拉平消息：只保留文本轮次 */
export interface SimpleMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}
