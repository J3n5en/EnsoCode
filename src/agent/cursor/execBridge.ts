/** Cursor 执行帧 → 本会话本地工具。与传输无关，测试用合成帧驱动。 */

export interface CursorBridgeTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<{
    content: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

export type CursorExecFrame =
  | { type: 'read'; toolCallId?: string; path: string; offset?: number; limit?: number }
  | { type: 'ls'; toolCallId?: string; path: string }
  | { type: 'write'; toolCallId?: string; path: string; content: string }
  | { type: 'edit'; toolCallId?: string; path: string; oldText: string; newText: string }
  | { type: 'grep'; toolCallId?: string; pattern: string; path?: string; glob?: string }
  | { type: 'shell'; toolCallId?: string; command: string; cwd?: string; timeout?: number };

export interface CursorExecEvent {
  type: 'toolCall' | 'toolResult';
  toolCallId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface CursorExecDispatchResult {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean;
  events: CursorExecEvent[];
}

const FRAME_TOOL: Record<CursorExecFrame['type'], string> = {
  read: 'read',
  ls: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'grep',
  shell: 'bash',
};

export function frameToToolArgs(frame: CursorExecFrame): Record<string, unknown> {
  switch (frame.type) {
    case 'read':
      return omitUndefined({
        path: composeReadPath(frame.path, frame.offset, frame.limit),
      });
    case 'ls':
      return { path: frame.path };
    case 'write':
      return { path: frame.path, content: frame.content };
    case 'edit':
      return { path: frame.path, old_string: frame.oldText, new_string: frame.newText };
    case 'grep': {
      const searchPath = frame.glob ? `${frame.path || '.'}/${frame.glob}` : frame.path || '.';
      return omitUndefined({ pattern: frame.pattern, path: searchPath });
    }
    case 'shell':
      return omitUndefined({
        command: frame.command,
        cwd: frame.cwd,
        timeout: frame.timeout,
      });
  }
}

/** 把 Cursor exec 帧派到本会话已注入的本地工具，并合成会话可见的 toolCall/toolResult。 */
export async function dispatchCursorExec(
  frame: CursorExecFrame,
  tools: Map<string, CursorBridgeTool>,
  signal?: AbortSignal
): Promise<CursorExecDispatchResult> {
  const toolName = FRAME_TOOL[frame.type];
  const toolCallId = frame.toolCallId?.trim() || crypto.randomUUID();
  const args = frameToToolArgs(frame);
  const toolCall: CursorExecEvent = { type: 'toolCall', toolCallId, toolName, arguments: args };

  const tool = tools.get(toolName) ?? tools.get(frame.type);
  if (!tool) {
    const resultText = `Tool "${toolName}" not available`;
    return {
      toolCallId,
      toolName,
      args,
      resultText,
      isError: true,
      events: [toolCall, resultEvent(toolCallId, toolName, resultText, true)],
    };
  }

  let resultText = '';
  let isError = false;
  try {
    const result = await tool.execute(toolCallId, args, signal);
    resultText = textOf(result.content);
    isError = result.isError === true;
  } catch (error) {
    resultText = error instanceof Error ? error.message : String(error);
    isError = true;
  }

  return {
    toolCallId,
    toolName,
    args,
    resultText,
    isError,
    events: [toolCall, resultEvent(toolCallId, toolName, resultText, isError)],
  };
}

function resultEvent(
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean
): CursorExecEvent {
  return {
    type: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
  };
}

function textOf(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((part) => part.type === 'text' || part.text)
    .map((part) => part.text ?? '')
    .join('');
}

function composeReadPath(path: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return path;
  const start = offset ?? 1;
  const span = limit ?? 0;
  if (limit === 0) return path;
  return `${path}:${start}${span ? `+${span}` : ''}`;
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
