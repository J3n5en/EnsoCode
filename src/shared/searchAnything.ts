import { getTranslation } from './i18n';
import { GENERATED_SETTINGS_CATALOG } from './settingsCatalog.generated';

export const SEARCH_ANYTHING_BROWSER_LIMIT = 20;
export const SEARCH_ANYTHING_SETTINGS_LIMIT = 20;
export const SEARCH_ANYTHING_PROJECTS_LIMIT = 20;
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

export interface ProjectSearchEntry {
  id: string;
  name: string;
  path: string;
  alias?: string;
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

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** 原文、中文译文、当前界面译文。英文界面也能用中文命中。 */
function textVariants(text: string, translate?: (text: string) => string): string[] {
  const values = [text];
  const zh = getTranslation('zh', text);
  if (zh !== text) values.push(zh);
  if (translate) {
    const translated = translate(text);
    if (!values.includes(translated)) values.push(translated);
  }
  return values;
}

function matchesAny(texts: string[], tokens: string[]): boolean {
  return texts.some((text) => fieldMatches(text, tokens));
}

function wordPrefix(title: string, token: string): boolean {
  if (isCjkToken(token)) return false;
  return tokenize(title).some((part) => part.startsWith(token));
}

/** 0 整句相等，1 开头或词前缀，2 子串，3 标题里没有这个词 */
function tokenTitleRank(token: string, titles: string[]): number {
  let best = 3;
  const needle = normalize(token);
  for (const title of titles) {
    const norm = normalize(title);
    if (norm === needle) best = Math.min(best, 0);
    else if (norm.startsWith(needle) || wordPrefix(title, needle)) best = Math.min(best, 1);
    else if (norm.includes(needle)) best = Math.min(best, 2);
  }
  return best;
}

function settingsHitRank(
  entry: SettingsSearchEntry,
  query: string,
  translate?: (text: string) => string
): number {
  const titles = textVariants(entry.title, translate);
  if (titles.some((title) => normalize(title) === normalize(query))) return 0;
  const tokens = tokenize(query);
  let worst = 0;
  for (const token of tokens) worst = Math.max(worst, tokenTitleRank(token, titles));
  const queryNorm = normalize(query);
  if (titles.some((title) => normalize(title).startsWith(queryNorm))) return Math.min(worst, 1);
  return worst;
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

export function searchProjectEntries(
  entries: readonly ProjectSearchEntry[],
  query: string,
  options: { limit?: number } = {}
): ProjectSearchEntry[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const hits: Array<ProjectSearchEntry & { rank: number }> = [];
  for (const entry of entries) {
    const nameHit = fieldMatches(entry.name, tokens) || fieldMatches(entry.alias ?? '', tokens);
    const pathHit = fieldMatches(entry.path, tokens);
    if (!nameHit && !pathHit) continue;
    hits.push({ ...entry, rank: nameHit ? 0 : 1 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return hits
    .slice(0, options.limit ?? SEARCH_ANYTHING_PROJECTS_LIMIT)
    .map(({ rank: _rank, ...entry }) => entry);
}

export function searchSettingsEntries(
  entries: SettingsSearchEntry[],
  query: string,
  options: { translate?: (text: string) => string; limit?: number } = {}
): SettingsSearchEntry[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const hits: Array<SettingsSearchEntry & { rank: number }> = [];
  for (const entry of entries) {
    const titles = textVariants(entry.title, options.translate);
    const descriptions = textVariants(entry.description ?? '', options.translate);
    const titleHit = matchesAny(titles, tokens);
    const otherHit = fieldMatches(entry.id, tokens) || matchesAny(descriptions, tokens);
    if (!titleHit && !otherHit) continue;
    hits.push({ ...entry, rank: settingsHitRank(entry, query, options.translate) });
  }
  hits.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return hits
    .slice(0, options.limit ?? SEARCH_ANYTHING_SETTINGS_LIMIT)
    .map(({ rank: _rank, ...entry }) => entry);
}

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
    ...GENERATED_SETTINGS_CATALOG,
    ...named('providers', 'providers', snapshot?.providers),
    ...named('skills', 'skills', snapshot?.skills),
    ...named('mcp', 'mcp', snapshot?.mcpServers),
    ...named('instructions', 'instructions', snapshot?.instructions),
    ...named('ssh', 'ssh', snapshot?.sshConnections),
  ];
}
