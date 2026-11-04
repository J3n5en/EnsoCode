import { parsePluginToolName } from '@shared/extensionPlugins/toolName';
import { Component, type ReactNode } from 'react';
import { PluginSlotView } from './loader';
import {
  type PluginSlotEntry,
  pluginBlock,
  pluginComposerSlots,
  pluginMessageActions,
  pluginThinkingBody,
  pluginToolCard,
} from './registry';
import { usePluginSlotsVersion } from './usePluginSlots';

/** 一个插件的一个挂点：出错只隐藏自己，不拖垮输入框或整行消息 */
export class PluginSlotErrorBoundary extends Component<
  { pluginId: string; slot: string; children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(`[plugin] ${this.props.pluginId} 挂点 ${this.props.slot} 渲染失败`, error);
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}

function IsolatedSlot({
  entry,
  props,
  fallback,
}: {
  entry: PluginSlotEntry;
  props: Record<string, unknown>;
  fallback?: ReactNode;
}) {
  return (
    <PluginSlotErrorBoundary pluginId={entry.pluginId} slot={entry.slot} fallback={fallback}>
      <PluginSlotView entry={entry} props={props} />
    </PluginSlotErrorBoundary>
  );
}

export function PluginMessageActions({
  position,
  text,
  messageIndex,
  sessionId,
}: {
  position: 'left' | 'right';
  text: string;
  /** 消息在会话里的绝对下标 */
  messageIndex: number;
  /** 当前展示的会话；远程节点视图为远程会话 id */
  sessionId: string | null;
}) {
  usePluginSlotsVersion();
  const actions = pluginMessageActions(position);
  if (actions.length === 0) return null;
  return (
    <>
      {actions.map((entry) => (
        <IsolatedSlot
          key={`${entry.pluginId}:${entry.uid}`}
          entry={entry}
          props={{ position, text, messageIndex, sessionId }}
        />
      ))}
    </>
  );
}

export function PluginToolCardSlot({
  name,
  output,
  state,
}: {
  name: string;
  output: string | null;
  state: string;
}) {
  usePluginSlotsVersion();
  const parsed = parsePluginToolName(name);
  if (!parsed) return null;
  const entry = pluginToolCard(parsed.pluginId, parsed.toolName);
  if (!entry) return null;
  return <IsolatedSlot entry={entry} props={{ toolName: parsed.toolName, output, state }} />;
}

const THINKING_BODY_CLASS = [
  't-acc-reveal mt-1 ml-[10px] border-l-2 border-border py-0.5 pl-[19px]',
  'text-[13px] leading-relaxed text-muted-foreground whitespace-pre-wrap',
].join(' ');

/** 无插件时保持原来的段落；有插件时换成 div，避免插件根节点不能放进 p */
export function PluginThinkingBody({
  text,
  streaming,
  itemKey,
}: {
  text: string;
  streaming: boolean;
  itemKey: string;
}) {
  usePluginSlotsVersion();
  const entry = pluginThinkingBody();
  if (!entry) return <p className={THINKING_BODY_CLASS}>{text}</p>;
  return (
    <div className={THINKING_BODY_CLASS}>
      <IsolatedSlot
        key={entry.uid}
        entry={entry}
        props={{ text, streaming, itemKey }}
        fallback={text}
      />
    </div>
  );
}

/** 回复正文叶子后的追加内容。不订阅挂点版本，由调用方决定要不要渲染 */
export function PluginMessageLeaf({
  entry,
  source,
  final,
  messageIndex,
  sessionId,
  Markdown,
}: {
  entry: PluginSlotEntry;
  source: string;
  final: boolean;
  messageIndex: number;
  sessionId: string | null;
  Markdown: (props: { text: string }) => unknown;
}) {
  return (
    <IsolatedSlot entry={entry} props={{ source, final, messageIndex, sessionId, Markdown }} />
  );
}

export function PluginBlock({
  pluginId,
  lang,
  source,
}: {
  pluginId: string;
  lang: string;
  source: string;
}) {
  usePluginSlotsVersion();
  const entry = pluginBlock(pluginId, lang);
  if (!entry) return null;
  return <IsolatedSlot entry={entry} props={{ language: lang, source }} />;
}

export function PluginComposerSlots({
  side,
  sessionId,
  draft,
  busy,
  pluginPresetId,
}: {
  side: 'left' | 'right';
  /** 草稿接口能写到的会话；侧栏等隔离输入框为 null */
  sessionId: string | null;
  /** 当前草稿的纯文本（不含文件 / 会话引用） */
  draft: string;
  busy: boolean;
  /** 当前会话生效的插件预设 id；没有则为 null */
  pluginPresetId: string | null;
}) {
  usePluginSlotsVersion();
  const slots = pluginComposerSlots(side);
  if (slots.length === 0) return null;
  return (
    <>
      {slots.map((entry) => (
        <IsolatedSlot
          key={`${entry.pluginId}:${entry.uid}`}
          entry={entry}
          props={{ position: side, sessionId, draft, busy, pluginPresetId }}
        />
      ))}
    </>
  );
}
