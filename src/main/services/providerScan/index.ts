import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type {
  CollectedProvider,
  LocalProviderScanResult,
  ScanAppId,
  ScanAppReport,
  ScanCandidate,
} from '@shared/types';
import { SCAN_APP_IDS } from '@shared/types';
import { readSettings } from '../../ipc/settings';
import { locateApp } from './locations';
import {
  type DiscoveredProvider,
  readAlma,
  readCcSwitch,
  readCherryStudio,
  readClaudeCode,
  readCodex,
  readCursor,
  readGrok,
  readHermes,
  readOpenClaw,
} from './readers';

const APP_NAMES: Record<ScanAppId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'cc-switch': 'CC Switch',
  alma: 'Alma',
  'cherry-studio': 'Cherry Studio',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  grok: 'Grok CLI',
  cursor: 'Cursor',
};

/** 明显的占位 key 不导入 */
const PLACEHOLDER_KEYS = new Set(['api-key', 'apikey', 'your-api-key', 'sk-xxx', 'xxx', 'test']);

const isUsableApiKey = (key: string): boolean => {
  const trimmed = key.trim();
  if (!trimmed || trimmed.includes('${') || trimmed.includes('{{')) return false;
  return !PLACEHOLDER_KEYS.has(trimmed.toLowerCase());
};

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url.trim());

const maskKey = (key: string): string => {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
};

const fingerprint = (baseUrl: string, apiKey: string): string =>
  `${baseUrl.trim().replace(/\/+$/, '')}::${apiKey.trim()}`;

/** 读取 settings.json 中已保存的 provider 指纹，用于标记重复候选 */
function existingFingerprints(): Set<string> {
  const settings = readSettings();
  const state = (settings?.['enso-settings'] as { state?: { providers?: unknown } } | undefined)
    ?.state;
  const providers = Array.isArray(state?.providers) ? state.providers : [];
  return new Set(
    providers
      .map((provider) => {
        const item = provider as { baseUrl?: string; apiKey?: string };
        return fingerprint(item.baseUrl ?? '', item.apiKey ?? '');
      })
      .filter((value) => value !== '::')
  );
}

async function readApp(appId: ScanAppId, filePath: string): Promise<DiscoveredProvider[]> {
  switch (appId) {
    case 'claude-code':
      return readClaudeCode(filePath);
    case 'codex':
      return readCodex(filePath);
    case 'cc-switch':
      return readCcSwitch(filePath);
    case 'alma':
      return readAlma(filePath);
    case 'cherry-studio':
      return readCherryStudio(filePath);
    case 'hermes':
      return readHermes(filePath);
    case 'openclaw':
      return readOpenClaw(filePath);
    case 'grok':
      return readGrok(filePath);
    case 'cursor':
      return readCursor(filePath);
  }
}

interface CachedCandidate {
  candidate: ScanCandidate;
  discovered: DiscoveredProvider;
}

// 仅保留最近一次扫描结果，供确认导入时取回明文数据
let lastScan: { scanId: string; byId: Map<string, CachedCandidate> } | null = null;

export async function scanLocalProviders(): Promise<LocalProviderScanResult> {
  const known = existingFingerprints();
  const scanId = randomUUID();
  const byId = new Map<string, CachedCandidate>();
  const apps: ScanAppReport[] = [];
  const candidates: ScanCandidate[] = [];

  for (const appId of SCAN_APP_IDS) {
    const { filePath, display } = locateApp(appId);
    const report: ScanAppReport = {
      appId,
      appName: APP_NAMES[appId],
      status: 'not-found',
      configPath: display,
      candidateCount: 0,
    };
    apps.push(report);

    if (!fs.existsSync(filePath)) continue;

    try {
      const discovered = await readApp(appId, filePath);
      const usable = discovered.filter(
        (provider) =>
          (isUsableApiKey(provider.apiKey) || provider.api === 'ollama') &&
          (provider.baseUrl === '' || isHttpUrl(provider.baseUrl))
      );

      report.status = 'found';
      report.candidateCount = usable.length;

      for (const provider of usable) {
        const candidate: ScanCandidate = {
          id: randomUUID(),
          appId,
          appName: APP_NAMES[appId],
          name: provider.name,
          api: provider.api,
          apiKeyMasked: maskKey(provider.apiKey),
          baseUrl: provider.baseUrl,
          modelIds: provider.models.map((model) => model.label || model.id),
          duplicated: known.has(fingerprint(provider.baseUrl, provider.apiKey)),
        };
        byId.set(candidate.id, { candidate, discovered: provider });
        candidates.push(candidate);
      }
    } catch (error) {
      console.warn(`[ProviderScan] Failed reading ${appId}:`, error);
      report.status = 'read-error';
    }
  }

  lastScan = { scanId, byId };
  return { scanId, apps, candidates };
}

export function collectImport(scanId: string, candidateIds: string[]): CollectedProvider[] {
  if (!lastScan || lastScan.scanId !== scanId) return [];

  // 同一批内按指纹去重
  const seen = new Set<string>();
  const collected: CollectedProvider[] = [];

  for (const candidateId of candidateIds) {
    const cached = lastScan.byId.get(candidateId);
    if (!cached) continue;
    const { discovered } = cached;
    const key = fingerprint(discovered.baseUrl, discovered.apiKey);
    if (key !== '::' && seen.has(key)) continue;
    seen.add(key);

    collected.push({
      candidateId,
      name: discovered.name,
      api: discovered.api,
      apiKey: discovered.apiKey,
      baseUrl: discovered.baseUrl,
      models: discovered.models,
      importedFrom: APP_NAMES[discovered.appId],
    });
  }

  return collected;
}
