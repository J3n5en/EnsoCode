import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CatalogEntry,
  HostAppearance,
  ProjectEntry,
  ProjectGroupEntry,
  ProviderEntry,
  TerminalPalette,
} from '@enso/pair';
import { app } from '@platform';
import { normalizeTimelinePrefs } from '@shared/pair/timelinePrefs';
import type { updatePairCatalog } from './pairHost';

export type PairCatalogSnapshot = Parameters<typeof updatePairCatalog>[0];

/** leader 渲染器推来的目录与磁盘快照共用同一套收窄 */
export function parsePairCatalogPayload(payload: unknown): PairCatalogSnapshot | null {
  const p = payload as {
    catalog?: CatalogEntry[];
    pinnedOrder?: string[];
    projects?: ProjectEntry[];
    projectGroups?: ProjectGroupEntry[];
    providers?: ProviderEntry[];
    providersSettled?: boolean;
    projectPaths?: { id: string; path: string }[];
    theme?: HostAppearance;
    terminal?: TerminalPalette;
    terminalFontFamily?: string;
    compactReadOnlyTools?: boolean;
    expandLiveEdits?: boolean;
    expandLiveReasoning?: boolean;
    autoCollapseTurns?: boolean;
    collapseCompletedActivity?: boolean;
    collapseLiveActivity?: boolean;
    pinUnfinishedTodos?: boolean;
  };
  if (!p || typeof p !== 'object') return null;
  return {
    catalog: Array.isArray(p.catalog) ? p.catalog : [],
    pinnedOrder: Array.isArray(p.pinnedOrder) ? p.pinnedOrder : [],
    projects: Array.isArray(p.projects) ? p.projects : [],
    projectGroups: Array.isArray(p.projectGroups) ? p.projectGroups : [],
    providers: Array.isArray(p.providers) ? p.providers : [],
    ...(p.providersSettled === false ? { providersSettled: false as const } : {}),
    projectPaths: Array.isArray(p.projectPaths) ? p.projectPaths : [],
    theme:
      p.theme === 'light' || p.theme === 'dark' || p.theme === 'sync-terminal' ? p.theme : 'system',
    ...(p.terminal ? { terminal: p.terminal } : {}),
    ...(typeof p.terminalFontFamily === 'string' && p.terminalFontFamily
      ? { terminalFontFamily: p.terminalFontFamily }
      : {}),
    compactReadOnlyTools: p.compactReadOnlyTools !== false,
    expandLiveEdits: p.expandLiveEdits !== false,
    ...normalizeTimelinePrefs(p),
  };
}

const snapshotPath = (): string => path.join(app.getPath('userData'), 'pair-catalog.json');

/** 无界面宿主重启后没有渲染器推目录：用上次的快照让手机端仍能看到项目与会话 */
export function loadPairCatalogSnapshot(): PairCatalogSnapshot | null {
  try {
    return parsePairCatalogPayload(JSON.parse(readFileSync(snapshotPath(), 'utf8')));
  } catch {
    return null;
  }
}

let pending: PairCatalogSnapshot | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function savePairCatalogSnapshot(snapshot: PairCatalogSnapshot): void {
  pending = snapshot;
  if (timer) return;
  timer = setTimeout(flushPairCatalogSnapshot, 500);
  timer.unref?.();
}

export function flushPairCatalogSnapshot(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending) return;
  const file = snapshotPath();
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(pending));
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.warn('[pair] save catalog snapshot failed', error);
  }
  pending = null;
}
