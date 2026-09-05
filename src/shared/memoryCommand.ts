export type MemoryCommandAction = 'view' | 'stats' | 'diagnose' | 'clear' | 'enqueue';

export type MemoryCommand = { action: MemoryCommandAction };

const ACTION_ALIASES: Record<string, MemoryCommandAction> = {
  view: 'view',
  stats: 'stats',
  diagnose: 'diagnose',
  clear: 'clear',
  reset: 'clear',
  enqueue: 'enqueue',
  rebuild: 'enqueue',
};

const MEMORY_RE = /^\/memory(?:\s+(\S+))?\s*$/i;

export function parseMemoryCommand(text: string): MemoryCommand | null {
  const match = MEMORY_RE.exec(text.trim());
  if (!match) return null;
  const raw = (match[1] ?? 'view').toLowerCase();
  const action = ACTION_ALIASES[raw];
  return action ? { action } : null;
}
