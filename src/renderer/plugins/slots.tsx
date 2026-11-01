import { parsePluginToolName } from '@shared/extensionPlugins/toolName';
import { PluginSlotView } from './loader';
import { pluginBlock, pluginComposerSlots, pluginMessageActions, pluginToolCard } from './registry';
import { usePluginSlotsVersion } from './usePluginSlots';

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
        <PluginSlotView
          key={`${entry.pluginId}:${position}`}
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
  return <PluginSlotView entry={entry} props={{ toolName: parsed.toolName, output, state }} />;
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
  return <PluginSlotView entry={entry} props={{ language: lang, source }} />;
}

export function PluginComposerSlots({
  side,
  sessionId,
  draft,
  busy,
}: {
  side: 'left' | 'right';
  /** 草稿接口能写到的会话；侧栏等隔离输入框为 null */
  sessionId: string | null;
  /** 当前草稿的纯文本（不含文件 / 会话引用） */
  draft: string;
  busy: boolean;
}) {
  usePluginSlotsVersion();
  const slots = pluginComposerSlots(side);
  if (slots.length === 0) return null;
  return (
    <>
      {slots.map((entry) => (
        <PluginSlotView
          key={`${entry.pluginId}:${side}`}
          entry={entry}
          props={{ position: side, sessionId, draft, busy }}
        />
      ))}
    </>
  );
}
