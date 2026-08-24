import type { ModelApiKind, ModelEntry, ModelProvider } from './llm';

/** 支持扫描的本地应用 */
export const SCAN_APP_IDS = [
  'claude-code',
  'codex',
  'cc-switch',
  'alma',
  'cherry-studio',
  'hermes',
  'openclaw',
  'grok',
  'cursor',
] as const;
export type ScanAppId = (typeof SCAN_APP_IDS)[number];

export type ScanAppStatus = 'found' | 'not-found' | 'read-error';

export interface ScanAppReport {
  appId: ScanAppId;
  appName: string;
  status: ScanAppStatus;
  /** 展示用路径（~/ 或 %APPDATA% 形式） */
  configPath: string;
  candidateCount: number;
}

/** 扫描候选的脱敏预览（明文 apiKey 只留在主进程缓存中） */
export interface ScanCandidate {
  id: string;
  appId: ScanAppId;
  appName: string;
  name: string;
  api: ModelApiKind;
  apiKeyMasked: string;
  baseUrl: string;
  modelIds: string[];
  /** 与现有 provider 指纹（baseUrl+apiKey）重复 */
  duplicated: boolean;
}

export interface LocalProviderScanResult {
  scanId: string;
  apps: ScanAppReport[];
  candidates: ScanCandidate[];
}

/** 渲染层确认导入后，主进程返回完整 provider 数据 */
export interface CollectImportRequest {
  scanId: string;
  candidateIds: string[];
}

export type CollectedProvider = Omit<ModelProvider, 'id' | 'enabled'> & {
  candidateId: string;
  models: ModelEntry[];
};
