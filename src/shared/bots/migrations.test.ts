import { describe, expect, it } from 'vitest';
import { BOT_SCHEMA_VERSION, migrateRecord, runMigrations, withSchemaVersion } from './migrations';

describe('bot record migrations', () => {
  it('treats records without schemaVersion as the first schema', () => {
    expect(migrateRecord('bot', { id: 'x', version: 7 })).toEqual({ id: 'x', version: 7 });
    expect(migrateRecord('chat', { id: 'x', schemaVersion: BOT_SCHEMA_VERSION.chat })).toEqual({
      id: 'x',
      schemaVersion: BOT_SCHEMA_VERSION.chat,
    });
  });

  it('rejects records written by a newer schema or with a bad version', () => {
    for (const kind of ['bot', 'chat', 'routines', 'delegation', 'task'] as const) {
      expect(migrateRecord(kind, { schemaVersion: BOT_SCHEMA_VERSION[kind] + 1 })).toBeUndefined();
      expect(migrateRecord(kind, { schemaVersion: 0 })).toBeUndefined();
      expect(migrateRecord(kind, { schemaVersion: '1' })).toBeUndefined();
    }
    expect(migrateRecord('bot', null)).toBeNull();
    expect(migrateRecord('bot', 'text')).toBe('text');
  });

  it('runs each step in order from the stored version and stamps the current one', () => {
    const steps = [
      (value: Record<string, unknown>) => ({ ...value, renamed: value.old, old: undefined }),
      (value: Record<string, unknown>) => ({ ...value, added: true }),
    ];
    expect(runMigrations({ old: 'a' }, steps)).toEqual({
      old: undefined,
      renamed: 'a',
      added: true,
      schemaVersion: 3,
    });
    expect(runMigrations({ renamed: 'b', schemaVersion: 2 }, steps)).toEqual({
      renamed: 'b',
      added: true,
      schemaVersion: 3,
    });
    expect(runMigrations({ schemaVersion: 4 }, steps)).toBeUndefined();
  });

  it('stamps the current version without touching the optimistic version field', () => {
    expect(withSchemaVersion('delegation', { id: 'd', version: 3 })).toEqual({
      schemaVersion: BOT_SCHEMA_VERSION.delegation,
      id: 'd',
      version: 3,
    });
  });
});
