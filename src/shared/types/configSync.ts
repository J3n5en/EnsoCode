export type ConfigSyncMode = 'merge' | 'replace';

export type ConfigSyncCategory =
  | 'providers'
  | 'presets'
  | 'agentTypes'
  | 'skills'
  | 'mcpServers'
  | 'instructions'
  | 'subagentModels'
  | 'settings';

export interface ConfigSyncSummary {
  category: ConfigSyncCategory;
  added: number;
  updated: number;
  skipped: number;
  removed?: number;
  /** 设置摘要仅列字段名，不包含值或凭证。 */
  fields?: string[];
}

export interface ConfigSyncExportOptions {
  includeSecrets: boolean;
  password?: string;
}

export const CONFIG_SYNC_SKIPPED_MODEL_LABELS = [
  'subagent model',
  'agent model',
  'defaultModel',
  'titleSummaryModel',
  'gitCommitModel',
  'imageGenerationModel',
  'memoryDistillModel',
  'smartCompactModel',
  'approvalReviewer',
] as const;

export type ConfigSyncSkippedModelLabel = (typeof CONFIG_SYNC_SKIPPED_MODEL_LABELS)[number];

/** 导出时解析不到的模型引用。列表条目带 id 并被整条跳过；标量设置只省略该字段。 */
export interface ConfigSyncSkippedModelReference {
  label: ConfigSyncSkippedModelLabel;
  providerId: string;
  modelId: string;
  reason: 'unknown-reference';
  id?: string;
}

export type ConfigSyncExportResult =
  | {
      ok: true;
      filePath: string;
      skippedInstructions?: string[];
      skippedModelReferences?: ConfigSyncSkippedModelReference[];
    }
  | { ok: false; error: string; cancelled?: boolean };

export type ConfigSyncOpenResult =
  | { ok: true; token: string; encrypted: boolean; fileName: string }
  | { ok: false; error: string; cancelled?: boolean };

export interface ConfigSyncPreviewOptions {
  token: string;
  password?: string;
  mode: ConfigSyncMode;
}

export type ConfigSyncPreviewResult =
  | {
      ok: true;
      summary: ConfigSyncSummary[];
      warnings: string[];
      mode: ConfigSyncMode;
    }
  | { ok: false; error: string; cancelled?: boolean };

export interface ConfigSyncCommitOptions {
  token: string;
  mode: ConfigSyncMode;
}

export type ConfigSyncCommitResult =
  | { ok: true; backupPath: string; warnings: string[] }
  | { ok: false; error: string; cancelled?: boolean };
