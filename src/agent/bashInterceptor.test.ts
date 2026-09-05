import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { checkBashInterception, withBashInterception } from './bashInterceptor';

const tools = ['read', 'grep', 'edit', 'find'];

describe('checkBashInterception', () => {
  it('blocks cat / head / Get-Content and points at read', () => {
    for (const command of [
      'cat src/a.ts',
      'head -n 20 src/a.ts',
      'Get-Content src/a.ts',
      'gc src/a.ts',
    ]) {
      const result = checkBashInterception(command, tools);
      expect(result.block, command).toBe(true);
      expect(result.suggestedTool).toBe('read');
    }
  });

  it('blocks grep / rg / Select-String and points at grep', () => {
    for (const command of [
      'grep -n foo src',
      'rg foo src',
      'Select-String -Path src -Pattern foo',
      'sls foo',
    ]) {
      const result = checkBashInterception(command, tools);
      expect(result.block, command).toBe(true);
      expect(result.suggestedTool).toBe('grep');
    }
  });

  it('blocks in-place sed / perl / Set-Content and points at edit', () => {
    for (const command of [
      "sed -i 's/a/b/' file.ts",
      'perl -pi -e s/a/b/ file.ts',
      'Set-Content -Path file.ts -Value x',
    ]) {
      const result = checkBashInterception(command, tools);
      expect(result.block, command).toBe(true);
      expect(result.suggestedTool).toBe('edit');
    }
  });

  it('blocks later stages after && / ; but not a piped stdin consumer', () => {
    expect(checkBashInterception('echo hi && cat file.ts', tools).block).toBe(true);
    expect(checkBashInterception('printf x | cat', tools).block).toBe(false);
    expect(checkBashInterception('git show HEAD:file.ts', tools).block).toBe(false);
  });

  it('does not block when the suggested tool is unavailable', () => {
    expect(checkBashInterception('cat file.ts', ['bash']).block).toBe(false);
  });
});

describe('withBashInterception description', () => {
  it('appends a prefer-read hint so the model sees it before calling bash', () => {
    const wrapped = withBashInterception({
      name: 'bash',
      label: 'Bash',
      description: 'Run a shell command.',
      parameters: { type: 'object' },
      execute: async () => ({ content: [], details: {} }),
    } as unknown as ToolDefinition);
    expect(wrapped.description).toContain('Do not use cat/head/tail/less/more/grep/rg');
    expect(wrapped.description).toContain('Use the `read`, `grep`, `edit`, or `find` tools');
    expect(wrapped.description).toContain('Run a shell command.');
  });
});
