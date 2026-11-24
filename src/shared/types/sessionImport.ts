/** 外部应用的会话条目（列表展示用） */
export interface ExternalSession {
  /** Main 扫描时发放的不透明令牌；读取与导入只认它，路径留在 Main */
  token: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export type ExternalSessionSourceId =
  | 'claude-code'
  | 'codex'
  | 'grok'
  | 'cursor'
  | 'pi'
  | 'oh-my-pi'
  | 'factory'
  | 'opencode'
  | 'gemini-cli';

export interface ExternalSessionSource {
  sourceId: ExternalSessionSourceId;
  sourceName: string;
  sessions: ExternalSession[];
}

/** 预览与导入用的拉平消息：只保留文本轮次 */
export interface SimpleMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

/** rescan：令牌未知、过期或文件已不在，需重新扫描；denied：文件已落到允许的根目录之外 */
export type ExternalSessionError = 'rescan' | 'denied';

export type ExternalSessionReadResult =
  | { ok: true; messages: SimpleMessage[] }
  | { ok: false; error: ExternalSessionError };

export type ExternalSessionImportResult =
  | { ok: true; sessionFile: string; title: string; messageCount: number }
  | { ok: false; error: ExternalSessionError | 'empty' };
