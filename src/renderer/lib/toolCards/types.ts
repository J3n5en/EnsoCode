import type { ToolImage } from '@/lib/toolImage';

export type ToolCardState = 'running' | 'reviewing' | 'ok' | 'error';

export interface ToolCallInput {
  name: string;
  args: unknown;
  output: string | null;
  state: ToolCardState;
  /** 结果里的图片块（image_view）；其它缺省 */
  image?: ToolImage;
}

export interface ToolCardLookup {
  sessionTitle?: (id: string) => string | undefined;
  projectName?: (id: string) => string | undefined;
  todoText?: (id: string) => string | undefined;
  proposal?: (id: string) => { status?: string; kind?: string } | undefined;
}

export interface ToolCardContext {
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: 'zh' | 'en';
  lookup?: ToolCardLookup;
}

export type ToolCardStatus = {
  tone: 'ok' | 'queued' | 'pending' | 'error' | 'neutral';
  label: string;
};

export type ToolCardBlock =
  | { kind: 'markdown' | 'note' | 'error'; text: string; collapsed?: boolean }
  /** 派活指令与发给会话的消息：自带小标题，默认折叠，展开后在框内滚动 */
  | { kind: 'prompt'; label: string; text: string }
  /** display：path 单行截断、悬停看全文；long 默认截断、可展开 */
  | { kind: 'kv'; rows: { label: string; value: string; display?: 'path' | 'long' }[] }
  | { kind: 'diff'; rows: { label: string; before: string; after: string }[] }
  | {
      kind: 'list';
      items: {
        title: string;
        badge?: string;
        badgeTone?: ToolCardStatus['tone'];
        detail?: string;
        sessionId?: string;
      }[];
    }
  | { kind: 'session'; id: string; label: string }
  /** 缩略图：优先用结果里的图片字节，没有时才用工具回报的路径；展开时才解码 */
  | { kind: 'image'; image?: ToolImage; path?: string; alt?: string };

export interface ToolCardView {
  name: string;
  title: string;
  state: ToolCardState;
  status?: ToolCardStatus;
  blocks: ToolCardBlock[];
  rawArgs: string;
  rawOutput: string;
}

export interface ToolCardPresentation {
  grouped: boolean;
  title: string;
  cards: ToolCardView[];
}
