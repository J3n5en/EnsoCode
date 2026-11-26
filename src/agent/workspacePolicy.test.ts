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

  it('包含交付前用独立输入端到端验证的通用措辞', () => {
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/verify it end-to-end with inputs different/);
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/empty or minimal input/);
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/extreme or boundary value/);
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/format variant/);
    expect(WORKSPACE_POLICY_PROMPT).toMatch(/not proof of correctness/);
  });

  it('验证措辞不含评测指向（hidden test / score / grading）', () => {
    expect(WORKSPACE_POLICY_PROMPT).not.toMatch(/hidden test/i);
    expect(WORKSPACE_POLICY_PROMPT).not.toMatch(/score|grading|grader|evaluat/i);
  });
});
