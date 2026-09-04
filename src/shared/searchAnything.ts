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
  { id: 'tools.root', category: 'tools', title: 'Built-in tools' },
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
