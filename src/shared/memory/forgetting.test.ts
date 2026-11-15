import { describe, expect, it } from 'vitest';
import { DEFAULT_FORGETTING_SETTINGS, normalizeForgettingSettings } from './forgetting';

describe('normalizeForgettingSettings', () => {
  it('缺省只开「降权」：不标记候选、不自动归档', () => {
    expect(normalizeForgettingSettings(undefined)).toEqual(DEFAULT_FORGETTING_SETTINGS);
    expect(DEFAULT_FORGETTING_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_FORGETTING_SETTINGS.archiveCandidates).toBe(false);
    expect(DEFAULT_FORGETTING_SETTINGS.autoArchive).toBe(false);
    expect(DEFAULT_FORGETTING_SETTINGS.staleDays).toBe(90);
    expect(DEFAULT_FORGETTING_SETTINGS.maxImportance).toBe(0.5);
    expect(DEFAULT_FORGETTING_SETTINGS.intervalDays).toBe(7);
  });

  it('读取设置键', () => {
    expect(
      normalizeForgettingSettings({
        memoryDecayEnabled: false,
        memoryDecayArchiveCandidates: true,
        memoryDecayAutoArchive: true,
        memoryDecayStaleDays: 30,
        memoryDecayMaxImportance: 0.3,
        memoryDecayIntervalDays: 1,
      })
    ).toEqual({
      enabled: false,
      archiveCandidates: true,
      autoArchive: true,
      staleDays: 30,
      maxImportance: 0.3,
      intervalDays: 1,
    });
  });

  it('脏值夹回范围，不抛错', () => {
    const s = normalizeForgettingSettings({
      memoryDecayStaleDays: 0,
      memoryDecayMaxImportance: 5,
      memoryDecayIntervalDays: 10_000,
    });
    expect(s.staleDays).toBe(7);
    expect(s.maxImportance).toBe(0.9);
    expect(s.intervalDays).toBe(90);
    expect(normalizeForgettingSettings({ memoryDecayStaleDays: 'soon' }).staleDays).toBe(90);
  });

  it('只认严格的 true：字符串 / 数字不能把归档打开', () => {
    const s = normalizeForgettingSettings({
      memoryDecayArchiveCandidates: 'yes',
      memoryDecayAutoArchive: 1,
    });
    expect(s.archiveCandidates).toBe(false);
    expect(s.autoArchive).toBe(false);
  });
});
