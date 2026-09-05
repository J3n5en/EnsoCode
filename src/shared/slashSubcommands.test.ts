import { describe, expect, it } from 'vitest';
import { filterSlashSubcommands, slashSubcommandQuery } from './slashSubcommands';

describe('slashSubcommandQuery', () => {
  it('is null without a selected slash chip', () => {
    expect(slashSubcommandQuery(null, 'view')).toBeNull();
  });

  it('uses the first token and hides after a second word', () => {
    expect(slashSubcommandQuery('/goal', '')).toBe('');
    expect(slashSubcommandQuery('/goal', 'pau')).toBe('pau');
    expect(slashSubcommandQuery('/goal', 'pause extra')).toBeNull();
  });
});

describe('filterSlashSubcommands', () => {
  it('移除记忆命令建议，保留目标子命令', () => {
    expect(filterSlashSubcommands('/memory', '')).toEqual([]);
    expect(filterSlashSubcommands('/memory', 're')).toEqual([]);
    expect(filterSlashSubcommands('/goal', 'p').map((row) => row.name)).toEqual(['pause']);
    expect(filterSlashSubcommands('/compact', '')).toEqual([]);
  });
});
