import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countBoxesInSource } from './kit/boxes';

/**
 * 设置页内容渲染在主区那一层卡片里，页面代码再画任何带框容器就是卡片套卡片。
 * 迁到 kit/ 的页面一个都不许有；还没迁的列在白名单里，PR3 迁一页删一行。
 */
const LEGACY = new Set([
  // PR3b 模型与智能体组
  'AgentTypesSettings.tsx',
  'ApprovalReviewerPicker.tsx',
  'DefaultModelPicker.tsx',
  'ImageGenerationPicker.tsx',
  'InstructionEditDialog.tsx',
  'InstructionsSettings.tsx',
  'MemoryGraphView.tsx',
  'MemoryKnowledge.tsx',
  'MemoryLibrary.tsx',
  'MemorySettings.tsx',
  'MemoryTreeView.tsx',
  'OauthProvidersDialog.tsx',
  'PresetsSettings.tsx',
  'ProviderApiForm.tsx',
  'ProviderEditDialog.tsx',
  'ProviderModelRow.tsx',
  'ProviderSetupWizard.tsx',
  'ProvidersSettings.tsx',
  'SubagentModelsSettings.tsx',
  'TitleSummaryPicker.tsx',
  'VirtualModelsSettings.tsx',
  // PR3c 工具与扩展组
  // PR4 去掉独立窗口时（导航搜索框）
  'SettingsContent.tsx',
]);

const DIR = fileURLToPath(new URL('.', import.meta.url));

function pageSources(): { file: string; boxes: number }[] {
  const out: { file: string; boxes: number }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'kit') walk(path);
      } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
        out.push({
          file: relative(DIR, path),
          boxes: countBoxesInSource(readFileSync(path, 'utf8')),
        });
      }
    }
  };
  walk(DIR);
  return out;
}

describe('设置页不套卡片', () => {
  const pages = pageSources();

  it('白名单以外的页面没有带框容器', () => {
    const offenders = pages.filter((p) => !LEGACY.has(p.file) && p.boxes > 0);
    expect(offenders).toEqual([]);
  });

  it('白名单里的页面迁完要删掉对应条目', () => {
    const migrated = pages.filter((p) => LEGACY.has(p.file) && p.boxes === 0).map((p) => p.file);
    expect(migrated).toEqual([]);
    const known = new Set(pages.map((p) => p.file));
    expect([...LEGACY].filter((file) => !known.has(file))).toEqual([]);
  });

  it('已迁移的样板页在白名单之外', () => {
    expect(LEGACY.has('LogsSettings.tsx')).toBe(false);
    expect(LEGACY.has('KeybindingsSettings.tsx')).toBe(false);
  });
});
