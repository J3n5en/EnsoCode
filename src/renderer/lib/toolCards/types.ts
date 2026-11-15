export type ToolCardState = 'running' | 'reviewing' | 'ok' | 'error';

export interface ToolCallInput {
  name: string;
  args: unknown;
  output: string | null;
  state: ToolCardState;
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
  | { kind: 'kv'; rows: { label: string; value: string }[] }
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
  /** 缩略图：src 是 local-image:// URL，宽高只用于占位，实际按 CSS 收边 */
  | { kind: 'image'; src: string; alt?: string; width?: number; height?: number };

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
