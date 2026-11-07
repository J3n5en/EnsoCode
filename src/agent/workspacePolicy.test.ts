import { describe, expect, it } from 'vitest';
import { WORKSPACE_POLICY_PROMPT } from './workspacePolicy';

describe('WORKSPACE_POLICY_PROMPT', () => {
  it('覆盖只读请求不改文件、最窄检查、保护用户改动与对外写入边界', () => {
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/do not change files unless they ask/);
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/narrowest relevant check/);
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/independent tool calls .* together in one response/);
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/untracked changes you did not make/);
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/do not grant permission to act outside/);
  });
});
