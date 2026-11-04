import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(join(tmpdir(), 'enso-system-prompts-'));

vi.mock('electron', () => ({ app: { getPath: () => userData } }));

import { deleteSystemPrompt, readSystemPrompt, writeSystemPrompt } from './systemPromptStore';

const id = '4aade2cb-d2a1-47c3-a4a2-848f28571a97';

afterAll(() => rmSync(userData, { recursive: true, force: true }));

describe('systemPromptStore', () => {
  it('仅允许 UUID 写入非空正文，并可按引用读删', async () => {
    expect(writeSystemPrompt('default', 'unsafe')).toMatchObject({ ok: false });
    expect(writeSystemPrompt('../escape', 'unsafe')).toMatchObject({ ok: false });
    expect(writeSystemPrompt(id, '   \n')).toMatchObject({ ok: false });

    expect(writeSystemPrompt(id, 'custom system prompt')).toEqual({ ok: true });
    expect(readFileSync(join(userData, 'system-prompts', `${id}.md`), 'utf8')).toBe(
      'custom system prompt'
    );
    await expect(readSystemPrompt(id)).resolves.toEqual({
      ok: true,
      content: 'custom system prompt',
    });

    expect(deleteSystemPrompt('default')).toMatchObject({ ok: false });
    expect(deleteSystemPrompt(id)).toEqual({ ok: true });
    expect(existsSync(join(userData, 'system-prompts', `${id}.md`))).toBe(false);
  });

  it('正文不存在时明确失败，不宣称自定义提示词已生效', async () => {
    await expect(readSystemPrompt('11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({
      ok: false,
      content: '',
    });
  });

  it('缺省只读取 pi 开头角色段落，不把工具规则作为可编辑正文', async () => {
    const result = await readSystemPrompt();
    expect(result.ok).toBe(true);
    expect(result.content).toBe(
      'You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.'
    );
  });
});
