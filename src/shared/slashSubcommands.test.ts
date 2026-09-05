import { describe, expect, it } from 'vitest';
import { filterSlashSubcommands, slashSubcommandQuery } from './slashSubcommands';

describe('slashSubcommandQuery', () => {
  it('is null without a selected slash chip', () => {
    expect(slashSubcommandQuery(null, 'view')).toBeNull();
  });

  it('uses the first token and hides after a second word', () => {
    expect(slashSubcommandQuery('/memory', '')).toBe('');
    expect(slashSubcommandQuery('/memory', 'vie')).toBe('vie');
    expect(slashSubcommandQuery('/memory', 'view extra')).toBeNull();
  });
});

describe('filterSlashSubcommands', () => {
  it('lists memory and goal verbs; aliases match the canonical name', () => {
    expect(filterSlashSubcommands('/memory', '').map((row) => row.name)).toEqual([
      'view',
      'stats',
      'diagnose',
      'clear',
      'enqueue',
    ]);
    expect(filterSlashSubcommands('/memory', 're').map((row) => row.name)).toEqual([
      'clear',
      'enqueue',
    ]);
    expect(filterSlashSubcommands('/goal', 'p').map((row) => row.name)).toEqual(['pause']);
    expect(filterSlashSubcommands('/compact', '')).toEqual([]);
  });
});
