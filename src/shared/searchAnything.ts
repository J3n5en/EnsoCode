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
  limit = SEARCH_ANYTHING_SETTINGS_LIMIT
): SettingsSearchEntry[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const hits: Array<SettingsSearchEntry & { rank: number }> = [];
  for (const entry of entries) {
    const titleHit = fieldMatches(entry.title, tokens);
    const otherHit =
      fieldMatches(entry.id, tokens) || fieldMatches(entry.description ?? '', tokens);
    if (!titleHit && !otherHit) continue;
    hits.push({ ...entry, rank: titleHit ? 0 : 1 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return hits.slice(0, limit).map(({ rank: _rank, ...entry }) => entry);
}

const STATIC_CATALOG: SettingsSearchEntry[] = [
  { id: 'general.language', category: 'general', title: 'Language' },
  {
    id: 'general.windowsLocalShell',
    category: 'general',
    title: 'Windows local command shell',
    description: 'PowerShell or Git Bash for the local Windows agent',
  },
  {
    id: 'general.terminalShell',
    category: 'general',
    title: 'Terminal shell',
    description: 'Shell launched by new side panel terminals',
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
      'Standard, smart compaction (Enso verified summary) or continuous memory (background observations). Falls back to default compact on failure. Takes effect on the next session. Choose Auto/Fast/Balanced/Thorough (budget and tail) and a dedicated summary or background memory model, or follow the session model.',
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
  { id: 'appearance.theme', category: 'appearance', title: 'Theme' },
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
    id: 'tools.bashInterceptEnabled',
    category: 'tools',
    title: 'Force read/find tools',
    description:
      'Block cat/head/grep/sed -i in the shell and require the dedicated file tools. Off by default. Takes effect on the next session.',
  },
  {
    id: 'tools.hashlineEditEnabled',
    category: 'tools',
    title: 'Hashline edit',
    description:
      'Line-anchored read/edit with snapshot tags. Off by default. Takes effect on the next session. oldText replace still works when Force read/find is off.',
  },
  { id: 'skills.root', category: 'skills', title: 'Skills' },
  { id: 'mcp.root', category: 'mcp', title: 'MCP Servers' },
  { id: 'instructions.root', category: 'instructions', title: 'Instruction Files' },
  {
    id: 'phone.root',
    category: 'phone',
    title: 'Devices',
    description: 'Generate a pairing code',
  },
  { id: 'ssh.root', category: 'ssh', title: 'SSH' },
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
