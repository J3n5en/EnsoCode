import { describe, expect, it } from 'vitest';
import { disabledToolsForRun, parseRunArgs, parseToolList } from './args';

describe('parseRunArgs', () => {
  it('rejects a run with neither prompt nor goal', () => {
    expect(parseRunArgs([])).toEqual({ ok: false, error: '需要 --prompt，或 --goal / --target' });
  });

  it('reads flags and lets them override env', () => {
    const parsed = parseRunArgs(
      ['--prompt', 'hello', '--model', 'from-flag', '--mode', 'auto-edits', '--cwd', '/work'],
      { ENSO_MODEL: 'from-env', ENSO_API_KEY: 'secret', OPENAI_BASE_URL: 'http://env/v1' },
      '/default'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args).toMatchObject({
      prompt: 'hello',
      modelId: 'from-flag',
      mode: 'auto-edits',
      cwd: '/work',
      apiKey: 'secret',
      baseUrl: 'http://env/v1',
      outputFormat: 'text',
      autoTurns: 25,
      continue: false,
    });
  });

  it('falls back through ENSO_ then vendor env names', () => {
    const parsed = parseRunArgs(['--goal', 'ship it'], {
      ANTHROPIC_API_KEY: 'ant',
      OPENAI_MODEL: 'gpt',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.apiKey).toBe('ant');
    expect(parsed.args.modelId).toBe('gpt');
    expect(parsed.args.goal).toBe('ship it');
  });

  it('rejects bad mode, duplicate flags, and conflicting resume', () => {
    expect(parseRunArgs(['--prompt', 'x', '--mode', 'yolo']).ok).toBe(false);
    expect(parseRunArgs(['--prompt', 'x', '--prompt', 'y']).ok).toBe(false);
    expect(parseRunArgs(['--prompt', 'x', '--resume', 'sess', '--continue']).ok).toBe(false);
    expect(parseRunArgs(['--goal', 'a', '--target', 'b']).ok).toBe(false);
    expect(parseRunArgs(['--prompt', 'x', '--auto-turns', '0']).ok).toBe(false);
    expect(parseRunArgs(['--prompt', 'x', '--api', 'nope']).ok).toBe(false);
    expect(parseRunArgs(['--nope']).ok).toBe(false);
  });

  it('treats a lone --help as help', () => {
    expect(parseRunArgs(['--help'])).toEqual({ ok: false, error: '', help: true });
  });

  it('canonicalizes tool lists and keeps an explicit deny over --allow-tools', () => {
    expect(parseToolList('Bash(git *), Web, imagegen')).toEqual([
      'bash',
      'web',
      'image_generation',
    ]);
    expect(disabledToolsForRun(['bash'], ['web'])).toEqual(
      expect.arrayContaining(['browser', 'image_generation', 'bash'])
    );
    expect(disabledToolsForRun(['bash'], ['web'])).not.toContain('web');
    expect(disabledToolsForRun(['web'], ['web'])).toContain('web');
  });
});
