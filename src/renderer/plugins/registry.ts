export type PluginSlotName =
  | 'message.action'
  | 'tool.card'
  | 'block'
  | 'composer.left'
  | 'composer.right';

export type PluginSlotComponent = (props: Record<string, unknown>) => unknown;

export interface PluginSlotEntry {
  pluginId: string;
  slot: PluginSlotName;
  component: PluginSlotComponent;
  position?: 'left' | 'right';
  toolName?: string;
  language?: string;
}

const SLOTS = new Set<PluginSlotName>([
  'message.action',
  'tool.card',
  'block',
  'composer.left',
  'composer.right',
]);

let entries: PluginSlotEntry[] = [];
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function pluginSlotsVersion(): number {
  return version;
}

export function subscribePluginSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerPluginSlot(entry: PluginSlotEntry): () => void {
  if (!SLOTS.has(entry.slot)) throw new Error(`未知挂点 ${entry.slot}`);
  if (entry.slot === 'message.action' && entry.position !== 'left' && entry.position !== 'right')
    throw new Error('message.action 需要 position');
  if (entry.slot === 'tool.card' && !entry.toolName) throw new Error('tool.card 需要 toolName');
  if (entry.slot === 'block' && !entry.language) throw new Error('block 需要 language');
  if (typeof entry.component !== 'function') throw new Error('挂点需要组件函数');
  const stored: PluginSlotEntry = {
    ...entry,
    ...(entry.language ? { language: entry.language.toLowerCase() } : {}),
  };
  entries.push(stored);
  bump();
  return () => {
    const next = entries.filter((item) => item !== stored);
    if (next.length !== entries.length) {
      entries = next;
      bump();
    }
  };
}

export function clearPluginSlots(pluginId: string): void {
  const next = entries.filter((item) => item.pluginId !== pluginId);
  if (next.length !== entries.length) {
    entries = next;
    bump();
  }
}

export function resetPluginSlots(): void {
  entries = [];
  bump();
}

export function pluginMessageActions(position: 'left' | 'right'): PluginSlotEntry[] {
  return entries.filter((item) => item.slot === 'message.action' && item.position === position);
}

export function pluginComposerSlots(side: 'left' | 'right'): PluginSlotEntry[] {
  const slot = side === 'left' ? 'composer.left' : 'composer.right';
  return entries.filter((item) => item.slot === slot);
}

export function pluginToolCard(pluginId: string, toolName: string): PluginSlotEntry | undefined {
  return entries.find(
    (item) => item.slot === 'tool.card' && item.pluginId === pluginId && item.toolName === toolName
  );
}

export function pluginBlock(pluginId: string, language: string): PluginSlotEntry | undefined {
  const lang = language.toLowerCase();
  return entries.find(
    (item) => item.slot === 'block' && item.pluginId === pluginId && item.language === lang
  );
}

const FENCE_ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

/** 代码块语言标记 `<pluginId>:<lang>`；不是插件标记时返回 null */
export function parsePluginFence(
  language: string | undefined
): { pluginId: string; lang: string } | null {
  if (!language) return null;
  const index = language.indexOf(':');
  if (index <= 0) return null;
  const pluginId = language.slice(0, index);
  const lang = language.slice(index + 1);
  if (!FENCE_ID.test(pluginId) || lang.length === 0) return null;
  return { pluginId, lang };
}
