import { describe, expect, it } from 'vitest';
import { extractSettingsCatalog } from '../../scripts/settings-catalog/extract';
import { GENERATED_SETTINGS_CATALOG } from './settingsCatalog.generated';

describe('settings catalog', () => {
  it('与设置页源码一致；缺 rowId 或不一致时跑 pnpm settings:catalog', () => {
    const extracted = extractSettingsCatalog();
    expect(extracted.missing.map((row) => `${row.file}:${row.line} ${row.label}`)).toEqual([]);
    expect(extracted.entries).toEqual([...GENERATED_SETTINGS_CATALOG]);
  });
});
