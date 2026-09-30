export const SEARCH_ANYTHING_BROWSER_LIMIT = 20;
export const SEARCH_ANYTHING_SETTINGS_LIMIT = 20;
export const SEARCH_ANYTHING_RECENT_BROWSER = 5;

export interface BrowserSearchTab {
  tabId: string;
  conversationId: string;
  title: string;
  url: string;
  at: number;
  live: boolean;
}

export interface SettingsSearchEntry {
  id: string;
  category: string;
  title: string;
  description?: string;
}

export interface SettingsCatalogSnapshot {
  providers?: Array<{ id: string; name: string }>;
  skills?: Array<{ id: string; name: string }>;
  mcpServers?: Array<{ id: string; name: string }>;
  instructions?: Array<{ id: string; name: string }>;
  sshConnections?: Array<{ id: string; name: string }>;
}

const TOKEN_RE = /[\p{Letter}\p{Number}]+/gu;
const CJK_RE = /[\u3400-\u9fff]/u;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

function isCjkToken(token: string): boolean {
  return CJK_RE.test(token);
}

function fieldMatches(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const lower = text.toLowerCase();
  const textTokens = tokenize(text);
  return tokens.every((token) =>
    isCjkToken(token) ? lower.includes(token) : textTokens.some((part) => part.startsWith(token))
  );
}

export function mergeBrowserSearchTabs(
  live: BrowserSearchTab[],
  persisted: Array<{
    tabId: string;
    conversationId: string;
    title: string;
    url: string;
    at?: number;
  }>
): BrowserSearchTab[] {
  const byId = new Map<string, BrowserSearchTab>();
  for (const tab of live) byId.set(tab.tabId, tab);
  for (const tab of persisted) {
    if (!tab.url) continue;
    if (byId.has(tab.tabId)) continue;
    byId.set(tab.tabId, {
      tabId: tab.tabId,
      conversationId: tab.conversationId,
      title: tab.title,
      url: tab.url,
      at: tab.at ?? 0,
      live: false,
    });
  }
  return [...byId.values()];
}

export function recentBrowserTabs(
  tabs: BrowserSearchTab[],
  limit = SEARCH_ANYTHING_RECENT_BROWSER
): BrowserSearchTab[] {
  return [...tabs].sort((a, b) => b.at - a.at).slice(0, limit);
}

export function searchBrowserTabs(
  tabs: BrowserSearchTab[],
  query: string,
  limit = SEARCH_ANYTHING_BROWSER_LIMIT
): BrowserSearchTab[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const hits: Array<BrowserSearchTab & { rank: number }> = [];
  for (const tab of tabs) {
    const titleHit = fieldMatches(tab.title, tokens);
    const urlHit = fieldMatches(tab.url, tokens);
    if (!titleHit && !urlHit) continue;
    hits.push({ ...tab, rank: titleHit ? 0 : 1 });
  }
  hits.sort((a, b) => a.rank - b.rank || b.at - a.at);
  return hits.slice(0, limit).map(({ rank: _rank, ...tab }) => tab);
}

export function searchSettingsEntries(
  entries: SettingsSearchEntry[],
  query: string,
  options: { translate?: (text: string) => string; limit?: number } = {}
): SettingsSearchEntry[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  // 界面显示的是译文，原文与译文都参与匹配
  const matches = (text = '') =>
    fieldMatches(text, tokens) ||
    (!!options.translate && fieldMatches(options.translate(text), tokens));
  const hits: Array<SettingsSearchEntry & { rank: number }> = [];
  for (const entry of entries) {
    const titleHit = matches(entry.title);
    const otherHit = fieldMatches(entry.id, tokens) || matches(entry.description);
    if (!titleHit && !otherHit) continue;
    hits.push({ ...entry, rank: titleHit ? 0 : 1 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return hits
    .slice(0, options.limit ?? SEARCH_ANYTHING_SETTINGS_LIMIT)
    .map(({ rank: _rank, ...entry }) => entry);
}

const STATIC_CATALOG: SettingsSearchEntry[] = [
  { id: 'general.language', category: 'general', title: 'Language' },
  {
    id: 'general.windowsLocalShell',
    category: 'general',
    title: 'Windows local command shell',
    description:
      'Only the Windows local agent command tool. SSH and other platforms stay on bash. Takes effect on the next session.',
  },
  {
    id: 'general.terminalShell',
    category: 'general',
    title: 'Terminal shell',
    description: 'Applies to new side panel terminals. SSH projects keep the remote login shell.',
  },
  {
    id: 'general.openChangesOnFileEdit',
    category: 'general',
    title: 'Open Changes when files are edited',
  },
  {
    id: 'general.compactReadOnlyTools',
    category: 'general',
    title: 'Compact read-only tool calls',
  },
  {
    id: 'general.expandLiveEdits',
    category: 'general',
    title: 'Expand file edits while running',
  },
  {
    id: 'general.expandLiveReasoning',
    category: 'general',
    title: 'Expand reasoning while streaming',
  },
  {
    id: 'general.autoCollapseTurns',
    category: 'general',
    title: 'Auto-collapse previous turns',
  },
  {
    id: 'general.collapseCompletedActivity',
    category: 'general',
    title: 'Collapse activity after reply',
  },
  {
    id: 'general.pinUnfinishedTodos',
    category: 'general',
    title: 'Pin unfinished todos',
  },
  {
    id: 'general.notifyMainAgentOnly',
    category: 'general',
    title: 'Notify only for the main agent',
    description:
      'Skip coworker completion and failure notifications on this computer and the paired phone. Questions and approvals still notify.',
  },
  {
    id: 'general.smartCompactEnabled',
    category: 'general',
    title: 'Context compaction strategy',
    description:
      'Standard uses default compact. Smart compaction uses Enso verified summary at compact time. Codex native compaction additionally stores an official Codex checkpoint on Codex models and uses smart compaction otherwise. Continuous memory records observations in the background so compact keeps more context; all fall back to default compact on failure and take effect on the next session.',
  },
  {
    id: 'general.generationStallTimeout',
    category: 'general',
    title: 'Stop if no output',
  },
  {
    id: 'general.proxy',
    category: 'general',
    title: 'Network proxy',
    description: 'Used by model requests, the built-in browser, and agent tools',
  },
  { id: 'general.updates', category: 'general', title: 'Updates' },
  { id: 'shortcuts.root', category: 'shortcuts', title: 'Shortcuts' },
  { id: 'appearance.theme', category: 'appearance', title: 'Theme mode' },
  { id: 'providers.root', category: 'providers', title: 'Model Providers' },
  { id: 'presets.root', category: 'presets', title: 'Presets' },
  { id: 'agents.root', category: 'agents', title: 'Agent types' },
  {
    id: 'agents.maxActiveCoworkers',
    category: 'agents',
    title: 'Max active coworkers',
    description:
      'How many coworkers one conversation can keep at once. Existing ones stay if you lower the limit; hire more only after dismissing. Subagents are not counted.',
  },
  { id: 'tools.root', category: 'tools', title: 'Built-in tools' },
  {
    id: 'tools.rtkEnabled',
    category: 'tools',
    title: 'RTK command compression',
    description:
      'Compress supported command output before it enters the model context. Takes effect on new conversations.',
  },
  {
    id: 'voice.root',
    category: 'voice',
    title: 'Voice input',
    description:
      'Adds a microphone to the composer on this computer and on paired phones. Local models transcribe speech on this computer.',
  },
  {
    id: 'tools.editMode',
    category: 'tools',
    title: 'File edit mode',
    description:
      'Choose how files are modified. Apply patch is the default. New and cold-restored sessions use this mode; already warm sessions keep their current mode.',
  },
  { id: 'skills.root', category: 'skills', title: 'Skills' },
  { id: 'mcp.root', category: 'mcp', title: 'MCP Servers' },
  { id: 'instructions.root', category: 'instructions', title: 'Instruction Files' },
  {
    id: 'phone.root',
    category: 'phone',
    title: 'Devices',
    description: 'Generate a pairing code to let a phone or another desktop connect.',
  },
  { id: 'ssh.root', category: 'ssh', title: 'SSH' },
  {
    id: 'ssh.timeout',
    category: 'ssh',
    title: 'SSH timeout',
    description:
      'Time limit for connection tests, loading remote AGENTS.md, remote folder browsing and file panel actions. Agent tool commands are not affected.',
  },
];

function named(
  prefix: string,
  category: string,
  items: Array<{ id: string; name: string }> | undefined
): SettingsSearchEntry[] {
  return (items ?? []).map((item) => ({
    id: `${prefix}.${item.id}`,
    category,
    title: item.name,
  }));
}

export function buildSettingsCatalog(snapshot?: SettingsCatalogSnapshot): SettingsSearchEntry[] {
  return [
    ...STATIC_CATALOG,
    ...named('providers', 'providers', snapshot?.providers),
    ...named('skills', 'skills', snapshot?.skills),
    ...named('mcp', 'mcp', snapshot?.mcpServers),
    ...named('instructions', 'instructions', snapshot?.instructions),
    ...named('ssh', 'ssh', snapshot?.sshConnections),
  ];
}
