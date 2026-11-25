import { describe, expect, it } from 'vitest';
import { extractSettingsCatalog } from '../../scripts/settings-catalog/extract';
import { GENERATED_SETTINGS_CATALOG } from './settingsCatalog.generated';

describe('settings catalog', () => {
  // 提取器要 AST 解析全部设置页 tsx，远超默认 5s
  it('与设置页源码一致；缺 rowId 或不一致时跑 pnpm settings:catalog', { timeout: 90_000 }, () => {
    const extracted = extractSettingsCatalog();
    const missingRowId = extracted.missing.filter((row) => row.kind !== 'dynamic');
    expect(missingRowId.map((row) => `${row.file}:${row.line} ${row.label}`)).toEqual([]);
    expect(extracted.entries).toEqual([...GENERATED_SETTINGS_CATALOG]);
  });
});
